/**
 * Observes builtin grep/glob/find/read in invocation order, never session history.
 * Tool call/result/completion hooks reserve and fill lightweight live slots. Terminal
 * agent_end settles main and automatic child replies; native child write/yield settle
 * explicit replies. Input and session transitions discard unfinished live windows.
 * agent_start/message_start/message_end/turn_end capture live assistant anchors;
 * agent_end must match them before touching slots, so stale completions cannot consume
 * a newer reply and cancelling before an assistant cannot reuse an old final.
 * Each report is a session custom entry; main gets one notification and children
 * deliver a displayable, model-visible custom message to the live root main.
 * Full/light, main/sub; no files, tool mutations, timers, or historical recovery.
 * Hook/delivery failures warn without blocking tools or replies.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { errorText } from "../_shared/errors.ts";
import { calculateCoverage, formatReport, type ReplyReport, type SourceObservation } from "./coverage.ts";
import { readIdentity, searchIdentity } from "./identity.ts";

type SourceTool = "grep" | "glob" | "find" | "read";
type Completion<T> = { kind: "pending" } | { kind: "success"; value: T } | { kind: "failed" } | { kind: "unknown"; reason: string };
type Slot =
	| { kind: "source"; id: string; tool: SourceTool; cwd: string; result: Completion<SourceObservation> }
	| { kind: "boundary"; id: string; replyKind: "irc" | "yield"; result: Completion<null> };
type AssistantStart = Pick<AssistantMessage, "timestamp" | "provider" | "model" | "responseId">;
type AssistantAnchor = {
	timestamp: number;
	provider: string;
	model: string;
	stopReason: AssistantMessage["stopReason"];
} & ({ kind: "response"; responseId: string } | { kind: "completion"; completedAt: number });

interface LiveState {
	slots: Slot[];
	pending: Map<string, Slot>;
	observations: SourceObservation[];
	started: AssistantStart | undefined;
	assistant: AssistantAnchor | undefined;
}
const phaseSchema = z.object({ v: z.literal(1), phase: z.enum(["commentary", "final_answer"]) });
const ircSchema = z.object({
	message: z.object({
		op: z.literal("send"),
		receipts: z.array(z.object({ outcome: z.string() })),
	}),
});
const yieldSchema = z.object({ status: z.literal("success") });

function successfulSettle(message: AssistantMessage): boolean {
	if (message.stopReason !== "stop" || message.content.some((block) => block.type === "toolCall")) {
		return false;
	}
	let phased = false;
	let finalText = "";
	let fallbackText = "";
	for (const block of message.content) {
		if (block.type !== "text") continue;
		fallbackText += block.text;
		if (typeof block.textSignature !== "string") continue;
		let signature: unknown;
		try {
			signature = JSON.parse(block.textSignature);
		} catch {
			// Provider signatures need not be JSON or carry a Responses phase.
			continue;
		}
		const parsed = phaseSchema.safeParse(signature);
		if (!parsed.success) continue;
		phased = true;
		if (parsed.data.phase === "final_answer") finalText += block.text;
	}
	return (phased ? finalText : fallbackText).trim().length > 0;
}

function warn(pi: ExtensionAPI, message: string, error: unknown): void {
	try {
		pi.logger.warn(`response-reading-coverage: ${message}`, { error: errorText(error) });
	} catch {
		// A logger failure must not escape an observational hook.
	}
}

async function publish(pi: ExtensionAPI, reports: readonly ReplyReport[], ctx: ExtensionContext): Promise<void> {
	// Record every consumed window before any async cross-session delivery.
	for (const value of reports) {
		try {
			pi.appendEntry("response-reading-coverage", value);
		} catch (error) {
			warn(pi, "report recording failed", error);
		}
	}
	for (const value of reports) {
		const text = formatReport(value);
		if (ctx.agent.kind === "main") {
			try {
				ctx.ui.notify(text, "info");
			} catch (error) {
				warn(pi, "report notification failed", error);
			}
			continue;
		}
		try {
			const main = AgentRegistry.global().get(MAIN_AGENT_ID)?.session;
			if (main == null) {
				warn(pi, "main report delivery failed", "live root main session unavailable");
				continue;
			}
			await main.sendCustomMessage(
				{ customType: "response-reading-coverage", content: text, details: value, display: true, attribution: "agent" },
				{ triggerTurn: false },
			);
		} catch (error) {
			warn(pi, "main report delivery failed", error);
		}
	}
}

function stateKey(ctx: ExtensionContext): string {
	return `${ctx.sessionManager.getSessionId()}\0${ctx.agent.id}`;
}

function stateFor(states: Map<string, LiveState>, ctx: ExtensionContext): LiveState {
	const id = stateKey(ctx);
	let state = states.get(id);
	if (state === undefined) {
		state = { slots: [], pending: new Map(), observations: [], started: undefined, assistant: undefined };
		states.set(id, state);
	}
	return state;
}

function completionAnchor(message: AssistantMessage): AssistantAnchor | undefined {
	const common = { timestamp: message.timestamp, provider: message.provider, model: message.model, stopReason: message.stopReason };
	if (message.responseId !== undefined && message.responseId.length > 0) {
		return { ...common, kind: "response", responseId: message.responseId };
	}
	if (message.completedAt !== undefined) return { ...common, kind: "completion", completedAt: message.completedAt };
	return undefined;
}

function matchesCompletion(anchor: AssistantAnchor, message: AssistantMessage): boolean {
	if (
		anchor.timestamp !== message.timestamp ||
		anchor.provider !== message.provider ||
		anchor.model !== message.model ||
		anchor.stopReason !== message.stopReason
	)
		return false;
	switch (anchor.kind) {
		case "response":
			return anchor.responseId === message.responseId;
		case "completion":
			return !message.responseId && anchor.completedAt === message.completedAt;
		default: {
			const unreachable: never = anchor;
			return unreachable;
		}
	}
}

function matchesStart(started: AssistantStart, message: AssistantMessage): boolean {
	return (
		started.timestamp === message.timestamp &&
		started.provider === message.provider &&
		started.model === message.model &&
		(!started.responseId || started.responseId === message.responseId)
	);
}

function registerCompletions(pi: ExtensionAPI, states: Map<string, LiveState>): void {
	pi.on("agent_start", (_event, ctx) => {
		try {
			const state = stateFor(states, ctx);
			state.started = undefined;
			state.assistant = undefined;
		} catch (error) {
			warn(pi, "agent_start observation failed", error);
		}
	});
	pi.on("message_start", (event, ctx) => {
		try {
			if (event.message.role !== "assistant") return;
			const state = stateFor(states, ctx);
			state.started = {
				timestamp: event.message.timestamp,
				provider: event.message.provider,
				model: event.message.model,
				responseId: event.message.responseId,
			};
			state.assistant = undefined;
		} catch (error) {
			warn(pi, "assistant start observation failed", error);
		}
	});
	pi.on("message_end", (event, ctx) => {
		try {
			if (event.message.role !== "assistant") return;
			const state = states.get(stateKey(ctx));
			if (state?.started === undefined || !matchesStart(state.started, event.message)) return;
			state.assistant = completionAnchor(event.message);
			if (state.assistant?.kind === "response") state.started.responseId = state.assistant.responseId;
		} catch (error) {
			warn(pi, "assistant completion observation failed", error);
		}
	});
	pi.on("turn_end", (event, ctx) => {
		try {
			if (event.message.role !== "assistant") return;
			const state = states.get(stateKey(ctx));
			if (state?.started === undefined || !matchesStart(state.started, event.message)) return;
			const anchor = completionAnchor(event.message);
			// turn_end carries the completed provider response even when an earlier
			// message_end observer is still awaiting IO. Its raw message need not
			// have the session's completedAt stamp, so only its provider ID can anchor it.
			if (anchor?.kind === "response") {
				state.assistant = anchor;
				state.started.responseId = anchor.responseId;
			}
		} catch (error) {
			warn(pi, "turn completion observation failed", error);
		}
	});
}

export default function responseReadingCoverage(pi: ExtensionAPI): void {
	const states = new Map<string, LiveState>();
	let replySequence = 0;
	const report = (state: LiveState, ctx: ExtensionContext, replyKind: ReplyReport["replyKind"]): ReplyReport => {
		const calculated = calculateCoverage(state.observations);
		state.observations = [];
		return { ...calculated, agentId: ctx.agent.id, agentName: ctx.agent.name, replyKind, replySequence: ++replySequence };
	};
	const drain = (state: LiveState, ctx: ExtensionContext): ReplyReport[] => {
		const reports: ReplyReport[] = [];
		let consumed = 0;
		for (const slot of state.slots) {
			if (slot.result.kind === "pending") break;
			consumed++;
			state.pending.delete(slot.id);
			if (slot.kind === "boundary") {
				if (slot.result.kind === "success") reports.push(report(state, ctx, slot.replyKind));
				continue;
			}
			const kind = slot.tool === "read" ? "read" : "search";
			switch (slot.result.kind) {
				case "success":
					state.observations.push(slot.result.value);
					break;
				case "failed":
					state.observations.push({ kind, result: { kind: "failed" } });
					break;
				case "unknown":
					state.observations.push({ kind, result: { kind: "unknown", reason: slot.result.reason } });
					break;
				default: {
					const unreachable: never = slot.result;
					return unreachable;
				}
			}
		}
		state.slots.splice(0, consumed);
		return reports;
	};
	registerCompletions(pi, states);

	pi.on("tool_call", (event, ctx) => {
		try {
			const tool = event.toolName;
			if (tool !== "grep" && tool !== "glob" && tool !== "find" && tool !== "read" && tool !== "write" && tool !== "yield") return;
			if (pi.getAllTools().find((item) => item.name === tool)?.sourceInfo.source !== "builtin") return;
			if ((tool === "write" || tool === "yield") && ctx.agent.kind !== "sub") return;
			const state = stateFor(states, ctx);
			const slot: Slot =
				tool === "write" || tool === "yield"
					? { kind: "boundary", id: event.toolCallId, replyKind: tool === "write" ? "irc" : "yield", result: { kind: "pending" } }
					: { kind: "source", id: event.toolCallId, tool, cwd: ctx.cwd, result: { kind: "pending" } };
			state.slots.push(slot);
			state.pending.set(slot.id, slot);
		} catch (error) {
			warn(pi, "tool_call observation failed", error);
		}
	});
	pi.on("tool_result", async (event, ctx) => {
		try {
			const state = states.get(stateKey(ctx));
			const slot = state?.pending.get(event.toolCallId);
			if (state === undefined || slot === undefined || slot.result.kind !== "pending") return;
			if (event.isError === true) slot.result = { kind: "failed" };
			else if (event.isError !== false) slot.result = { kind: "unknown", reason: "tool success unconfirmed" };
			else if (slot.kind === "source") {
				const result =
					slot.tool === "read"
						? typeof event.input.path === "string"
							? readIdentity(event.details, event.input.path, slot.cwd)
							: { kind: "unknown" as const, reason: "executed read input missing" }
						: searchIdentity(slot.tool, event.details, slot.cwd);
				slot.result = { kind: "success", value: { kind: slot.tool === "read" ? "read" : "search", result } };
			} else {
				const receipt = ircSchema.safeParse(event.details);
				const path = event.input.path;
				const sent =
					typeof path === "string" &&
					/^agent:\/\/[^/?#]+$/.test(path) &&
					receipt.success &&
					receipt.data.message.receipts.some(
						(item) => item.outcome === "injected" || item.outcome === "woken" || item.outcome === "revived",
					);
				const success = slot.replyKind === "yield" ? yieldSchema.safeParse(event.details).success : sent;
				slot.result = success ? { kind: "success", value: null } : { kind: "failed" };
			}
			await publish(pi, drain(state, ctx), ctx);
		} catch (error) {
			warn(pi, "tool_result observation failed", error);
		}
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		try {
			if (event.isError !== true) return;
			const state = states.get(stateKey(ctx));
			const slot = state?.pending.get(event.toolCallId);
			if (state === undefined || slot === undefined || slot.result.kind !== "pending") return;
			slot.result = { kind: "failed" };
			await publish(pi, drain(state, ctx), ctx);
		} catch (error) {
			warn(pi, "failed completion observation failed", error);
		}
	});
	pi.on("agent_end", async (event, ctx) => {
		try {
			if (event.willContinue === true) return;
			const state = states.get(stateKey(ctx));
			const message = event.messages.findLast((item) => item.role === "assistant");
			if (
				state?.assistant === undefined ||
				state.started === undefined ||
				message?.role !== "assistant" ||
				!matchesStart(state.started, message) ||
				!matchesCompletion(state.assistant, message)
			)
				return;
			state.assistant = undefined;
			state.started = undefined;
			for (const slot of state.slots) {
				if (slot.result.kind === "pending") slot.result = { kind: "unknown", reason: "tool result missing at terminal settle" };
			}
			const reports = drain(state, ctx);
			if (successfulSettle(message)) {
				if (ctx.agent.kind === "main") reports.push(report(state, ctx, "main"));
				else if (state.observations.length > 0) reports.push(report(state, ctx, "irc-auto"));
			}
			await publish(pi, reports, ctx);
		} catch (error) {
			warn(pi, "agent_end observation failed", error);
		}
	});
	pi.on("input", (event, ctx) => {
		try {
			if (event.source === "interactive" || event.source === "rpc") states.delete(stateKey(ctx));
		} catch (error) {
			warn(pi, "input reset failed", error);
		}
	});
	pi.on("session_start", () => states.clear());
	pi.on("session_switch", () => states.clear());
	pi.on("session_branch", () => states.clear());
	pi.on("session_tree", () => states.clear());
	pi.on("session_shutdown", () => states.clear());
}

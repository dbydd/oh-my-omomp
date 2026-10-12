/**
 * Watches main-session shell commands and eval code for operations the built-in
 * tools APPEND_SYSTEM.md assigns to the model: list, read, search, edit, write
 * and eval. `tool-policy-nag.json` (cwd copy first, then the one beside this
 * file) picks the detector, re-read at every watched call:
 *
 * - `{"detector": "heuristic"}` (also when no valid config exists): a command
 *   parser plus regexes. Ignoring the system prompt is one failure: after the
 *   first three hits, send at most three generic steer nags per context, then
 *   go quiet until a boundary that replaces the context (compaction, /clear,
 *   branch summary). Branch or tree navigation rebuilds the target branch's own
 *   state; it does not reset it.
 * - `{"detector": "jev", "judge": "<provider>/<model>", "threshold": 0.5}`:
 *   every watched call goes to a judgment-API model (Jev) as one request with
 *   one independent yes/no question per policy rule (SHELL_RULES / EVAL_RULES).
 *   Each call with a rule at or above `threshold` gets its own message listing
 *   every violated rule and the required tool; no counting, no cap. The verdict
 *   arrives after the call started, so the nag is an aside (a new turn when the
 *   session is already idle); a verdict that returns after a session move is
 *   only shown. A failed judge request warns once per reason and nags nothing;
 *   the heuristic is never a fallback.
 * Registers session lifecycle and tool_call hooks; appends counter entries to
 * the session branch and injects attributed user nags. Main sessions only.
 * Hook failures are logged and do not escape into omp.
 */
import { type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { type WatchedCall, watchedCallOf } from "./calls.ts";
import { type JevDetector, loadDetector } from "./detector-config.ts";
import { detectEvalViolations, detectShellViolations } from "./heuristic.ts";
import { EVAL_RULES, type Flagged, jevNagText, judgeCall, SHELL_RULES } from "./jev.ts";

const NAG_TEXT = "你为什么不遵守system prompt。";
const STATE_ENTRY_TYPE = "mouriya.omp.tool-policy-nag.state";
/** Fire on the hit that goes *past* three. */
const HIT_THRESHOLD = 3;
const MAX_NAGS_PER_CONTEXT = 3;

type NagState =
	| { readonly kind: "watching"; readonly hits: number; readonly nagsSent: number }
	| { readonly kind: "exhausted"; readonly hits: number; readonly nagsSent: number };

const WATCHING: NagState = { kind: "watching", hits: 0, nagsSent: 0 };

const stateSchema = z.object({
	kind: z.enum(["watching", "exhausted"]),
	hits: z
		.number()
		.refine(Number.isFinite)
		.transform((value) => Math.max(0, Math.trunc(value))),
	nagsSent: z
		.number()
		.refine(Number.isFinite)
		.transform((value) => Math.max(0, Math.trunc(value))),
});

function parseState(data: unknown): NagState | null {
	const parsed = stateSchema.safeParse(data);
	if (!parsed.success) return null;
	const { kind, hits, nagsSent } = parsed.data;
	return kind === "watching" ? { kind, hits, nagsSent } : { kind, hits, nagsSent };
}

/**
 * Rebuilds the counter from the session branch so a resumed process keeps its
 * word: a boundary that replaces the model's context (compaction, `/clear`,
 * a branch summary) discards every hit recorded before it.
 */
function rebuildState(ctx: ExtensionContext): NagState {
	let state: NagState = WATCHING;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "compaction" || entry.type === "reset_boundary" || entry.type === "branch_summary") {
			state = WATCHING;
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
		const parsed = parseState(entry.data);
		if (parsed !== null) state = parsed;
	}
	return state;
}

function heuristicCheck(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	call: WatchedCall,
	state: NagState,
	commit: (next: NagState) => void,
): void {
	if (state.kind === "exhausted") return;
	const violations = call.kind === "shell" ? detectShellViolations(call.command) : detectEvalViolations(call.language, call.code);
	if (violations.length === 0) return;

	// Every offending command counts, so four `cat`s batched into one bash
	// call are four hits rather than one.
	const hits = state.hits + violations.length;
	const programs = violations.map((violation) => `${violation.program} ${violation.target}`);
	const violationDetails = violations.map(({ categories, program, target }) => ({ categories, program, target }));
	if (hits <= HIT_THRESHOLD) {
		pi.logger.info("Tool-policy violation observed", {
			hits,
			threshold: HIT_THRESHOLD,
			programs,
			violations: violationDetails,
			nagNumber: state.nagsSent,
			nagsSent: state.nagsSent,
			maxNags: MAX_NAGS_PER_CONTEXT,
			detectorArmed: true,
		});
		commit({ kind: "watching", hits, nagsSent: state.nagsSent });
		return;
	}
	if (state.nagsSent >= MAX_NAGS_PER_CONTEXT) {
		commit({ kind: "exhausted", hits, nagsSent: state.nagsSent });
		return;
	}
	const nagsSent = state.nagsSent + 1;
	const detectorArmed = nagsSent < MAX_NAGS_PER_CONTEXT;
	pi.logger.warn("Tool-policy violation past threshold — nagging", {
		hits,
		programs,
		violations: violationDetails,
		nagNumber: nagsSent,
		nagsSent,
		maxNags: MAX_NAGS_PER_CONTEXT,
		detectorArmed,
	});
	commit(detectorArmed ? { kind: "watching", hits, nagsSent } : { kind: "exhausted", hits, nagsSent });
	pi.sendUserMessage(NAG_TEXT, { deliverAs: "steer", attribution: "agent" });
	ctx.ui.notify(
		`Shell policy nag ${nagsSent}/${MAX_NAGS_PER_CONTEXT} sent for hit #${hits} (${programs.join(", ")}) — detector ${
			detectorArmed ? "still armed" : "exhausted until compaction"
		}`,
		"warning",
	);
}
function runForMainSession(pi: ExtensionAPI, ctx: ExtensionContext, handler: () => void): void {
	if (ctx.agent.kind !== "main") return;
	try {
		handler();
	} catch (error) {
		pi.logger.warn("Tool-policy nag hook failed", { error: errorText(error) });
	}
}

export default function toolPolicyNag(pi: ExtensionAPI): void {
	let state: NagState = WATCHING;
	const nestedDeviceCalls = new Set<string>();
	/** Bumped by every session move; a Jev verdict from an older epoch is shown, never sent. */
	let epoch = 0;
	/** Config and judge failures already reported, so a broken setup warns once per process. */
	const warned = new Set<string>();

	const commit = (next: NagState): void => {
		state = next;
		pi.appendEntry(STATE_ENTRY_TYPE, next);
	};

	const rearm = (reason: string): void => {
		if (state.kind === "watching" && state.hits === 0 && state.nagsSent === 0) return;
		pi.logger.info("Tool-policy nag re-armed", { reason, previous: state });
		commit(WATCHING);
	};

	const restore = (reason: string, ctx: ExtensionContext): void => {
		epoch += 1;
		state = rebuildState(ctx);
		pi.logger.info("Tool-policy nag state restored", { reason, state });
	};

	const warnOnce = (ctx: ExtensionContext, text: string): void => {
		if (warned.has(text)) return;
		warned.add(text);
		pi.logger.warn(text);
		if (ctx.hasUI) ctx.ui.notify(text, "warning");
	};

	/** Runs beside the tool call; the verdict lands after it, so the nag goes out as an aside. */
	const jevCheck = async (ctx: ExtensionContext, detector: JevDetector, call: WatchedCall): Promise<void> => {
		const startedAt = epoch;
		const rules = call.kind === "shell" ? SHELL_RULES : EVAL_RULES;
		const result = await judgeCall(ctx, detector, call, rules);
		switch (result.kind) {
			case "failed":
				warnOnce(ctx, `tool-policy-nag: Jev 判断失败（${result.reason}）`);
				return;
			case "ok":
				break;
			default: {
				const unreachable: never = result;
				return unreachable;
			}
		}
		const tool = call.kind === "shell" ? call.tool : "eval";
		const flagged: Flagged[] = [];
		for (const rule of rules) {
			const probability = result.probabilities[rule.id] ?? 0;
			if (probability >= detector.threshold) flagged.push({ rule, probability });
		}
		pi.logger.info("Tool-policy Jev verdict", {
			tool,
			threshold: detector.threshold,
			probabilities: result.probabilities,
			flagged: flagged.map(({ rule }) => rule.id),
		});
		if (flagged.length === 0) return;
		const summary = `tool-policy-nag Jev：${tool} 违规 ${flagged.map(({ rule, probability }) => `${rule.id} ${probability.toFixed(2)}`).join(" · ")}`;
		if (epoch !== startedAt) {
			if (ctx.hasUI) ctx.ui.notify(`${summary}；判断返回前会话已切换，未发送提醒`, "info");
			return;
		}
		pi.sendUserMessage(jevNagText(call, flagged), ctx.isIdle() ? { attribution: "agent" } : { deliverAs: "aside", attribution: "agent" });
		if (ctx.hasUI) ctx.ui.notify(summary, "warning");
	};

	pi.on("session_start", (_event, ctx) => runForMainSession(pi, ctx, () => restore("session_start", ctx)));
	pi.on("session_switch", (_event, ctx) => runForMainSession(pi, ctx, () => restore("session_switch", ctx)));
	pi.on("session_branch", (_event, ctx) => runForMainSession(pi, ctx, () => restore("session_branch", ctx)));
	pi.on("session_tree", (_event, ctx) => runForMainSession(pi, ctx, () => restore("session_tree", ctx)));
	pi.on("session_compact", (_event, ctx) => runForMainSession(pi, ctx, () => rearm("session_compact")));
	pi.on("auto_compaction_end", (event, ctx) =>
		runForMainSession(pi, ctx, () => {
			if (event.aborted || event.skipped === true || event.result === undefined) return;
			rearm(`auto_compaction_end:${event.action}`);
		}),
	);

	pi.on("tool_call", (event, ctx) =>
		runForMainSession(pi, ctx, () => {
			if (event.toolName !== "write" && nestedDeviceCalls.delete(event.toolCallId)) return;
			const call = watchedCallOf(event.toolName, event.input);
			if (call === null) return;
			// The device re-dispatches its payload as a nested tool call with the same id.
			if (event.toolName === "write") nestedDeviceCalls.add(event.toolCallId);
			const { detector, warnings } = loadDetector(ctx.cwd);
			for (const warning of warnings) warnOnce(ctx, warning);
			switch (detector.kind) {
				case "heuristic":
					heuristicCheck(pi, ctx, call, state, commit);
					return;
				case "jev":
					void jevCheck(ctx, detector, call).catch((error) => {
						pi.logger.warn("Tool-policy nag hook failed", { error: errorText(error) });
					});
					return;
				default: {
					const unreachable: never = detector;
					return unreachable;
				}
			}
		}),
	);
}

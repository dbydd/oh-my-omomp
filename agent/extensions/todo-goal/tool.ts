import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type ExtensionAPI, z } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoPhase, TodoToolDetails } from "@oh-my-pi/pi-tui/tools/todo";
import {
	currentTodoGoal,
	explanationOf,
	goalLines,
	type ItemExplanation,
	itemSchema,
	TODO_GOAL_ENTRY_TYPE,
	type TodoGoal,
	type TodoGoalSnapshot,
	type TodoGoalState,
	todoGoalSchema,
} from "../_shared/todo-goal.ts";

export const DESCRIPTION = `Tasks identified by verbatim title, NEVER generated IDs (task-1). Unique, stable titles/phase names; lost text: view, NEVER guess.
Every item is {title, explanation}: title is the short name later ops target as \`task\`; explanation says what the item covers and what shows it is finished.
\`goal\` is {objective, measure, doneWhen}: what this work is, how its result is measured, how far it must go to count as done. REQUIRED on init and whenever the list has none; any later mutation may carry a new goal that replaces it; NEVER on view.
Before work, init for 3+ steps, requested task sets, or new instructions. MUST list EVERY user item separately (phased/numbered/bulleted/N); NEVER omit or remember leftovers.
After successful mutation: no active means earliest pending starts (phase order); multiple active means only earliest stays. Blocked NEVER starts automatically; unblock returns pending. Done out of order may rewind pointer but NEVER reopen completed. Mark done immediately; follow phase order.
External waits (user/agent/service): block with optional reason suppresses stop reminder, starts next pending. Unblock when actionable; append a clearing task for agent-actionable blocker.
NEVER call todo alone: init with first work; done/start with next action.`;

const OPS = ["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"] as const;
type Op = (typeof OPS)[number];

const goalParam = z
	.object({
		objective: z.string().describe("what this work is"),
		measure: z.string().describe("how the result is measured"),
		doneWhen: z.string().describe("how far the work must go to count as done"),
	})
	.describe("required on init and whenever the list has none; replaces the goal on other mutations");

const itemParam = z.object({
	title: z.string().describe("short stable name; the `task` value of later ops"),
	explanation: z.string().describe("what the item covers and what shows it is finished"),
});

const fields = {
	goal: goalParam.optional(),
	list: z
		.array(z.object({ phase: z.string(), items: z.array(itemParam).min(1) }))
		.optional()
		.describe("phases for init"),
	task: z.string().optional().describe("verbatim task title"),
	phase: z.string().optional(),
	items: z.array(itemParam).optional().describe("tasks for flat init or append"),
	reason: z.string().optional().describe("blocker note for block"),
};

/** The schema the model sees. */
export const parametersSchema = z.object({ op: z.enum(OPS), ...fields });

/** What execute accepts: the tool sets `lenientArgValidation`, so a call without `op` arrives raw. */
const inputSchema = z.object({ op: z.enum(OPS).optional(), ...fields });
type Input = z.infer<typeof inputSchema>;
type Params = Input & { readonly op: Op };

type Item = z.infer<typeof itemParam>;

/** The native tool's arguments: the same ops, with items reduced to their titles. */
type NativeParams = {
	op: Op;
	list?: { phase: string; items: string[] }[];
	task?: string;
	phase?: string;
	items?: string[];
	reason?: string;
};

type Parsed = { readonly kind: "ok"; readonly params: Params } | { readonly kind: "invalid"; readonly message: string };

/**
 * The native tool's repair of a missing `op` (`tools/todo.ts`, `inferTodoOp`):
 * `list` means init; `items` with `phase` means append; bare `items` means
 * init only while no list exists. Anything else stays an error.
 */
function inferOp(input: Input, hasPhases: boolean): Op | undefined {
	if (input.list !== undefined && input.list.length > 0) return "init";
	if (input.items !== undefined && input.items.length > 0) {
		if (input.phase) return "append";
		if (!hasPhases) return "init";
	}
	return undefined;
}

function parseParams(raw: unknown, hasPhases: boolean): Parsed {
	const parsed = inputSchema.safeParse(raw);
	if (!parsed.success) return { kind: "invalid", message: `Invalid todo arguments: ${parsed.error.message}` };
	const op = parsed.data.op ?? inferOp(parsed.data, hasPhases);
	if (op === undefined) return { kind: "invalid", message: "Invalid todo arguments: op must be provided" };
	return { kind: "ok", params: { ...parsed.data, op } };
}

/** Items this call adds, from `list` (init) or `items` (flat init, append). */
function newItems(params: Params): Item[] {
	switch (params.op) {
		case "init":
			return params.list?.flatMap((phase) => phase.items) ?? params.items ?? [];
		case "append":
			return params.items ?? [];
		case "start":
		case "done":
		case "rm":
		case "drop":
		case "block":
		case "unblock":
		case "view":
			return [];
		default: {
			const unreachable: never = params.op;
			throw new Error(`Unexpected todo operation: ${String(unreachable)}`);
		}
	}
}

/** The wrapper's own rules on top of the native ones; native errors still come from the native tool. */
function ruleErrors(params: Params, previous: TodoGoalState): string[] {
	const errors: string[] = [];
	if (params.op === "view") {
		if (params.goal !== undefined) errors.push("goal cannot be set on view");
	} else if (params.goal === undefined && (params.op === "init" || previous.kind === "none")) {
		errors.push(params.op === "init" ? "init requires goal" : "the list has no goal: pass goal with this call");
	}
	if (params.goal !== undefined && !todoGoalSchema.safeParse(params.goal).success) {
		errors.push("goal objective, measure and doneWhen must not be empty");
	}
	for (const item of newItems(params)) {
		if (!itemSchema.safeParse(item).success) errors.push(`Task "${item.title}" needs a non-empty title and explanation`);
	}
	return errors;
}

function nativeParams(params: Params): NativeParams {
	const titles = (items: readonly Item[]): string[] => items.map((item) => item.title);
	const out: NativeParams = { op: params.op };
	if (params.list !== undefined) out.list = params.list.map((phase) => ({ phase: phase.phase, items: titles(phase.items) }));
	if (params.items !== undefined) out.items = titles(params.items);
	if (params.task !== undefined) out.task = params.task;
	if (params.phase !== undefined) out.phase = params.phase;
	if (params.reason !== undefined) out.reason = params.reason;
	return out;
}

/** The snapshot after a successful mutation: explanations of the titles still on the list. */
function nextSnapshot(params: Params, previous: TodoGoalState, goal: TodoGoal, phases: readonly TodoPhase[]): TodoGoalSnapshot {
	const added = new Map(newItems(params).map((item) => [item.title, item.explanation]));
	const items: ItemExplanation[] = [];
	for (const task of phases.flatMap((phase) => phase.tasks)) {
		const explanation = added.get(task.content) ?? (params.op === "init" ? undefined : explanationOf(previous, task.content));
		if (explanation !== undefined) items.push({ title: task.content, explanation });
	}
	return { goal, items };
}

const sameSnapshot = (state: TodoGoalState, snapshot: TodoGoalSnapshot): boolean =>
	state.kind === "set" && Bun.deepEquals({ goal: state.goal, items: state.items }, snapshot);

/** Goal block, the native summary, then the explanations of every open item. */
function resultText(nativeText: string, state: TodoGoalState, phases: readonly TodoPhase[]): string {
	if (state.kind === "none") return nativeText;
	const open = phases.flatMap((phase) =>
		phase.tasks.filter((task) => task.status === "pending" || task.status === "in_progress" || task.status === "blocked"),
	);
	const lines = ["Goal:", ...goalLines(state.goal).map((line) => `  ${line}`), nativeText];
	if (open.length > 0) {
		lines.push("Open item explanations:");
		for (const task of open) lines.push(`  - ${task.content}: ${explanationOf(state, task.content) ?? "(no explanation)"}`);
	}
	return lines.join("\n");
}

const textOfResult = (result: AgentToolResult<TodoToolDetails>): string =>
	result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

/**
 * Native details plus a display copy of the goal state as of this call, for
 * the renderer. State readers use the session entries, never this copy.
 */
export type TodoGoalToolDetails = TodoToolDetails & { goal?: TodoGoal; explanations?: readonly ItemExplanation[] };

function withGoal(result: AgentToolResult<TodoToolDetails>, state: TodoGoalState): AgentToolResult<TodoGoalToolDetails> {
	const phases = result.details?.phases ?? [];
	const text = resultText(textOfResult(result), state, phases);
	const details: TodoGoalToolDetails | undefined =
		result.details === undefined || state.kind === "none"
			? result.details
			: { ...result.details, goal: state.goal, explanations: state.items };
	return { ...result, content: [{ type: "text", text }], details };
}

type TodoToolSession = Pick<ToolSession, "getSessionFile" | "getTodoPhases" | "setTodoPhases">;

/** The native tool reads and writes the list only through these members (`tools/todo.ts`, `execute`). */
const todoToolSession = (session: AgentSession): TodoToolSession => ({
	getSessionFile: () => session.sessionManager.getSessionFile() ?? null,
	getTodoPhases: () => session.getTodoPhases(),
	setTodoPhases: (phases) => session.setTodoPhases(phases),
});

const failure = (text: string, phases: TodoPhase[], session: AgentSession): AgentToolResult<TodoGoalToolDetails> => ({
	content: [{ type: "text", text }],
	details: { phases, storage: session.sessionManager.getSessionFile() ? "session" : "memory" },
	isError: true,
});

/**
 * One `todo` call: wrapper rules, then the native tool on the calling
 * session, then the goal snapshot when it changed. The snapshot is a session
 * entry, appended at once, so the next call of the same batch reads it while
 * this call's tool result is not yet on the branch. Native details pass
 * through (plus the display copy), so the tracker, HUD and rehydration see a
 * native result.
 */
export async function runTodo(
	pi: ExtensionAPI,
	session: AgentSession,
	toolCallId: string,
	raw: unknown,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<TodoGoalToolDetails>> {
	const before = session.getTodoPhases();
	const parsed = parseParams(raw, before.length > 0);
	if (parsed.kind === "invalid") return failure(parsed.message, before, session);
	const { params } = parsed;
	const previous = currentTodoGoal(session.sessionManager.getBranch());
	const errors = ruleErrors(params, previous);
	if (errors.length > 0) return failure(`Errors: ${errors.join("; ")}`, before, session);

	// The native implementation consumes only this adapter's three members, despite its broader constructor type.
	const native = new TodoTool(todoToolSession(session) as ToolSession);
	// Native params are a subset of its schema's type, which is not exported.
	const result = await native.execute(toolCallId, nativeParams(params) as Parameters<TodoTool["execute"]>[1], signal);
	if (result.isError || params.op === "view") return withGoal(result, previous);
	const goal = params.goal ?? (previous.kind === "set" ? previous.goal : undefined);
	// ruleErrors guarantees a goal for every mutation; reaching here without one is a programmer error.
	if (goal === undefined) throw new Error("todo mutation without a goal");
	const snapshot = nextSnapshot(params, previous, goal, result.details?.phases ?? []);
	if (!sameSnapshot(previous, snapshot)) pi.appendEntry<TodoGoalSnapshot>(TODO_GOAL_ENTRY_TYPE, snapshot);
	return withGoal(result, { kind: "set", goal: snapshot.goal, items: snapshot.items });
}

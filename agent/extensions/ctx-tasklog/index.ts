/**
 * Records successful todo/goal mutations from tool_result for main and sub sessions.
 * Appends timestamped lines to local://task-log/<agent-id>.md, expanding committed
 * todo-more changes in order and adding a set line only for an operation's own
 * goal. Reads that file's metadata to add its heading once. Read-only operations are not logged.
 * Writes are serialized and failures are warned without failing the host hook.
 */
import { appendFile, mkdir, stat } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import { type LocalProtocolOptions, resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { isRecord } from "@oh-my-pi/pi-utils";
import { errorText } from "../_shared/errors.ts";
import {
	type GoalOperation,
	goalOperation,
	type TodoOperation,
	taskLogGoalSchema,
	taskLogPath,
	todoOperation,
} from "../_shared/task-log.ts";

interface TodoPhaseDetails {
	name: string;
	taskCount: number;
}

interface TodoResultDetails {
	op?: TodoOperation;
	phases?: TodoPhaseDetails[];
	completedTasks?: string[];
}

interface GoalResultDetails {
	op?: GoalOperation;
	objective?: string;
}

interface TodoCounts {
	phases: number;
	tasks: number;
}
const inputItemsSchema = z.array(z.object({ title: z.string() }));
const inputPhasesSchema = z.array(z.object({ phase: z.string(), items: inputItemsSchema }));

const changeNameSchema = z.string().min(1);
const changeMinutesSchema = z
	.number()
	.int()
	.positive()
	.max(Math.floor(Number.MAX_SAFE_INTEGER / 60_000));
const changeItemsSchema = z
	.array(z.object({ title: changeNameSchema, explanation: z.string(), estimatedMinutes: changeMinutesSchema }))
	.min(1);
const changeGoalSchema = taskLogGoalSchema.optional();
const todoMoreChangeSchema = z.union([
	z.object({
		op: z.literal("init"),
		goal: taskLogGoalSchema,
		list: z.array(z.object({ phase: z.string(), items: changeItemsSchema })).min(1),
	}),
	z.object({ op: z.literal("append"), phase: changeNameSchema, items: changeItemsSchema, goal: changeGoalSchema }),
	z.object({ op: z.literal("start"), task: changeNameSchema, goal: changeGoalSchema }),
	z.object({ op: z.literal("explain"), task: changeNameSchema, explanation: z.string(), goal: changeGoalSchema }),
	z.object({ op: z.literal("estimate"), task: changeNameSchema, estimatedMinutes: changeMinutesSchema, goal: changeGoalSchema }),
	z
		.object({
			op: z.enum(["done", "drop", "rm"]),
			task: changeNameSchema.optional(),
			phase: changeNameSchema.optional(),
			goal: changeGoalSchema,
		})
		.refine((change) => change.task === undefined || change.phase === undefined, "must target at most one task or phase"),
	z
		.object({
			op: z.literal("block"),
			task: changeNameSchema.optional(),
			phase: changeNameSchema.optional(),
			reason: z.string().optional(),
			goal: changeGoalSchema,
		})
		.refine((change) => (change.task === undefined) !== (change.phase === undefined), "must target one task or phase"),
	z
		.object({
			op: z.literal("unblock"),
			task: changeNameSchema.optional(),
			phase: changeNameSchema.optional(),
			goal: changeGoalSchema,
		})
		.refine((change) => (change.task === undefined) !== (change.phase === undefined), "must target one task or phase"),
	z.object({ op: z.literal("goal"), goal: taskLogGoalSchema }),
]);
const todoMoreChangesSchema = z.array(todoMoreChangeSchema).min(1);
type TodoMoreChange = z.infer<typeof todoMoreChangeSchema>;

let writeTail: Promise<void> = Promise.resolve();

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function quote(value: string | undefined): string {
	const normalized = value === undefined ? "-" : oneLine(value);
	return JSON.stringify(normalized || "-");
}

function parseTodoDetails(value: unknown): TodoResultDetails | undefined {
	if (!isRecord(value)) return undefined;
	const op = todoOperation(value.op);
	const phasesValue = value.phases;
	let phases: TodoPhaseDetails[] | undefined;
	if (Array.isArray(phasesValue)) {
		const parsed: TodoPhaseDetails[] = [];
		for (const phaseValue of phasesValue) {
			if (!isRecord(phaseValue) || typeof phaseValue.name !== "string" || !Array.isArray(phaseValue.tasks)) {
				phases = undefined;
				break;
			}
			if (!phaseValue.tasks.every((task) => isRecord(task) && typeof task.content === "string")) {
				phases = undefined;
				break;
			}
			parsed.push({ name: phaseValue.name, taskCount: phaseValue.tasks.length });
		}
		if (phases === undefined && parsed.length === phasesValue.length) phases = parsed;
	}
	let completedTasks: string[] | undefined;
	if (Array.isArray(value.completedTasks)) {
		const parsed: string[] = [];
		for (const item of value.completedTasks) {
			if (!isRecord(item) || typeof item.content !== "string") break;
			parsed.push(item.content);
		}
		if (parsed.length === value.completedTasks.length) completedTasks = parsed;
	}
	if (op === undefined && phases === undefined && completedTasks === undefined) return undefined;
	return { op, phases, completedTasks };
}

function parseGoalDetails(value: unknown): GoalResultDetails | undefined {
	if (!isRecord(value)) return undefined;
	const op = goalOperation(value.op);
	let objective: string | undefined;
	if (isRecord(value.goal)) objective = stringValue(value.goal.objective);
	if (op === undefined && objective === undefined) return undefined;
	return { op, objective };
}

function parseInputPhases(value: unknown): TodoCounts | undefined {
	if (!isRecord(value)) return undefined;
	if (Array.isArray(value.list)) {
		const parsed = inputPhasesSchema.safeParse(value.list);
		if (!parsed.success) return undefined;
		return {
			phases: parsed.data.length,
			tasks: parsed.data.reduce((total, phase) => total + phase.items.length, 0),
		};
	}
	const parsed = inputItemsSchema.safeParse(value.items);
	if (parsed.success) return { phases: 1, tasks: parsed.data.length };
	return undefined;
}

function countsFromDetails(details: TodoResultDetails | undefined): TodoCounts | undefined {
	if (!details?.phases) return undefined;
	return {
		phases: details.phases.length,
		tasks: details.phases.reduce((total, phase) => total + phase.taskCount, 0),
	};
}

function formatTodoDetail(op: TodoOperation, input: Record<string, unknown>, details: TodoResultDetails | undefined): string | undefined {
	switch (op) {
		case "init": {
			const counts = countsFromDetails(details) ?? parseInputPhases(input);
			return counts ? `${counts.phases} phases / ${counts.tasks} tasks` : "0 phases / 0 tasks";
		}
		case "start":
		case "done":
		case "drop":
		case "block":
		case "unblock": {
			const task = stringValue(input.task);
			const phase = stringValue(input.phase);
			const completed = details?.completedTasks?.[0];
			const target = task ?? phase ?? completed ?? (op === "done" || op === "drop" ? "all tasks" : undefined);
			const reason = op === "block" ? stringValue(input.reason) : undefined;
			return `${quote(target)}${reason ? ` (${oneLine(reason)})` : ""}`;
		}
		case "append": {
			const phase = stringValue(input.phase);
			const items = inputItemsSchema.safeParse(input.items);
			const count = items.success ? items.data.length : 0;
			return `phase ${quote(phase)}: +${count}`;
		}
		case "rm": {
			const task = stringValue(input.task);
			if (task !== undefined) return quote(task);
			const phase = stringValue(input.phase);
			if (phase !== undefined) return `phase ${quote(phase)}`;
			return "all tasks";
		}
		case "explain":
			return quote(stringValue(input.task));
		case "view":
			return undefined;
		default: {
			const unreachable: never = op;
			throw new Error(`Unexpected todo operation: ${unreachable}`);
		}
	}
}

function formatTodoMoreChanges(changes: TodoMoreChange[], timestamp: string): string {
	const lines: string[] = [];
	for (const change of changes) {
		if (change.op !== "goal" && change.op !== "estimate") {
			// Each change describes its own operation, not the batch's final projection.
			const detail = formatTodoDetail(change.op, change, undefined);
			if (detail !== undefined) lines.push(`- ${timestamp} todo ${change.op}: ${detail}`);
		}
		// The existing history vocabulary has no estimate event; retain that policy without dropping the rest of a batch.
		if (change.goal !== undefined) lines.push(`- ${timestamp} todo-more set: ${JSON.stringify(change.goal)}`);
	}
	return lines.join("\n");
}

function formatGoalDetail(op: GoalOperation, input: Record<string, unknown>, details: GoalResultDetails | undefined): string | undefined {
	switch (op) {
		case "create":
			return quote(stringValue(input.objective) ?? details?.objective);
		case "resume":
		case "complete":
		case "drop":
			return quote(details?.objective ?? stringValue(input.objective));
		case "get":
			return undefined;
		default: {
			const unreachable: never = op;
			throw new Error(`Unexpected goal operation: ${unreachable}`);
		}
	}
}

function formatLocalTimestamp(date: Date): string {
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function resolveAgentId(ctx: ExtensionContext): string {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile) {
		const normalizedSessionFile = resolvePath(sessionFile);
		const ref = AgentRegistry.global()
			.list()
			.find((candidate) => candidate.sessionFile !== null && resolvePath(candidate.sessionFile) === normalizedSessionFile);
		if (ref) return ref.id;
	}
	return MAIN_AGENT_ID;
}

function resolveTaskLogPath(ctx: ExtensionContext): { path: string; agentId: string } {
	const localProtocolOptions: LocalProtocolOptions = ctx.localProtocolOptions ?? {
		getArtifactsDir: () => ctx.sessionManager.getArtifactsDir(),
		getSessionId: () => ctx.sessionManager.getSessionId(),
	};
	const localRoot = resolveLocalRoot(localProtocolOptions);
	const agentId = resolveAgentId(ctx);
	return { path: taskLogPath(localRoot, agentId), agentId };
}

async function appendTaskLog(path: string, agentId: string, line: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	let needsHeader = false;
	try {
		needsHeader = (await stat(path)).size === 0;
	} catch {
		// Missing or inaccessible task logs need a heading on the next append.
		needsHeader = true;
	}
	if (needsHeader) await appendFile(path, `# Task log: ${agentId}\n`, "utf8");
	await appendFile(path, `${line}\n`, "utf8");
}

function safeWarn(pi: ExtensionAPI, error: unknown): void {
	try {
		pi.logger.warn("ctx-tasklog failed", { error: errorText(error) });
	} catch {
		// Logging must never become an extension-handler failure.
	}
}

function queueTaskLog(pi: ExtensionAPI, path: string, agentId: string, line: string): Promise<void> {
	writeTail = writeTail.then(() => appendTaskLog(path, agentId, line)).catch((error) => safeWarn(pi, error));
	return writeTail;
}

export default function ctxTaskLog(pi: ExtensionAPI): void {
	pi.on("tool_result", async (event, ctx): Promise<void> => {
		try {
			if ((event.toolName !== "todo" && event.toolName !== "goal") || event.isError !== false) return;
			const input = event.input;
			const timestamp = formatLocalTimestamp(new Date());
			let detail: string | undefined;
			let operation: TodoOperation | GoalOperation | undefined;
			if (event.toolName === "todo") {
				if (isRecord(event.details) && event.details.todoMore === true) {
					if (event.details.op === "view" && event.details.changes === undefined) return;
					const changes = todoMoreChangesSchema.safeParse(event.details.changes);
					if (!changes.success) {
						safeWarn(pi, new Error(`Invalid todo-more changes: ${changes.error.message}`));
						return;
					}
					const target = resolveTaskLogPath(ctx);
					await queueTaskLog(pi, target.path, target.agentId, formatTodoMoreChanges(changes.data, timestamp));
					return;
				}
				const details = parseTodoDetails(event.details);
				const op = todoOperation(input.op) ?? details?.op;
				if (op === undefined) return;
				operation = op;
				detail = formatTodoDetail(op, input, details);
			} else {
				const details = parseGoalDetails(event.details);
				const op = goalOperation(input.op) ?? details?.op;
				if (op === undefined) return;
				operation = op;
				detail = formatGoalDetail(op, input, details);
			}
			if (detail === undefined || operation === undefined) return;
			const target = resolveTaskLogPath(ctx);
			let line = `- ${timestamp} ${event.toolName} ${operation}: ${detail}`;
			if (event.toolName === "todo") {
				const goal = taskLogGoalSchema.safeParse(input.goal);
				if (goal.success) line += `\n- ${timestamp} todo-more set: ${JSON.stringify(goal.data)}`;
			}
			await queueTaskLog(pi, target.path, target.agentId, line);
		} catch (error) {
			safeWarn(pi, error);
		}
	});
}

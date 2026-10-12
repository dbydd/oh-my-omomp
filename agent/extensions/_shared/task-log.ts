import { resolve } from "node:path";

/** Stable on-disk operation names shared by the logger and context reader. */
export type TodoOperation = "init" | "start" | "done" | "rm" | "drop" | "block" | "unblock" | "append" | "view";
export type GoalOperation = "create" | "get" | "complete" | "resume" | "drop";

export type TaskLogEvent =
	| { tool: "todo"; op: TodoOperation; detail: string; atMs: number }
	| { tool: "goal"; op: GoalOperation; detail: string; atMs: number };

export function taskLogPath(localRoot: string, agentId: string): string {
	return resolve(localRoot, "task-log", `${agentId}.md`);
}

export function todoOperation(value: unknown): TodoOperation | undefined {
	switch (value) {
		case "init":
		case "start":
		case "done":
		case "rm":
		case "drop":
		case "block":
		case "unblock":
		case "append":
		case "view":
			return value;
		default:
			return undefined;
	}
}

export function goalOperation(value: unknown): GoalOperation | undefined {
	switch (value) {
		case "create":
		case "get":
		case "complete":
		case "resume":
		case "drop":
			return value;
		default:
			return undefined;
	}
}

/** Parse one logger line; timestamps are local wall time, without a zone suffix. */
export function parseTaskLogEvent(line: string): TaskLogEvent | undefined {
	const match = /^-\s+(\S+)\s+(\S+)\s+(todo|goal)\s+([a-z]+):\s*(.*)$/i.exec(line.trim());
	if (!match) return undefined;
	const [, date, time, toolName, operation, detail = ""] = match;
	if (date === undefined || time === undefined) return undefined;
	const parsed = Date.parse(`${date}T${time}`);
	const atMs = Number.isFinite(parsed) ? parsed : 0;
	const tool = toolName?.toLowerCase();
	const candidate = operation?.toLowerCase();
	if (tool === "todo") {
		const op = todoOperation(candidate);
		return op === undefined ? undefined : { tool, op, detail, atMs };
	}
	if (tool === "goal") {
		const op = goalOperation(candidate);
		return op === undefined ? undefined : { tool, op, detail, atMs };
	}
	return undefined;
}

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Text, z } from "@oh-my-pi/pi-coding-agent";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { goalLines, itemSchema, todoGoalSchema } from "../_shared/todo-goal.ts";

/**
 * TUI rendering of the wrapper's calls and results. The native todo renderer
 * cannot be loaded from an extension, and it would not show the goal or the
 * explanations; this draws the same list from the result details.
 */

const callSchema = z
	.object({
		op: z.string().optional(),
		task: z.string().optional(),
		phase: z.string().optional(),
		items: z.array(z.unknown()).optional(),
		list: z.array(z.object({ items: z.array(z.unknown()) }).passthrough()).optional(),
	})
	.passthrough();

const STATUSES = ["pending", "in_progress", "completed", "abandoned", "blocked"] as const;
type Status = (typeof STATUSES)[number];

const detailsSchema = z
	.object({
		phases: z.array(
			z.object({
				name: z.string(),
				tasks: z.array(z.object({ content: z.string(), status: z.enum(STATUSES), blocker: z.string().optional() }).passthrough()),
			}),
		),
		goal: todoGoalSchema.optional(),
		explanations: z.array(itemSchema).optional(),
	})
	.passthrough();

type Options = { readonly expanded: boolean; readonly isPartial: boolean };

const MARKER: Record<Status, string> = { pending: "[ ]", in_progress: "[/]", completed: "[x]", abandoned: "[-]", blocked: "[!]" };

function statusColor(status: Status): "accent" | "success" | "dim" | "warning" | "muted" {
	switch (status) {
		case "in_progress":
			return "accent";
		case "completed":
			return "success";
		case "abandoned":
			return "dim";
		case "blocked":
			return "warning";
		case "pending":
			return "muted";
		default: {
			const unreachable: never = status;
			throw new Error(`Unexpected todo status: ${String(unreachable)}`);
		}
	}
}

const isOpen = (status: Status): boolean => status === "pending" || status === "in_progress" || status === "blocked";

export function renderTodoCall(args: unknown, _options: Options, theme: Theme): Text {
	const parsed = callSchema.safeParse(args);
	const parts = [theme.fg("accent", theme.bold("Todo"))];
	if (parsed.success) {
		const call = parsed.data;
		parts.push(call.op ?? "update");
		if (call.task) parts.push(call.task);
		if (call.phase) parts.push(call.phase);
		const count = call.list?.reduce((total, phase) => total + phase.items.length, 0) ?? call.items?.length ?? 0;
		if (count > 0) parts.push(theme.fg("dim", `${count} item${count === 1 ? "" : "s"}`));
	}
	return new Text(parts.join(" "), 0, 0);
}

/** Collapsed: goal objective and every row. Expanded: the whole goal and each open row's explanation. */
export function renderTodoResult(result: AgentToolResult<unknown>, options: Options, theme: Theme): Text {
	const text = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	if (result.isError) return new Text(theme.fg("error", text || "Todo operation failed"), 0, 0);
	const parsed = detailsSchema.safeParse(result.details);
	if (!parsed.success) return new Text(text, 0, 0);
	const { phases, goal, explanations } = parsed.data;
	const lines: string[] = [];
	if (goal !== undefined) {
		const shown = options.expanded ? goalLines(goal) : [`Objective: ${goal.objective}`];
		lines.push(...shown.map((line) => theme.fg("dim", line)));
	}
	const explanationOf = (title: string): string | undefined => explanations?.find((item) => item.title === title)?.explanation;
	for (const phase of phases.filter((candidate) => candidate.tasks.length > 0)) {
		const closed = phase.tasks.filter((task) => task.status === "completed" || task.status === "abandoned").length;
		lines.push(`${theme.bold(phase.name)} ${theme.fg("dim", `${closed}/${phase.tasks.length}`)}`);
		for (const task of phase.tasks) {
			const blocker = task.status === "blocked" && task.blocker ? theme.fg("dim", ` (blocked: ${task.blocker})`) : "";
			lines.push(`  ${theme.fg(statusColor(task.status), `${MARKER[task.status]} ${task.content}`)}${blocker}`);
			const explanation = options.expanded && isOpen(task.status) ? explanationOf(task.content) : undefined;
			if (explanation !== undefined) lines.push(`      ${theme.fg("dim", explanation)}`);
		}
	}
	return new Text(lines.length > 0 ? lines.join("\n") : text, 0, 0);
}

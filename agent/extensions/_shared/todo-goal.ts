import { type SessionEntry, z } from "@oh-my-pi/pi-coding-agent";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";

/**
 * The goal and item explanations `todo-goal` keeps beside the host's todo list.
 * The host's TodoTracker owns titles, statuses and blockers; these session
 * custom entries, written by `todo-goal` after each successful change, own the
 * rest. Each entry is a full snapshot, so the latest one on the branch wins.
 */
export const TODO_GOAL_ENTRY_TYPE = "mouriya.omp.todo-goal";

/** What the work is, how its result is measured, and how far it must go to count as done. */
export type TodoGoal = { readonly objective: string; readonly measure: string; readonly doneWhen: string };

export type ItemExplanation = { readonly title: string; readonly explanation: string };

export type TodoGoalState =
	| { readonly kind: "none" }
	| { readonly kind: "set"; readonly goal: TodoGoal; readonly items: readonly ItemExplanation[] };

export const NO_TODO_GOAL: TodoGoalState = { kind: "none" };

const text = z.string().refine((value) => value.trim().length > 0, "must not be empty");

export const todoGoalSchema = z.object({ objective: text, measure: text, doneWhen: text });

export const itemSchema = z.object({ title: text, explanation: text });

const snapshotSchema = z.object({ goal: todoGoalSchema, items: z.array(itemSchema) });

/** The data of one TODO_GOAL_ENTRY_TYPE entry. */
export type TodoGoalSnapshot = z.infer<typeof snapshotSchema>;

const clearedListSchema = z.object({ phases: z.array(z.unknown()).max(0) });

/**
 * The goal state on `entries` (a session branch, oldest first): the latest
 * snapshot entry, unless a later host edit cleared the whole list (`/todo`
 * clear, a forked or cloned session's reset), which clears the goal with it.
 */
export function currentTodoGoal(entries: readonly SessionEntry[]): TodoGoalState {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom") continue;
		if (entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) {
			if (clearedListSchema.safeParse(entry.data).success) return NO_TODO_GOAL;
			continue;
		}
		if (entry.customType !== TODO_GOAL_ENTRY_TYPE) continue;
		const parsed = snapshotSchema.safeParse(entry.data);
		if (parsed.success) return { kind: "set", goal: parsed.data.goal, items: parsed.data.items };
	}
	return NO_TODO_GOAL;
}

/** The explanation recorded for `title`; undefined for a title added outside the tool (`/todo` edits). */
export function explanationOf(state: TodoGoalState, title: string): string | undefined {
	switch (state.kind) {
		case "none":
			return undefined;
		case "set":
			return state.items.find((item) => item.title === title)?.explanation;
		default: {
			const unreachable: never = state;
			throw new Error(`Unexpected todo goal state: ${String(unreachable)}`);
		}
	}
}

/** The goal as three labelled lines. */
export function goalLines(goal: TodoGoal): string[] {
	return [`Objective: ${goal.objective}`, `Measure: ${goal.measure}`, `Done when: ${goal.doneWhen}`];
}

/**
 * Replaces OMP's native `todo` with a wrapper that adds a goal and per-item
 * explanations, and gives `task:*` subagents that same `todo`.
 *
 * Registers the tool `todo` (overriding the native one) and hooks
 * `before_agent_start`. Parameters are the native ones, except that items
 * are `{title, explanation}` and `goal` is `{objective, measure, doneWhen}`;
 * `task` targets a title. Each call checks the wrapper's rules, runs a native
 * `TodoTool` bound to the calling session — so the host's TodoTracker stays
 * the source of titles, statuses and blockers, and its reminders, HUD and
 * branch rehydration work unchanged — then appends a `mouriya.omp.todo-goal`
 * session entry with the goal and the explanations of the titles on the list
 * whenever they changed (`_shared/todo-goal.ts` reads it back). The result's
 * details are the native ones plus a display copy of the goal state; its text
 * adds the goal and the explanations of open items. Its own renderer draws
 * the list with the goal (render.ts): an extension override is not a built-in,
 * so the TUI never picks the native todo renderer for it.
 *
 * OMP drops `todo` from subagents that are not prewalk-armed: the executor
 * strips it from the active set at spawn and filters it out of
 * extension-driven active-tool changes (`task/executor.ts`,
 * `isParentOwnedTool`). At every `before_agent_start` of a `task:*` subagent
 * the hook puts the wrapper back on that session: it re-activates the
 * registered `todo`, or, in a tool-restricted session whose registry holds no
 * extension tools, installs the wrapper as a host tool. The todo state is per
 * session, so a subagent owns its own list.
 *
 * Reads the agent registry and the session branch; writes session entries
 * only. No config files. Hook failures are logged and never reach omp.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { errorText } from "../_shared/errors.ts";
import { renderTodoCall, renderTodoResult } from "./render.ts";
import { DESCRIPTION, parametersSchema, runTodo } from "./tool.ts";

const TOOL_NAME = "todo";

const TODO_AGENTS: Record<string, true> = {
	"task:high": true,
	"task:mid": true,
	"task:low": true,
	"task:free": true,
};

/** Fields shared by the registered tool and the host-tool install, matching the native tool's. */
const TOOL_FIELDS = {
	name: TOOL_NAME,
	label: "Todo",
	summary: "Write a structured todo list with a goal to track progress within a session",
	description: DESCRIPTION,
	parameters: parametersSchema,
	approval: "read" as const,
	loadMode: "discoverable" as const,
	strict: true,
	// Read off the definition by the host (extensibility/tool-proxy.ts): calls run one at a time,
	// and a call without `op` reaches execute raw so the wrapper can infer it as native todo does.
	concurrency: "exclusive" as const,
	lenientArgValidation: true,
};

/** The AgentSession this extension instance serves, through the registry entry of its agent id. */
const ownSession = (ctx: ExtensionContext): AgentSession | undefined => AgentRegistry.global().get(ctx.agent.id)?.session ?? undefined;

const isTaskAgent = (ctx: ExtensionContext): boolean => {
	if (ctx.agent.kind !== "sub") return false;
	const ref = AgentRegistry.global().get(ctx.agent.id);
	return ref !== undefined && Object.hasOwn(TODO_AGENTS, ref.displayName);
};

/** `task:*` subagent: put the wrapper back after the executor stripped `todo`. */
async function installForTask(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!isTaskAgent(ctx)) return;
	const session = ownSession(ctx);
	if (session === undefined) return;
	if (session.getAllToolNames().includes(TOOL_NAME)) {
		const enabled = session.getEnabledToolNames();
		if (enabled.includes(TOOL_NAME)) return;
		// Direct on the session: the executor's filter strips `todo` from extension-driven changes.
		await session.setActiveToolsByName([...enabled, TOOL_NAME]);
		return;
	}
	// A tool-restricted session registers no extension tools; the RPC host-tool slot still takes one.
	const hostTool = {
		...TOOL_FIELDS,
		execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => runTodo(pi, session, toolCallId, params, signal),
	};
	// The host registry erases each tool's parameter schema; the wrapper validates its input itself.
	await session.refreshRpcHostTools([hostTool as unknown as AgentTool]);
}

export default function todoGoal(pi: ExtensionAPI): void {
	pi.registerTool({
		...TOOL_FIELDS,
		execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
			const session = ownSession(ctx);
			if (session === undefined) throw new Error(`todo: no session registered for agent ${ctx.agent.id}`);
			return runTodo(pi, session, toolCallId, params, signal);
		},
		renderCall: renderTodoCall,
		renderResult: renderTodoResult,
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			await installForTask(pi, ctx);
		} catch (error) {
			pi.logger.warn("todo-goal could not install todo", { error: errorText(error) });
		}
	});
}

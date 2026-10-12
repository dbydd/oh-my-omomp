/**
 * Gives `task:*` subagents their own `todo` tool.
 * Registers `before_agent_start` and adds native `todo` only to eligible
 * subagent sessions without it; main sessions and other agents are untouched.
 * Reads the host agent registry and owning session's todo tracker; native
 * tool results persist in that session's transcript. No config files.
 *
 * OMP drops `todo` from every subagent that is not prewalk-armed, in two
 * places: `isToolAllowed` never builds it for yield-gated sessions
 * (`tools/index.ts`), and the executor strips it from the active set at spawn
 * (`task/executor.ts`, `isParentOwnedTool`). The todo state itself is already
 * per session — each `AgentSession` owns its `TodoTracker`, and the stop-time
 * completion reminder, mid-run nudge, and branch rehydration all key on that
 * session — so a subagent can own a list without touching its parent's.
 *
 * At `before_agent_start` (after the executor's strip), the extension finds
 * its own `AgentSession` through the agent registry and installs a native
 * `TodoTool` bound to that session as a host tool. The tool keeps the name
 * `todo`, so its results persist and rehydrate like the built-in one. Sessions
 * that already have a `todo` (the main agent, prewalk-armed subagents) and
 * agents outside `task:*` are left alone. Any failure only logs a warning.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { errorText } from "../_shared/errors.ts";

const TODO_AGENTS: Record<string, true> = {
	"task:high": true,
	"task:mid": true,
	"task:low": true,
	"task:free": true,
};

/** The `task:*` subagent session this extension instance runs in, if any. */
const ownTaskSession = (ctx: ExtensionContext): AgentSession | undefined => {
	if (ctx.agent.kind !== "sub") return undefined;
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile === undefined) return undefined;
	// Task session files are `<artifacts>/<agent-id>.jsonl`; the registry ref carries the agent definition name.
	const ref = AgentRegistry.global()
		.list()
		.find((candidate) => candidate.sessionFile === sessionFile);
	if (ref === undefined || !Object.hasOwn(TODO_AGENTS, ref.displayName)) return undefined;
	return ref.session ?? undefined;
};

/**
 * `TodoTool.execute` reads and writes the list only through these three
 * members (`tools/todo.ts`, `execute`), so they are bound to the owning
 * session and nothing else is exposed.
 */
type TodoToolSession = Pick<ToolSession, "getSessionFile" | "getTodoPhases" | "setTodoPhases">;

const todoToolSession = (session: AgentSession): TodoToolSession => ({
	getSessionFile: () => session.sessionManager.getSessionFile() ?? null,
	getTodoPhases: () => session.getTodoPhases(),
	setTodoPhases: (phases) => session.setTodoPhases(phases),
});

export default function subagentTodo(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			const session = ownTaskSession(ctx);
			if (session === undefined) return;
			if (session.getAllToolNames().includes("todo")) return;
			// The native implementation consumes only this adapter's three members, despite its broader constructor type.
			const todo = new TodoTool(todoToolSession(session) as ToolSession);
			// The host registry erases each tool's parameter schema; native TodoTool validates its input before use.
			await session.refreshRpcHostTools([todo as AgentTool]);
		} catch (error) {
			pi.logger.warn("subagent-todo could not install todo", { error: errorText(error) });
		}
	});
}

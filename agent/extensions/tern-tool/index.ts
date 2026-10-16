/**
 * tern — drive the Tern terminal multiplexer from the agent, with the session
 * pinned on every call.
 *
 * Tern multiplexes many sessions in one daemon, and its CLI accepts a bare
 * block id, `@focused`, a tab title or a program name. A call that names no
 * session resolves against whichever session the daemon defaults to, which may
 * be another person's or another agent's terminal: it writes into their shell,
 * captures their screen, or closes their block. This extension exists so that
 * driving an interactive program through Tern is safe and observable:
 *
 *   - `session` is a REQUIRED parameter on every op, validated by exact name or
 *     id against `tern ls --json`. There is no default and no inference. When
 *     the session does not exist the error lists the real sessions so the model
 *     asks the human instead of guessing.
 *   - The block is always passed as `SESSION/BLOCK`; a block that already
 *     contains `/` is rejected rather than silently split.
 *   - Mutating ops dump the block's visible page afterwards, so the caller
 *     reads the effect instead of assuming it.
 *
 * One tool, `tern`, with an `op` discriminator: `blocks`, `open`, `send`,
 * `keys`, `run`, `capture`, `wait`, `process`, `close`. `open` defaults
 * `--keep-open` (a program that exits otherwise takes its block with it) and
 * returns the new `SESSION/BLOCK` target. The driver lives in `tern.ts`, the
 * ops in `ops.ts`.
 *
 * Registers the `tern` tool for main and subagent sessions. Reads no files;
 * state is whatever the Tern daemon holds. Failures are returned to the agent
 * as tool errors; the extension never throws into omp.
 *
 * Requires `tern` on PATH; when it is absent every op reports that and nothing
 * else happens.
 */
import { type ExtensionAPI, z } from "@oh-my-pi/pi-coding-agent";
import type { OpResult } from "./ops.ts";
import { blocks, capture, close, keys, open, process as processOp, run, send, wait } from "./ops.ts";

const TOOL = "tern";

const params = z.object({
	session: z
		.string()
		.min(1)
		.describe(
			"The Tern session to operate in, by name or id (for example `onlyne:alexandria` or `4`). REQUIRED and never inferred: a call without it could reach another person's terminal. If you do not know which session to use, run `tern ls` yourself or ask the human; do not guess.",
		),
	op: z
		.enum(["blocks", "open", "send", "keys", "run", "capture", "wait", "process", "close"])
		.describe("What to do. `blocks` lists the session's tabs and blocks; the rest act on one block."),
	block: z
		.string()
		.optional()
		.describe("The block id (or `@focused`/title/program) inside the session. Required for every op except `blocks` and `open`."),
	text: z.string().optional().describe("Text to paste for `send` and `run`. `send` does not press Enter; `run` does."),
	keys: z.array(z.string()).optional().describe("Key combos for `keys`, e.g. `enter`, `ctrl+c`, `esc`."),
	command: z.array(z.string()).optional().describe("For `open`: the command to run in the new tab (argv). Omit for a plain shell tab."),
	cwd: z.string().optional().describe("For `open`: the new tab's working directory."),
	scrollback: z.boolean().optional().describe("For `capture`: include scrollback history, not just the visible page."),
	until: z.string().optional().describe("For `wait`: `exit`, `prompt`, or `idle=MS`."),
	timeoutSeconds: z.number().int().positive().optional().describe("For `wait`: give up after this many seconds."),
	quietMs: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("For `run`: how long the block must stay quiet before the page is read. Default 400."),
});

const DESCRIPTION = [
	"Drive the Tern terminal multiplexer (sessions, tabs, blocks) to run and inspect interactive programs: REPLs, `ssh`, `sudo`, TUI programs, `git rebase -i`, installers that prompt.",
	"`session` is REQUIRED on every call and is validated by exact name or id; there is no default and no inference, because a call that names no session could reach another person's or another agent's terminal. If you do not know the session, run `tern ls` yourself (it lists what exists) or ask the human; do not guess.",
	"Typical loop: `blocks` to see what is there, `open` to start a program (returns the new `SESSION/BLOCK` target), `run` or `send`+`keys` to drive it, `capture` to read the screen, `wait` to let it finish, `close` to clean up.",
	"`open` adds `--keep-open` unless you pass it yourself, so the block survives the program exiting. Every mutating op returns the block's visible page, so you read the effect rather than assuming it.",
	"Prefer this over `bash` for anything that needs a live terminal: `bash` cannot answer a prompt or show a full-screen program.",
].join("\n");

/** Turn an op result into the tool's return shape. */
function result(value: OpResult): { content: { type: "text"; text: string }[]; isError?: true } {
	return value.ok ? { content: [{ type: "text", text: value.text }] } : { content: [{ type: "text", text: value.text }], isError: true };
}

export default function ternTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL,
		label: "Tern",
		description: DESCRIPTION,
		approval: "exec",
		loadMode: "discoverable",
		parameters: params,
		async execute(_toolCallId, rawParams) {
			const paramsValue = params.parse(rawParams);
			try {
				switch (paramsValue.op) {
					case "blocks":
						return result(await blocks(pi, paramsValue.session));
					case "open":
						return result(await open(pi, paramsValue.session, paramsValue.cwd, paramsValue.command ?? []));
					case "send": {
						if (paramsValue.block === undefined) return result({ ok: false, text: "`send` needs a `block`." });
						if (paramsValue.text === undefined) return result({ ok: false, text: "`send` needs `text`." });
						return result(await send(pi, paramsValue.session, paramsValue.block, paramsValue.text));
					}
					case "keys": {
						if (paramsValue.block === undefined) return result({ ok: false, text: "`keys` needs a `block`." });
						return result(await keys(pi, paramsValue.session, paramsValue.block, paramsValue.keys ?? []));
					}
					case "run": {
						if (paramsValue.block === undefined) return result({ ok: false, text: "`run` needs a `block`." });
						if (paramsValue.text === undefined) return result({ ok: false, text: "`run` needs `text`." });
						return result(await run(pi, paramsValue.session, paramsValue.block, paramsValue.text, paramsValue.quietMs ?? 400));
					}
					case "capture": {
						if (paramsValue.block === undefined) return result({ ok: false, text: "`capture` needs a `block`." });
						return result(await capture(pi, paramsValue.session, paramsValue.block, paramsValue.scrollback ?? false));
					}
					case "wait": {
						if (paramsValue.block === undefined) return result({ ok: false, text: "`wait` needs a `block`." });
						return result(await wait(pi, paramsValue.session, paramsValue.block, paramsValue.until, paramsValue.timeoutSeconds));
					}
					case "process": {
						if (paramsValue.block === undefined) return result({ ok: false, text: "`process` needs a `block`." });
						return result(await processOp(pi, paramsValue.session, paramsValue.block));
					}
					case "close": {
						if (paramsValue.block === undefined) return result({ ok: false, text: "`close` needs a `block`." });
						return result(await close(pi, paramsValue.session, paramsValue.block));
					}
					default:
						return result({ ok: false, text: `Unknown op \`${String(paramsValue.op)}\`.` });
				}
			} catch (error) {
				pi.logger.warn("tern: op failed", { op: paramsValue.op, error: error instanceof Error ? error.message : String(error) });
				return result({ ok: false, text: `tern ${paramsValue.op} failed: ${error instanceof Error ? error.message : String(error)}` });
			}
		},
	});
}

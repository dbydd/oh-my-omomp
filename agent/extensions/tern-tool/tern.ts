/**
 * Tern CLI driver: the one place that runs `tern`, and the one place that
 * decides whether a call is allowed to touch another session's terminal.
 *
 * Tern multiplexes many sessions inside one daemon. Every subcommand accepts a
 * bare block id, `@focused`, a tab title or a program name; a call that names
 * no session resolves against whichever session the daemon defaults to — which
 * may be another person's or another agent's terminal, so a mis-scoped call
 * writes into their shell, captures their screen, or closes their block. The
 * driver therefore refuses any target that is not spelled `SESSION/BLOCK`
 * with the session supplied by the caller: no default, no inference, no
 * fallback to "the current window" or "the first window".
 *
 * `tern ls --json` is the only source of truth about what exists; the driver
 * validates the caller's session against it and, when it does not exist,
 * returns the list so the caller can ask the human instead of guessing.
 *
 * Every mutating op dumps the block's visible page afterwards (plain
 * `capture` without `--scrollback`), so the caller reads what happened rather
 * than assuming it.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";

/** One block as `tern ls --json` reports it; only the fields we render are named. */
const blockSchema = z
	.object({
		id: z.union([z.number(), z.string()]),
		title: z.string().optional(),
		program: z.string().optional(),
		cwd: z.string().optional(),
		live: z.boolean().optional(),
		focused: z.boolean().optional(),
		keep_open: z.boolean().optional(),
	})
	.passthrough();
const tabSchema = z
	.object({
		id: z.union([z.number(), z.string()]),
		number: z.number().optional(),
		blocks: z.array(blockSchema).optional(),
	})
	.passthrough();
/** One session as `tern ls --json` reports it. */
export const sessionSchema = z
	.object({
		id: z.union([z.number(), z.string()]),
		name: z.string(),
		tabs: z.array(tabSchema).optional(),
	})
	.passthrough();
const lsSchema = z.object({ sessions: z.array(sessionSchema).optional() });

export type TernSession = z.infer<typeof sessionSchema>;
export type TernTab = z.infer<typeof tabSchema>;
export type TernBlock = z.infer<typeof blockSchema>;

/** The whole `tern ls --json` listing, or `undefined` when it did not parse. */
export async function listListing(pi: ExtensionAPI): Promise<readonly TernSession[] | undefined> {
	const result = await runTern(pi, ["ls", "--json"], { timeoutMs: 15_000 });
	if (result.kind !== "ok") return undefined;
	try {
		const parsed = lsSchema.safeParse(JSON.parse(result.stdout));
		return parsed.success ? (parsed.data.sessions ?? []) : undefined;
	} catch {
		// Non-JSON output means the CLI changed shape; treat as unavailable.
		return undefined;
	}
}

/** A tern invocation that failed, or the process result when it ran. */
export type RunResult =
	| { readonly kind: "ok"; readonly stdout: string }
	| { readonly kind: "failed"; readonly message: string }
	| { readonly kind: "missing" };

export interface RunOptions {
	readonly timeoutMs?: number;
}

/** Run one `tern` invocation, never throwing; a non-zero exit becomes `failed`. */
export async function runTern(pi: ExtensionAPI, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
	if (!Bun.which("tern")) return { kind: "missing" };
	try {
		const result = await pi.exec("tern", [...args], options.timeoutMs ? { timeout: options.timeoutMs } : undefined);
		if (result.code !== 0) {
			const message = result.stderr.trim() || result.stdout.trim() || `tern exited with code ${result.code}`;
			return { kind: "failed", message: result.killed ? `${message} (killed: timed out)` : message };
		}
		return { kind: "ok", stdout: result.stdout };
	} catch (error) {
		return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
	}
}

/** Sessions the daemon currently holds; `undefined` when the listing itself failed. */
export async function listSessions(pi: ExtensionAPI): Promise<readonly TernSession[] | undefined> {
	return listListing(pi);
}

/** `name (id)` for each session, for an error message that lets the human choose. */
export function describeSessions(sessions: readonly TernSession[]): string {
	if (sessions.length === 0) return "the daemon holds no sessions";
	return sessions.map((session) => `${session.name} (${session.id})`).join(", ");
}

/**
 * Whether `session` names one of `sessions`, by exact name or exact id.
 * Deliberately exact: a fuzzy match here would re-introduce the guessing this
 * module exists to prevent.
 */
export function sessionMatches(sessions: readonly TernSession[], session: string): boolean {
	return sessions.some((candidate) => candidate.name === session || String(candidate.id) === session);
}

/** The `SESSION/BLOCK` target, or an error when the pieces cannot form one. */
export function buildTarget(
	session: string,
	block: string,
): { readonly kind: "ok"; readonly target: string } | { readonly kind: "error"; readonly reason: string } {
	const trimmed = block.trim();
	if (trimmed.length === 0) return { kind: "error", reason: "a block is required for this op" };
	if (trimmed.includes("/")) {
		return {
			kind: "error",
			reason: `the block must be the block alone, without the session (got \`${trimmed}\`); pass the session as \`session\` and the block as \`block\``,
		};
	}
	return { kind: "ok", target: `${session}/${trimmed}` };
}

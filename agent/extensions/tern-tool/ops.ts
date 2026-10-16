/**
 * The tern ops, one function each, all routed through {@link runTern} so the
 * session-pinning rule has a single enforcement point.
 *
 * Every op takes the session separately from the block and resolves the target
 * with {@link buildTarget}; none of them ever constructs a target from a
 * default. Mutating ops return the block's visible page as the tail of their
 * text, so the caller sees the effect instead of assuming it.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { buildTarget, describeSessions, listListing, listSessions, runTern, sessionMatches, type TernSession } from "./tern.ts";

export type OpResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly text: string };

const ok = (text: string): OpResult => ({ ok: true, text });
const fail = (text: string): OpResult => ({ ok: false, text });

/** Resolve the caller's session against the daemon's list, or explain how to proceed. */
async function requireSession(
	pi: ExtensionAPI,
	session: string,
): Promise<{ readonly ok: true; readonly sessions: readonly TernSession[] } | { readonly ok: false; readonly text: string }> {
	const sessions = await listSessions(pi);
	if (sessions === undefined) {
		return {
			ok: false,
			text: "Could not list Tern sessions (`tern ls --json` failed or returned unexpected output). Run `tern ls` yourself to see what exists, then ask the human which session to use.",
		};
	}
	if (!sessionMatches(sessions, session)) {
		return {
			ok: false,
			text: `No Tern session is called \`${session}\`. Sessions right now: ${describeSessions(sessions)}. Ask the human which session to use; do not guess.`,
		};
	}
	return { ok: true, sessions };
}

/** Validate `session`/`block` into a `SESSION/BLOCK` target. */
async function target(
	pi: ExtensionAPI,
	session: string,
	block: string,
): Promise<{ readonly ok: true; readonly target: string } | { readonly ok: false; readonly text: string }> {
	const guard = await requireSession(pi, session);
	if (!guard.ok) return guard;
	const built = buildTarget(session, block);
	if (built.kind === "error") return { ok: false, text: built.reason };
	return { ok: true, target: built.target };
}

/** The block's visible page (no scrollback), as the caller should read it. */
async function page(pi: ExtensionAPI, target: string): Promise<string> {
	const result = await runTern(pi, ["capture", target, "--ansi"], { timeoutMs: 15_000 });
	return result.kind === "ok"
		? result.stdout.replace(/\s+$/, "")
		: `(could not read the screen: ${result.kind === "failed" ? result.message : "tern not found"})`;
}

/** List the session's tabs and blocks, with the flags that matter. */
export async function blocks(pi: ExtensionAPI, session: string): Promise<OpResult> {
	const sessions = await listListing(pi);
	if (sessions === undefined) return fail("Could not list Tern sessions (`tern ls --json` failed or returned unexpected output).");
	const match = sessions.find((candidate) => candidate.name === session || String(candidate.id) === session);
	if (match === undefined) {
		return fail(
			`No Tern session is called \`${session}\`. Sessions right now: ${describeSessions(sessions)}. Ask the human which session to use; do not guess.`,
		);
	}
	const lines: string[] = [];
	lines.push(`session ${match.id}  ${match.name}`);
	for (const tab of match.tabs ?? []) {
		lines.push(`  tab ${tab.id}${tab.number !== undefined ? ` (#${tab.number})` : ""}`);
		for (const block of tab.blocks ?? []) {
			const flags: string[] = [];
			if (block.focused === true) flags.push("focused");
			if (block.live === false) flags.push("dead");
			if (block.keep_open === true) flags.push("keep-open");
			const title = (block.title ?? block.program ?? "").trim();
			lines.push(`    block ${String(block.id)}  ${title}${flags.length > 0 ? `  [${flags.join(",")}]` : ""}`);
			if (block.cwd !== undefined && block.cwd.length > 0) lines.push(`      cwd ${block.cwd}`);
		}
	}
	return ok(lines.join("\n"));
}

/**
 * Open a new tab in the session and report its block id.
 * `--keep-open` is added unless the caller passed it: a program that exits
 * otherwise takes its block with it, and the next send/capture finds nothing.
 */
export async function open(pi: ExtensionAPI, session: string, cwd: string | undefined, command: readonly string[]): Promise<OpResult> {
	const guard = await requireSession(pi, session);
	if (!guard.ok) return fail(guard.text);
	const args = ["new", "tab", session];
	if (!command.includes("--keep-open")) args.push("--keep-open");
	if (cwd !== undefined && cwd.trim().length > 0) args.push("--cwd", cwd);
	args.push("--json");
	if (command.length > 0) args.push("--", ...command);
	const result = await runTern(pi, args, { timeoutMs: 30_000 });
	if (result.kind !== "ok") return fail(result.kind === "missing" ? "tern is not on PATH." : result.message);
	let block: unknown;
	try {
		block = (JSON.parse(result.stdout) as { block?: unknown }).block;
	} catch {
		return fail(`Opened a tab but could not parse \`tern new\` output: ${result.stdout.trim()}`);
	}
	if (block === undefined) return fail(`Opened a tab but its output had no block id: ${result.stdout.trim()}`);
	const target = `${session}/${String(block)}`;
	// The program has not drawn its first frame yet; a brief idle wait turns an
	// empty dump into the program's own prompt or banner.
	await runTern(pi, ["wait", target, "--until", "idle=300", "--timeout", "10"], { timeoutMs: 15_000 });
	return ok(`target ${target}\n\n${await page(pi, target)}`);
}

/** Paste characters into the block. `send text` does not press Enter. */
export async function send(pi: ExtensionAPI, session: string, block: string, text: string): Promise<OpResult> {
	const resolved = await target(pi, session, block);
	if (!resolved.ok) return fail(resolved.text);
	const result = await runTern(pi, ["send", resolved.target, "text", text], { timeoutMs: 15_000 });
	if (result.kind !== "ok") return fail(result.kind === "missing" ? "tern is not on PATH." : result.message);
	return ok(`Sent text to ${resolved.target}.\n\n${await page(pi, resolved.target)}`);
}

/** Send key combos (`enter`, `ctrl+c`, `esc`, …). */
export async function keys(pi: ExtensionAPI, session: string, block: string, combos: readonly string[]): Promise<OpResult> {
	const resolved = await target(pi, session, block);
	if (!resolved.ok) return fail(resolved.text);
	if (combos.length === 0) return fail("At least one key combo is required (for example `enter`).");
	const result = await runTern(pi, ["send", resolved.target, "keys", ...combos], { timeoutMs: 15_000 });
	if (result.kind !== "ok") return fail(result.kind === "missing" ? "tern is not on PATH." : result.message);
	return ok(`Sent keys ${combos.join(" ")} to ${resolved.target}.\n\n${await page(pi, resolved.target)}`);
}

/** Type `text`, press Enter, let the block go quiet, then read the page. */
export async function run(pi: ExtensionAPI, session: string, block: string, text: string, quietMs: number): Promise<OpResult> {
	const resolved = await target(pi, session, block);
	if (!resolved.ok) return fail(resolved.text);
	const typed = await runTern(pi, ["send", resolved.target, "text", text], { timeoutMs: 15_000 });
	if (typed.kind !== "ok") return fail(typed.kind === "missing" ? "tern is not on PATH." : typed.message);
	const entered = await runTern(pi, ["send", resolved.target, "keys", "enter"], { timeoutMs: 15_000 });
	if (entered.kind !== "ok") return fail(entered.kind === "missing" ? "tern is not on PATH." : entered.message);
	// A wedged block must not hold the tool open; the dump below is what matters.
	await runTern(pi, ["wait", resolved.target, "--until", `idle=${quietMs}`, "--timeout", "30"], { timeoutMs: 35_000 });
	return ok(`Ran in ${resolved.target}.\n\n${await page(pi, resolved.target)}`);
}

/** Read the block's screen. `--scrollback` includes history. */
export async function capture(pi: ExtensionAPI, session: string, block: string, scrollback: boolean): Promise<OpResult> {
	const resolved = await target(pi, session, block);
	if (!resolved.ok) return fail(resolved.text);
	const args = ["capture", resolved.target, "--ansi"];
	if (scrollback) args.push("--scrollback");
	const result = await runTern(pi, args, { timeoutMs: 15_000 });
	if (result.kind !== "ok") return fail(result.kind === "missing" ? "tern is not on PATH." : result.message);
	return ok(result.stdout.replace(/\s+$/, ""));
}

/** Wait for the block to exit, prompt, or go idle. */
export async function wait(
	pi: ExtensionAPI,
	session: string,
	block: string,
	until: string | undefined,
	timeoutSeconds: number | undefined,
): Promise<OpResult> {
	const resolved = await target(pi, session, block);
	if (!resolved.ok) return fail(resolved.text);
	const args = ["wait", resolved.target];
	if (until !== undefined && until.trim().length > 0) args.push("--until", until);
	if (timeoutSeconds !== undefined) args.push("--timeout", String(timeoutSeconds));
	const result = await runTern(pi, args, { timeoutMs: ((timeoutSeconds ?? 30) + 10) * 1000 });
	if (result.kind !== "ok") return fail(result.kind === "missing" ? "tern is not on PATH." : result.message);
	return ok(`Wait finished for ${resolved.target}.\n\n${await page(pi, resolved.target)}`);
}

/** Process info for the block: what program is in front of it. */
export async function process(pi: ExtensionAPI, session: string, block: string): Promise<OpResult> {
	const resolved = await target(pi, session, block);
	if (!resolved.ok) return fail(resolved.text);
	const result = await runTern(pi, ["process", resolved.target, "--json"], { timeoutMs: 15_000 });
	if (result.kind !== "ok") return fail(result.kind === "missing" ? "tern is not on PATH." : result.message);
	return ok(result.stdout.trim());
}

/** Close the block. */
export async function close(pi: ExtensionAPI, session: string, block: string): Promise<OpResult> {
	const resolved = await target(pi, session, block);
	if (!resolved.ok) return fail(resolved.text);
	const result = await runTern(pi, ["close", resolved.target], { timeoutMs: 15_000 });
	if (result.kind !== "ok") return fail(result.kind === "missing" ? "tern is not on PATH." : result.message);
	return ok(`Closed ${resolved.target}.`);
}

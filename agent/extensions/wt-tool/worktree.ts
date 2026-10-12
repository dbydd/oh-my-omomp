import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { planWorktreeExit, type SessionWorktree } from "@oh-my-pi/pi-coding-agent/session/session-worktree";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { errorText } from "../_shared/errors.ts";

const LIST_LIMIT = 50;

/** What wt_remove would do to the worktree at one instant. */
export type WorktreeCheck = {
	/** Realpath of the linked worktree root. */
	readonly worktree: string;
	readonly branch: string;
	/** Realpath of the repository's main checkout. */
	readonly mainDir: string;
	/** Binds confirmation to exactly this state. */
	readonly confirm: string;
	readonly staged: readonly string[];
	readonly unstaged: readonly string[];
	readonly untracked: readonly string[];
	readonly ignored: readonly string[];
	/** Branch commits not reachable from the main checkout's HEAD. */
	readonly unmergedCommits: readonly string[];
	/** Live users of the worktree that removal would pull it out from under. */
	readonly blockers: readonly string[];
};

type CheckResult = { readonly kind: "ok"; readonly check: WorktreeCheck } | { readonly kind: "error"; readonly reason: string };
type Recheck = { readonly kind: "ok"; readonly check: WorktreeCheck } | { readonly kind: "stop"; readonly why: string };
type StatusEntry = { readonly x: string; readonly y: string; readonly shown: string };

/** Parse git status --porcelain=v1 -z; rename/copy entries have a second source-path field. */
export function parsePorcelain(raw: string): StatusEntry[] {
	const fields = raw.split("\0");
	const entries: StatusEntry[] = [];
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (field === undefined || field.length < 4) continue;
		const x = field.charAt(0);
		const y = field.charAt(1);
		const file = field.slice(3);
		const shown = x === "R" || x === "C" ? `${fields[++i]} -> ${file}` : file;
		entries.push({ x, y, shown });
	}
	return entries;
}

function isWithin(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export const realpathOr = (dir: string): Promise<string> => fs.realpath(dir).catch(() => path.resolve(dir));

export async function git(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
	const result = await pi.exec("git", args, { cwd });
	if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`);
	return result.stdout;
}

/** Upstream's worktree fingerprint plus ignored files, which its snapshot does not see. */
async function fingerprint(worktree: SessionWorktree, ignored: readonly string[]): Promise<string> {
	const warnings: string[] = [];
	const plan = await planWorktreeExit(
		[worktree],
		"ask",
		async () => true,
		(message) => warnings.push(message),
	);
	const approved = plan[0]?.approvedFingerprint;
	if (approved === undefined) throw new Error(`could not inspect the worktree: ${warnings.join("; ") || "no snapshot"}`);
	return Bun.hash([worktree.path, worktree.branch, approved, ...ignored].join("\0")).toString(16);
}

async function ignoredEntries(pi: ExtensionAPI, worktree: string): Promise<string[]> {
	return (await git(pi, worktree, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]))
		.split("\0")
		.filter(Boolean);
}

async function blockersFor(ctx: ExtensionContext, worktree: string): Promise<string[]> {
	const blockers = (ctx.getAsyncJobSnapshot()?.running ?? []).map((job) => `background job ${job.id} still running: ${job.label}`);
	for (const ref of AgentRegistry.global().list()) {
		// Task agents persist session files; in-memory extension helper sessions never touch the worktree.
		if (ref.kind !== "sub" || ref.sessionFile === null) continue;
		if (ref.status === "running") {
			blockers.push(`subagent ${ref.id} is running`);
			continue;
		}
		const cwd = ref.session?.sessionManager.getCwd();
		if (cwd !== undefined && isWithin(await realpathOr(cwd), worktree)) {
			blockers.push(`subagent ${ref.id} (${ref.status}) works in this worktree`);
		}
	}
	return blockers;
}

/** Inspect the linked worktree containing dir. Read-only. */
export async function inspect(pi: ExtensionAPI, ctx: ExtensionContext, dir: string): Promise<CheckResult> {
	try {
		const repository = vcs.git(dir);
		if (!repository) return { kind: "error", reason: `${dir} is not inside a git repository.` };
		const linked = repository.linkedWorktree();
		if (!linked) return { kind: "error", reason: `${dir} is the main checkout, not a linked worktree.` };
		const worktree = await realpathOr(linked.root);
		const mainDir = await realpathOr(linked.primaryRoot);
		const branch = await repository.currentBranch();
		if (!branch) return { kind: "error", reason: `${worktree} has a detached HEAD; check out a branch first so no commit is lost.` };
		const tip = await repository.headSha();
		if (!tip) return { kind: "error", reason: `${worktree} has no commits.` };
		const record: SessionWorktree = { path: worktree, branch, sourceCwd: mainDir, baseCommit: tip, keptChanges: true };
		const before = await fingerprint(record, await ignoredEntries(pi, worktree));
		const entries = parsePorcelain(await git(pi, worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
		const untracked = entries.filter((entry) => entry.x === "?").map((entry) => entry.shown);
		const tracked = entries.filter((entry) => entry.x !== "?");
		const staged = tracked.filter((entry) => entry.x !== " ").map((entry) => `${entry.x} ${entry.shown}`);
		const unstaged = tracked.filter((entry) => entry.y !== " ").map((entry) => `${entry.y} ${entry.shown}`);
		const ignored = await ignoredEntries(pi, worktree);
		const mainHead = (await git(pi, mainDir, ["rev-parse", "HEAD"])).trim();
		const unmergedCommits = (await git(pi, worktree, ["log", "--format=%h %s", `${mainHead}..${tip}`])).split("\n").filter(Boolean);
		const after = await fingerprint(record, ignored);
		if (after !== before) return { kind: "error", reason: `${worktree} changed while it was being checked; check again.` };
		return {
			kind: "ok",
			check: {
				worktree,
				branch,
				mainDir,
				confirm: after,
				staged,
				unstaged,
				untracked,
				ignored,
				unmergedCommits,
				blockers: await blockersFor(ctx, worktree),
			},
		};
	} catch (error) {
		return { kind: "error", reason: errorText(error) };
	}
}

/** Reinspect a confirmed worktree: unchanged and unblocked, otherwise the reason to stop. */
export async function recheck(pi: ExtensionAPI, ctx: ExtensionContext, confirmed: WorktreeCheck): Promise<Recheck> {
	const current = await inspect(pi, ctx, confirmed.worktree);
	if (current.kind === "error") return { kind: "stop", why: current.reason };
	if (current.check.confirm !== confirmed.confirm) {
		return {
			kind: "stop",
			why: `the worktree changed since the check (a file was added, removed or edited, or HEAD or the branch moved). Current state:\n${formatCheck(current.check)}`,
		};
	}
	if (current.check.blockers.length > 0) return { kind: "stop", why: `it is in use:\n${current.check.blockers.join("\n")}` };
	return { kind: "ok", check: current.check };
}

function listing(title: string, items: readonly string[]): string {
	if (items.length === 0) return `${title}: none`;
	const shownItems = items.slice(0, LIST_LIMIT).map((item) => `  ${item}`);
	const rest = items.length > LIST_LIMIT ? [`  … and ${items.length - LIST_LIMIT} more`] : [];
	return [`${title} (${items.length}):`, ...shownItems, ...rest].join("\n");
}

export function formatCheck(check: WorktreeCheck): string {
	const lost = check.staged.length + check.unstaged.length + check.untracked.length + check.ignored.length;
	const verdict =
		check.blockers.length > 0
			? "BLOCKED: removal would be refused until the blockers below are gone."
			: lost > 0
				? `UNSAFE: removal permanently deletes the ${lost} entr${lost === 1 ? "y" : "ies"} listed below.`
				: "SAFE: no file in the worktree would be lost.";
	return [
		`Worktree: ${check.worktree}`,
		`Branch: ${check.branch} (kept)`,
		`Main checkout (the session moves here): ${check.mainDir}`,
		`Verdict: ${verdict}`,
		listing("Blockers", check.blockers),
		listing("Staged changes (deleted)", check.staged),
		listing("Unstaged changes (deleted)", check.unstaged),
		listing("Untracked files (deleted)", check.untracked),
		listing("Ignored files and directories (deleted)", check.ignored),
		listing(`Commits on ${check.branch} not reachable from the main checkout's HEAD (kept on the branch)`, check.unmergedCommits),
		`confirm: ${check.confirm}`,
	].join("\n");
}

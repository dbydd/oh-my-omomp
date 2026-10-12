import type { JudgmentState } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { openNativeJudge } from "../_shared/judge.ts";
import type { WatchedCall } from "./calls.ts";
import type { JevDetector } from "./detector-config.ts";

const JUDGE_TIMEOUT_MS = 90_000;
/** One operation the system prompt assigns to a built-in tool, asked as its own yes/no question. */
type PolicyRule = {
	readonly id: string;
	/** How the nag names the violation. */
	readonly label: string;
	/** The built-in tool the system prompt requires instead. */
	readonly tool: string;
	readonly question: string;
	readonly yes: string;
	readonly no: string;
};

const POLICY_PREAMBLE = [
	"The state is one tool call made by an AI coding agent. Its system prompt requires the built-in tools below and forbids reassembling the operations they cover through the shell or the eval kernel:",
	"`read` (file contents and line ranges, directory listings, archive members, SQLite databases, PDFs and documents, images, web URLs, remote files as `ssh://host/path`), `glob` (find files by name or pattern), `grep` (regex search over files), `edit` (modify an existing file; also renames and moves files), `write` (create or overwrite a file), `eval` (persistent Python/JS kernel for computation, data transforms, structured parsing, library calls), `ast_grep` / `ast_edit` (structural code search and rewrites), `exec_command` (shell commands; `tty: true` gives interactive programs a real terminal).",
	"The shell stays legitimate for real binaries and short fact pipelines: builds, tests, package managers, git, external CLIs and APIs, counts and checksums (`… | wc -l`, `sha256sum`), and anything run through `sudo` / `doas` / `su`.",
	"Answer only the question below about this one call; ignore every other aspect of it.",
].join("\n");

/** Asked about `bash` / `bash_bg` / `exec_command` commands; state `{ tool, command, tty }`. */
export const SHELL_RULES: readonly PolicyRule[] = [
	{
		id: "list",
		label: "用 shell 列目录 / 找文件",
		tool: "`read <dir>` / `glob`",
		question:
			"Does this command list a directory or find files by name, path or pattern (`ls`, `find`, `fd`, `tree`, `ls -t | head`), an operation `read <dir>` or `glob` covers? A listing whose output only feeds a counter (`find … | wc -l`) does not count.",
		yes: "The command lists directory entries or finds files that `read <dir>` or `glob` could return.",
		no: "The command neither lists directories nor finds files, or only counts them.",
	},
	{
		id: "read",
		label: "用 shell 读文件 / 归档 / 数据库 / 网页内容",
		tool: "`read`",
		question:
			"Does this command fetch content `read` delivers: a file or a slice of it (`cat`, `head`, `tail`, `sed -n`, `less`, `bat`, `nl`, `awk '{print}'`, `< file`), an archive member (`unzip -p`, `tar -xO`), SQLite rows (`sqlite3 db 'SELECT …'`), media metadata (`ffprobe`), or a web page or GitHub-hosted file viewed with `curl` / `wget`? Only commands whose purpose is printing that content count. Searching for matches (`grep`, `rg`, `awk '/re/'`) and changing files (`sed -i`) are judged by other rules and do not count here; neither do file bytes piped only into a counter or checksum, nor `curl` calls that drive an API, download artifacts or send data.",
		yes: "The command prints file, archive, database, media or web content that `read` could return.",
		no: "The command prints no such content: it searches, edits, counts or checksums, or uses curl for an API, download or upload.",
	},
	{
		id: "search",
		label: "用 shell 搜索文件文本",
		tool: "`grep`",
		question:
			"Does this command search file contents for text or a regex (`grep`, `rg`, `ag`, `ack`, `git grep` over files or directories; `awk` / `sed` / `perl` pattern matching over files), an operation the `grep` tool covers? Filtering another program's output stream (`cmd | grep x`) and counting matches do not count.",
		yes: "The command searches the contents of files or directories.",
		no: "The command searches no file contents, or only filters another program's output, or only counts matches.",
	},
	{
		id: "edit",
		label: "用 shell 修改已有文件",
		tool: "`edit`",
		question:
			"Does this command change an existing file in place (`sed -i`, `perl -pi`, `awk -i inplace`, `ed` / `ex` scripts, `>` / `>>` redirection or `tee` onto a file to alter it), an operation `edit` covers? Formatters, code generators, build tools, package managers and git operations that rewrite files as their own job do not count.",
		yes: "The command alters an existing file's text itself.",
		no: "The command alters no existing file, or a real tool rewrites files as its own job.",
	},
	{
		id: "write",
		label: "用 shell 新建 / 覆盖文件",
		tool: "`write`",
		question:
			"Does this command create or overwrite a file with content the agent itself authors (`echo` / `printf` / `cat <<EOF` redirected to a file, `tee file`, a heredoc into a file), an operation `write` covers? Redirecting a real program's output to a file (logs, build or test output, generated artifacts) does not count.",
		yes: "The command writes agent-authored content to a file.",
		no: "The command writes no agent-authored content to a file.",
	},
	{
		id: "move",
		label: "用 shell 重命名 / 移动文件",
		tool: "`edit` 的 `MV`",
		question:
			"Does this command rename or move a file or directory with `mv` (or `cp` followed by `rm`), an operation the `edit` tool's `MV` covers? `git mv` does not count.",
		yes: "The command renames or moves a file or directory.",
		no: "The command renames or moves nothing, or uses `git mv`.",
	},
	{
		id: "inlineScript",
		label: "在 shell 里跑内联 Python / JS 脚本",
		tool: "`eval`",
		question:
			"Does this command run inline script logic through the shell (`python3 - <<EOF`, `python -c`, `node -e`, `bun -e`, `deno eval`, `ruby -e`, `perl -e`, a heredoc or string piped into an interpreter), work the `eval` kernel covers? Running a script file that exists in the project (`python scripts/x.py`, `bun run build`, `bun test`) does not count.",
		yes: "The command runs inline script code through an interpreter.",
		no: "The command runs no inline script code.",
	},
	{
		id: "structural",
		label: "用文本工具做结构化代码搜索 / 改写",
		tool: "`ast_grep` / `ast_edit`",
		question:
			"Does this command search or rewrite code by syntax shape with text tools (regexes through `grep` / `sed` / `awk` / `perl` meant to match calls with their arguments, declarations, imports or multi-line constructs, or a codemod applied across files), work `ast_grep` / `ast_edit` cover? Searching for a literal identifier, string or log message does not count.",
		yes: "The command matches or rewrites code structure with text patterns.",
		no: "The command does no structural code matching or rewriting with text patterns.",
	},
	{
		id: "pty",
		label: "交互程序没有走 PTY",
		tool: "`exec_command` 加 `tty: true`，再用 `write_stdin` 驱动",
		question:
			"Does this command drive an interactive program without a real terminal: with `tty` false, an interactive `ssh` session, a password, passphrase or host-key prompt, `sudo` that will prompt, a REPL or database shell (`python`, `node`, `psql`, `mysql`, `redis-cli`), `docker exec -it` / `kubectl exec -it`, a TUI (`top`, `vim`, `less`), `git rebase -i` / `git add -p`, or an installer that asks questions; or a terminal faked with heredocs, `yes |`, `echo … |`, `expect`, `ssh -tt` or `script -q`? One-shot commands (`ssh host 'cmd'`, `psql -c '…'`, `docker exec` without `-it`) do not count.",
		yes: "The command runs an interactive program without a PTY, or fakes one.",
		no: "The command runs no interactive program, or runs it with `tty` true, or is a one-shot.",
	},
];

/** Asked about `eval` code; state `{ tool, language, code }`. */
export const EVAL_RULES: readonly PolicyRule[] = [
	{
		id: "read",
		label: "在 eval 里读文件",
		tool: "`read`",
		question:
			"Does this code read file contents from disk (`open(...).read()`, `Path.read_text` / `read_bytes`, `readlines`, `readFileSync`, `fs.readFile`, `Bun.file(...).text()` / `.json()`, the kernel's `read()` helper), content `read` delivers, including JSON through `?q=` jq filters and SQLite through selectors? Writing files and processing data already in memory do not count.",
		yes: "The code reads file contents from disk.",
		no: "The code reads no file contents.",
	},
	{
		id: "list",
		label: "在 eval 里列目录 / 找文件",
		tool: "`read <dir>` / `glob`",
		question:
			"Does this code list directories or find files (`os.listdir`, `os.scandir`, `os.walk`, `glob.glob`, `Path.glob` / `rglob`, `readdirSync`, `fs.readdir`, `Bun.Glob`), an operation `read <dir>` or `glob` covers?",
		yes: "The code lists directories or finds files.",
		no: "The code lists no directories and finds no files.",
	},
	{
		id: "search",
		label: "在 eval 里搜索文件文本",
		tool: "`grep`",
		question:
			"Does this code search file contents for text or a regex (reading files and matching patterns or substrings in them), an operation the `grep` tool covers?",
		yes: "The code searches the contents of files.",
		no: "The code searches no file contents.",
	},
	{
		id: "edit",
		label: "在 eval 里改写并保存文件",
		tool: "`edit` / `write`",
		question:
			"Does this code edit an existing file by reading it, changing the text and saving it back (rewrite-and-save, string replace then write), an operation `edit` covers? Writing new output files the computation produces does not count.",
		yes: "The code rewrites an existing file's text and saves it.",
		no: "The code rewrites no existing file.",
	},
	{
		id: "subprocess",
		label: "在 eval 里跑 shell 命令或普通程序",
		tool: "`exec_command`（或覆盖该操作的内置工具）",
		question:
			"Does this code start an operating-system process (`subprocess.run` / `Popen`, `os.system`, `!cmd`, `Bun.$`, `Bun.spawn`, `child_process`) such as `cat`, `ls`, `grep`, `rg`, `find`, `git`, builds or other programs that `exec_command` or another built-in tool runs directly? Calling the harness's own tools through `tool.<name>(…)` or `await tool.<name>(…)` starts no process and does not count.",
		yes: "The code starts an operating-system process.",
		no: "The code starts no operating-system process; calls to harness tools through `tool.<name>` do not count.",
	},
];

type JudgeResult =
	| { readonly kind: "ok"; readonly probabilities: Readonly<Record<string, number>> }
	| { readonly kind: "failed"; readonly reason: string };

/** One request, one independent yes/no question per rule: Jev answers each separately against the same call. */
export async function judgeCall(
	ctx: ExtensionContext,
	detector: JevDetector,
	call: WatchedCall,
	rules: readonly PolicyRule[],
): Promise<JudgeResult> {
	const signal = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
	const opened = await openNativeJudge(ctx, detector.judge, signal);
	switch (opened.kind) {
		case "unavailable":
			return { kind: "failed", reason: opened.reason };
		case "ready":
			break;
		default: {
			const unreachable: never = opened;
			return unreachable;
		}
	}
	try {
		const { judge } = opened;
		const questions: Record<string, { type: "noul"; instructions: string; criteria: { true: string; false: string } }> = {};
		for (const rule of rules) {
			questions[rule.id] = {
				type: "noul",
				instructions: `${POLICY_PREAMBLE}\n\nQuestion: ${rule.question}`,
				criteria: { true: rule.yes, false: rule.no },
			};
		}
		const state: JudgmentState =
			call.kind === "shell"
				? { tool: call.tool, command: call.command, tty: call.tty }
				: { tool: "eval", language: call.language, code: call.code };
		const result = await judge.judge({ state, questions }, { signal });
		const probabilities: Record<string, number> = {};
		for (const rule of rules) {
			const answer = result.answers[rule.id];
			if (answer === undefined) return { kind: "failed", reason: `judge returned no answer for ${rule.id}` };
			probabilities[rule.id] = answer.noul;
		}
		return { kind: "ok", probabilities };
	} catch (error) {
		return { kind: "failed", reason: errorText(error) };
	}
}

export type Flagged = { readonly rule: PolicyRule; readonly probability: number };

/** A code fence longer than any backtick run inside `text`. */
function fenced(text: string, language: string): string {
	let longest = 2;
	for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	const marks = "`".repeat(longest + 1);
	return `${marks}${language}\n${text}\n${marks}`;
}

/** Every violation Jev found in the call, one line each, followed by the call itself. */
export function jevNagText(call: WatchedCall, flagged: readonly Flagged[]): string {
	const tool = call.kind === "shell" ? call.tool : "eval";
	return [
		`你这次 \`${tool}\` 调用违反了 system prompt 的工具规则，共 ${flagged.length} 项：`,
		...flagged.map(({ rule }, index) => `${index + 1}. ${rule.label}：应该用 ${rule.tool}`),
		"",
		"这次调用：",
		call.kind === "shell" ? fenced(call.command, "sh") : fenced(call.code, call.language),
	].join("\n");
}

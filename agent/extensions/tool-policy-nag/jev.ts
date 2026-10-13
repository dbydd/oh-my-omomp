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

/**
 * Shared by every rule. It carries the boundary each question relies on: a rule
 * matches the operation the command performs, never a word that only resembles
 * the operation, and only where a built-in tool can reach the operand.
 */
const POLICY_PREAMBLE = [
	"The state is one tool call made by an AI coding agent. Its system prompt requires the built-in tools below and forbids reassembling the operations they cover through the shell or the eval kernel:",
	"`read` (file contents and line ranges, directory listings, archive members, SQLite databases, PDFs and documents, images, web URLs, remote files as `ssh://host/path`), `glob` (find files by name or pattern), `grep` (regex search over files), `edit` (modify an existing file; also renames and moves files), `write` (create or overwrite a file), `eval` (persistent Python/JS kernel for computation, data transforms, structured parsing, library calls), `ast_grep` / `ast_edit` (structural code search and rewrites), `exec_command` (shell commands; `tty: true` gives interactive programs a real terminal).",
	"Judge the operation the command actually performs, never a word that merely resembles it. Every rule applies only to what these tools can reach — a path on this machine, or one of the URI schemes above. A subcommand or argument belonging to another program (`docker ps`, `kubectl get pods`, `gh pr list`, `git ls-files`, `km ls actions`, `aws s3 ls`) lists or prints that program's own resources rather than anything a built-in tool could fetch, and a filter reshaping a stream (`cmd | jq`, `cmd | grep x`, `cmd | sort`, `… | wc -l`) works on bytes no built-in tool could have produced either.",
	"A command that runs on another machine or inside another container (`ssh`, `docker exec`, `kubectl exec`, `qm guest exec`, `orb -m`) works on files this machine's tools cannot reach: when the command is one of these, answer the questions below about listing, reading, searching and editing **no** — a `cat`, `ls`, `grep`, `sed -i` or `jq` inside it belongs to that other machine, not this one, however local it looks. The PTY question is the exception: it asks how a program is run, not which files it touches.",
	"The shell stays legitimate for real binaries and short fact pipelines: builds, tests, package managers, git, external CLIs and APIs, counts and checksums (`… | wc -l`, `sha256sum`), and anything run through `sudo` / `doas` / `su`.",
	"Answer only the question below.",
].join("\n");

/** Asked about `bash` / `bash_bg` / `exec_command` commands; state `{ tool, command, tty }`. */
export const SHELL_RULES: readonly PolicyRule[] = [
	{
		id: "list",
		label: "用 shell 列目录 / 找文件",
		tool: "`read <dir>` / `glob`",
		question:
			"Does this command run `ls`, `find`, `fd` or `tree` itself, to list local directory entries or find local files by name, path or pattern, an operation `read <dir>` or `glob` covers? The listing program must be the command's own program and its operand a local path: `ps` / `ls` / `get` / `list` as a subcommand or argument of another program (`docker ps`, `kubectl get pods`, `gh pr list`, `git ls-files`, `km ls actions`) lists that program's own resources and does not count. A command that runs on another machine or inside a container (`ssh`, `docker exec`, `kubectl exec`, `qm guest exec`, `orb -m`) lists that machine's files, not this machine's, so it does not count here. A listing whose output only feeds a counter (`find … | wc -l`) does not count either.",
		yes: "The command itself lists local directory entries or finds local files by name, path or pattern, the same entries `read <dir>` or `glob` would return.",
		no: "The command neither lists local directories nor finds local files itself, or only counts them, or its listing word is a subcommand or argument of another program, or it lists files of another machine or a container.",
	},
	{
		id: "read",
		label: "用 shell 读文件 / 归档 / 数据库 / 网页内容",
		tool: "`read`",
		question:
			"Does this command print content the `read` tool could fetch itself: a local file or a slice of it (`cat`, `head`, `tail`, `sed -n`, `less`, `bat`, `nl`, `jq . file`, `awk '{print}'`, `< file`), an archive member (`unzip -p`, `tar -xO`), SQLite rows (`sqlite3 db 'SELECT …'`), media metadata (`ffprobe`), or a web page or GitHub-hosted file fetched with `curl` / `wget`? Only printing the bytes of that content counts. Listing a directory's own entries (`ls`), an in-place edit (`sed -i`), a filter fed by another command's output stream (`cmd | jq`, `cmd | awk '{print}'`) and an interpreter driven by inline code that prints a computed result are judged by their own rules. Printing an object or revision out of a repository rather than the working-tree path (`git cat-file`, `git show HEAD:file`) is not what `read` can fetch, nor does a command that keeps watching a file as it grows (`tail -f`) read it. A command that runs on another machine or inside a container (`ssh`, `docker exec`, `kubectl exec`, `qm guest exec`, `orb -m`) reads that machine's files, not this machine's, so it does not count here. Printing an external CLI's or API's own output (`km ls actions -f json`, `docker ps`, `gh issue view`, `kubectl get -o yaml`) is that CLI's job, not `read`'s; neither do file bytes piped only into a counter or checksum, nor `curl` calls that drive an API, download artifacts or send data.",
		yes: "The command prints file, archive, database, media or web content that `read` could fetch itself from a path or URL.",
		no: "The command prints no such content: it lists a directory, searches, edits, counts or checksums, filters another command's output, computes through inline code, prints another program's own output or a repository object, follows a file instead of reading it, prints files of another machine or a container, or uses curl for an API, download or upload.",
	},
	{
		id: "search",
		label: "用 shell 搜索文件文本",
		tool: "`grep`",
		question:
			"Does this command search the contents of local files or directories for text or a regex (`grep`, `rg`, `ag`, `ack`, `git grep` over files or directories; `awk` / `sed` / `perl` pattern matching over files), an operation the `grep` tool covers? An in-place edit (`sed -i`) is judged by the edit rule, filtering another program's output stream (`cmd | grep x`) and counting matches do not count, and neither does a `grep` word that is a subcommand of another program.",
		yes: "The command searches the contents of local files or directories.",
		no: "The command searches no file contents, or only filters another program's output, or only counts matches, or its grep word belongs to another program.",
	},
	{
		id: "edit",
		label: "用 shell 修改已有文件",
		tool: "`edit`",
		question:
			"Does this command rewrite the text of an existing file in place (`sed -i`, `perl -pi`, `awk -i inplace`, `ed` / `ex` scripts, an editor driven in batch mode), an operation `edit` covers? Writing or appending to a file through redirection or `tee` is not an in-place edit and is judged by the write rule instead. Formatters, code generators, build tools, package managers and git operations that rewrite files as their own job do not count.",
		yes: "The command rewrites an existing file's text in place.",
		no: "The command rewrites no existing file in place, or only writes or appends to one through redirection or tee, or a real tool rewrites files as its own job.",
	},
	{
		id: "write",
		label: "用 shell 新建 / 覆盖文件",
		tool: "`write`（追加到已有文件时用 `edit`）",
		question:
			"Does this command put content the agent itself authors into a file — `echo` / `printf` / `cat <<EOF` redirected or piped into one, or `tee file` fed that same content, creating the file or replacing an existing one's text (appending with `>>` or `tee -a` counts too)? Redirecting or teeing a real program's own output into a file (logs, build, test or CLI output, generated artifacts, scratch files) is not agent-authored content and does not count.",
		yes: "The command writes agent-authored content into a file, creating it or replacing an existing file's text.",
		no: "The command writes no agent-authored content into a file, or only redirects or tees a real program's output.",
	},
	{
		id: "move",
		label: "用 shell 重命名 / 移动文件",
		tool: "`edit` 的 `MV`",
		question:
			"Does this command rename or move a file or directory with `mv` (or `cp` followed by `rm`), an operation the `edit` tool's `MV` covers? `git mv` does not count, and neither does a `mv` or `cp` word that is a subcommand of another program.",
		yes: "The command renames or moves a file or directory.",
		no: "The command renames or moves nothing, or uses `git mv`, or its mv/cp word belongs to another program.",
	},
	{
		id: "inlineScript",
		label: "在 shell 里跑内联 Python / JS 脚本",
		tool: "`eval`",
		question:
			"Does this command run inline script logic through a general-purpose language runtime (`python3 - <<EOF`, `python -c`, `node -e`, `bun -e`, `deno eval`, `ruby -e`, `perl -e`, `php -r`, a heredoc or string piped into one), work the `eval` kernel covers? Running a script file that exists in the project (`python scripts/x.py`, `bun run build`, `bun test`) does not count, and neither do queries and filters written in their own little languages (`jq`, `yq`, `awk`, `sed`, `xargs`), which are ordinary shell pipeline stages rather than script logic.",
		yes: "The command runs inline script code through a general-purpose interpreter.",
		no: "The command runs no inline script code, or only a stream or query filter such as jq or awk, or runs a script file from the project.",
	},
	{
		id: "structural",
		label: "用文本工具做结构化代码搜索 / 改写",
		tool: "`ast_grep` / `ast_edit`",
		question:
			"Does this command search or rewrite code by syntax shape with text tools (regexes through `grep` / `sed` / `awk` / `perl` meant to match calls with their arguments, declarations, imports or multi-line constructs, or a codemod applied across files), work `ast_grep` / `ast_edit` cover? Searching for a literal identifier, string or log message does not count, and neither does a regex applied to another program's output stream instead of to source code.",
		yes: "The command matches or rewrites code structure with text patterns.",
		no: "The command does no structural code matching or rewriting with text patterns.",
	},
	{
		id: "pty",
		label: "交互程序没有走 PTY",
		tool: "`exec_command` 加 `tty: true`，再用 `write_stdin` 驱动",
		question:
			"Does this command drive an interactive program without a real terminal: with `tty` false, a program that waits for the terminal it is talking to — a shell or `ssh` session with no command and no redirection, a prompt for a password, passphrase, host key or `sudo`, a REPL or database shell such as `python`, `node`, `psql` or `redis-cli` opened bare, `docker exec -it` / `kubectl exec -it`, a TUI such as `top`, `vim` or `less`, `git rebase -i` / `git add -p`, or an installer that asks on stdin — or a terminal faked with heredocs, `yes |`, `echo … |`, `expect`, `ssh -tt` or `script -q`? A program that only prints and exits is a one-shot whatever it is: launching an application (`open /Applications/X.app`), driving a browser or a control CLI (`agent-browser … open`, `tern capture`, `tern ctl …`), a build, test or lint command, `omp -p …` itself, or a one-shot given a command or a redirect (`ssh host 'cmd'`, `psql -c '…'`, `docker exec` without `-it`, `bash x.sh </dev/null`) does not count.",
		yes: "The command runs an interactive program without a PTY, or fakes one.",
		no: "The command runs no interactive program, or runs it with `tty` true, or only prints and exits.",
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
			"Does this code start an operating-system process (`subprocess.run` / `Popen`, `os.system`, `!cmd`, `Bun.$`, `Bun.spawn`, `child_process`) such as `cat`, `ls`, `grep`, `rg`, `find`, `git`, builds or other programs that `exec_command` or another built-in tool runs directly, or does it hand a command line to the shell through `tool.exec_command` / `tool.bash` / `tool.bash_bg`? In that last case look at the command line the code passes: a covered operation inside it (`ls`, `cat`, `grep`, `sed -i`, `find`, a directory listing) counts, while a real program (a build, a test, `git`, an external CLI) does not. Calling any other harness tool through `tool.<name>(…)` or `await tool.<name>(…)` (`tool.read`, `tool.write`, `tool.task`, `tool.todo`, …) is that tool's own business and does not count.",
		yes: "The code starts an operating-system process, or hands a shell a command line whose own operation a built-in tool covers.",
		no: "The code starts no operating-system process and hands no covered shell operation to the shell; a bridged `tool.exec_command` running a real program, and calls to other harness tools, do not count.",
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

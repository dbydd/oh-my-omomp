// ============================================================================
// turn-judge — after every main-session turn, ask OMP's native JUDGE one
// question per `TURN-JUDGE-*.md` file about that turn, then either show the
// verdict or type the configured prompt.
// Registers input, session_switch/branch/tree, and message_end hooks; no tools
// or commands. Reads adjacent/repository specs and session history; writes no files.
//
// FILE FORMAT. `TURN-JUDGE-<label>.md`, discovered like `WATCHDOG-*.md`:
//   - user level:  <extension dir>/TURN-JUDGE-*.md      (beside this index.ts)
//   - repo level:  <dir>/TURN-JUDGE-*.md and <dir>/.omp/TURN-JUDGE-*.md,
//                  walking from cwd up to the git root.
// Frontmatter (between `---` fences), one `key: value` per line; whole-line `#`
// comments are skipped. Keys are lowercased.
//   name:    example                     # optional; defaults to the file label
//   enabled: true                        # optional; only true/yes/on/1 keep it on
//   maxChars: 30000                      # optional; history budget, see STATE
//   option.<label>: <criteria>           # >= 2 options; empty criteria = the label says it all
//   option.<label>.prompt: <text>        # optional; typed as a user prompt when triggered
//   option.<label>.threshold: 0.7        # required with .prompt, in (0, 1]
// Labels are any text without `.` or spaces. Body = the question, sent verbatim.
//
// TURN. A turn is a main-session assistant message the model ended itself
// (`stopReason: "stop"`) with nonempty text. Aborted, errored and tool-use
// messages are not turns. Subagents are never judged. Files are re-read at
// every turn, so edits apply to the next turn.
//
// STATE. Each file is one separate judge request whose state is
//   { 过去的记录: [{ 角色: "用户" | "模型", 内容 }...], 本轮回复 }
// 过去的记录 is the current branch before this turn, oldest first: the human's
// own prompts (`attribution: "user"`, not synthetic) and every assistant
// message's text (tool calls, tool results and thinking are left out). When it
// exceeds `maxChars` characters, whole entries are dropped from the oldest end.
//
// OUTCOME. JUDGE answers one choice question with a probability per option.
// Among options that carry a prompt, the one with the highest probability at or
// above its threshold is triggered: its prompt is sent as a user message
// (`attribution: "agent"`; idle → starts a turn, busy → follow-up). Otherwise
// the verdict and every option's probability go into the turn's info
// notification, which lists every untriggered file at once after all of the
// turn's judgments settle (consecutive UI notifications replace each other).
// A turn the prompt itself causes is judged like any other; nothing caps it.
// If the user sends a prompt or moves the session before the verdict returns,
// the verdict is shown as info and nothing is typed.
//
// AVAILABILITY. No matching file in range: nothing runs — no request and no
// notification. No native JUDGE role: silently inactive. Role changes apply
// on the next turn. A failed request shows a warning for that turn; an invalid
// file warns once per process (per reason). Headless sessions only log.
// Nothing blocks or changes the turn.
// ============================================================================

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Judge } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { openNativeJudge } from "../_shared/judge.ts";
import { textOf } from "../_shared/messages.ts";
import { discoverSpecFiles, parseFrontmatter, unquote } from "../_shared/spec-files.ts";

const FILE_PATTERN = /^TURN-JUDGE-.+\.md$/i;
const OPTION_KEY = /^option\.([^.\s]+)(?:\.(prompt|threshold))?$/;
const DEFAULT_MAX_CHARS = 30_000;
const JUDGE_TIMEOUT_MS = 90_000;

type Outcome = { readonly kind: "info" } | { readonly kind: "prompt"; readonly prompt: string; readonly threshold: number };

type JudgeOption = { readonly label: string; readonly criteria: string | null; readonly outcome: Outcome };

type TurnJudgeSpec = {
	readonly name: string;
	readonly filePath: string;
	readonly question: string;
	readonly options: readonly JudgeOption[];
	readonly maxChars: number;
};

type SpecParse =
	| { readonly kind: "ok"; readonly spec: TurnJudgeSpec }
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid"; readonly reason: string };

type HistoryLine = { readonly 角色: "用户" | "模型"; readonly 内容: string };

type TurnState = { readonly 过去的记录: readonly HistoryLine[]; readonly 本轮回复: string };

type Verdict = { readonly choice: string; readonly probabilities: Readonly<Record<string, number>> };

type JudgeResult = { readonly kind: "ok"; readonly verdict: Verdict } | { readonly kind: "failed"; readonly reason: string };

type Action =
	| { readonly kind: "prompt"; readonly option: string; readonly probability: number; readonly prompt: string }
	| { readonly kind: "info" };

// --- discovery + parsing ----------------------------------------------------

type OptionsParse =
	| { readonly kind: "ok"; readonly options: readonly JudgeOption[] }
	| { readonly kind: "invalid"; readonly reason: string };

/** Collect flat `option.<label>[.prompt|.threshold]` keys into options, in declaration order. */
function parseOptions(fields: Readonly<Record<string, string>>): OptionsParse {
	const criteria = new Map<string, string | null>();
	const prompts = new Map<string, string>();
	const thresholds = new Map<string, string>();
	for (const [key, raw] of Object.entries(fields)) {
		const m = key.match(OPTION_KEY);
		const label = m?.[1];
		if (!m || label === undefined) continue;
		const value = unquote(raw);
		// OPTION_KEY admits exactly these suffixes; no cast of file input is needed.
		const suffix = m[2];
		if (suffix === undefined) {
			criteria.set(label, value || null);
		} else if (suffix === "prompt") {
			if (!value) return { kind: "invalid", reason: `option.${label}.prompt is empty` };
			prompts.set(label, value);
		} else if (suffix === "threshold") {
			thresholds.set(label, value);
		}
	}
	if (criteria.size < 2) return { kind: "invalid", reason: "needs at least two option.<label> entries" };
	for (const label of [...prompts.keys(), ...thresholds.keys()]) {
		if (!criteria.has(label)) return { kind: "invalid", reason: `option.${label} is not declared` };
	}
	const options: JudgeOption[] = [];
	for (const [label, rubric] of criteria) {
		const prompt = prompts.get(label);
		const rawThreshold = thresholds.get(label);
		if (prompt === undefined) {
			if (rawThreshold !== undefined) return { kind: "invalid", reason: `option.${label}.threshold set without option.${label}.prompt` };
			options.push({ label, criteria: rubric, outcome: { kind: "info" } });
			continue;
		}
		const threshold = rawThreshold === undefined ? Number.NaN : Number(rawThreshold);
		if (!(threshold > 0 && threshold <= 1)) {
			return { kind: "invalid", reason: `option.${label}.threshold must be a number in (0, 1]` };
		}
		options.push({ label, criteria: rubric, outcome: { kind: "prompt", prompt, threshold } });
	}
	return { kind: "ok", options };
}

function parseSpecFile(path: string): SpecParse {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return { kind: "invalid", reason: `unreadable: ${String(error)}` };
	}
	const parsed = parseFrontmatter(raw);
	if (!parsed) return { kind: "invalid", reason: "missing frontmatter" };
	const { fields, body } = parsed;
	if (fields.enabled !== undefined && !/^(true|yes|on|1)$/i.test(unquote(fields.enabled))) return { kind: "disabled" };
	const question = body.trim();
	if (question === "") return { kind: "invalid", reason: "empty body (the body is the question)" };
	let maxChars = DEFAULT_MAX_CHARS;
	if (fields.maxchars !== undefined) {
		maxChars = Number(unquote(fields.maxchars));
		if (!Number.isInteger(maxChars) || maxChars <= 0) return { kind: "invalid", reason: "maxChars must be a positive integer" };
	}
	const options = parseOptions(fields);
	if (options.kind === "invalid") return options;
	const label = basename(path)
		.replace(/^TURN-JUDGE-/i, "")
		.replace(/\.md$/i, "");
	return {
		kind: "ok",
		spec: {
			name: fields.name ? unquote(fields.name) : label,
			filePath: path,
			question,
			options: options.options,
			maxChars,
		},
	};
}

// --- turn state ---------------------------------------------------------------

/** The human's prompts and the model's text on the branch before the judged message, oldest first. */
function historyBefore(ctx: ExtensionContext, judgedTimestamp: number): HistoryLine[] {
	const lines: HistoryLine[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.timestamp >= judgedTimestamp) break;
		if (message.role === "user") {
			if (message.attribution !== "user" || message.synthetic === true) continue;
			const text = textOf(message.content, "\n").trim();
			if (text !== "") lines.push({ 角色: "用户", 内容: text });
		} else if (message.role === "assistant") {
			const text = textOf(message.content, "\n").trim();
			if (text !== "") lines.push({ 角色: "模型", 内容: text });
		}
	}
	return lines;
}

/** Keep the newest whole entries whose total length fits `maxChars`. */
function fitHistory(lines: readonly HistoryLine[], maxChars: number): HistoryLine[] {
	const kept: HistoryLine[] = [];
	let used = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line === undefined) continue;
		used += line.内容.length;
		if (used > maxChars) break;
		kept.push(line);
	}
	return kept.reverse();
}

// --- judging --------------------------------------------------------------------

async function runJudge(judge: Judge, spec: TurnJudgeSpec, state: TurnState): Promise<JudgeResult> {
	const signal = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
	try {
		const criteria: Record<string, string | null> = {};
		for (const option of spec.options) criteria[option.label] = option.criteria;
		const result = await judge.judge(
			{
				state,
				questions: { turn: { type: "choice", instructions: spec.question, criteria } },
			},
			{ signal },
		);
		const answer = result.answers.turn;
		return { kind: "ok", verdict: { choice: answer.choice, probabilities: answer.probabilities } };
	} catch (error) {
		return { kind: "failed", reason: errorText(error) };
	}
}

/** The prompt option with the highest probability at or above its threshold, else info. */
function decide(spec: TurnJudgeSpec, verdict: Verdict): Action {
	let best: Action = { kind: "info" };
	for (const option of spec.options) {
		if (option.outcome.kind !== "prompt") continue;
		const p = verdict.probabilities[option.label] ?? 0;
		if (p < option.outcome.threshold) continue;
		if (best.kind === "prompt" && best.probability >= p) continue;
		best = { kind: "prompt", option: option.label, probability: p, prompt: option.outcome.prompt };
	}
	return best;
}

function describeVerdict(spec: TurnJudgeSpec, verdict: Verdict): string {
	const parts = spec.options.map((o) => `${o.label} ${(verdict.probabilities[o.label] ?? 0).toFixed(2)}`);
	return `turn-judge ${spec.name}：${verdict.choice}（${parts.join(" · ")}）`;
}

// --- extension --------------------------------------------------------------------

/** What one judgment leaves for the turn's notification. */
type Report =
	| { readonly kind: "info"; readonly line: string }
	| { readonly kind: "warning"; readonly line: string }
	| { readonly kind: "sent" };

export default function turnJudge(pi: ExtensionAPI): void {
	/** Bumped by every human prompt and session move; a verdict from an older epoch is shown, never typed. */
	let epoch = 0;
	/** `path\0reason` of invalid files already reported, so a broken file warns once per process. */
	const warnedFiles = new Set<string>();

	const notify = (ctx: ExtensionContext, text: string, level: "info" | "warning"): void => {
		if (ctx.hasUI) ctx.ui.notify(text, level);
		if (level === "warning") pi.logger.warn(text);
		else pi.logger.info(text);
	};

	const judgeOne = async (
		ctx: ExtensionContext,
		judge: Judge,
		spec: TurnJudgeSpec,
		history: readonly HistoryLine[],
		reply: string,
		startedAt: number,
	): Promise<Report> => {
		const result = await runJudge(judge, spec, { 过去的记录: fitHistory(history, spec.maxChars), 本轮回复: reply });
		switch (result.kind) {
			case "failed":
				return { kind: "warning", line: `turn-judge ${spec.name}：判断失败（${result.reason}）` };
			case "ok":
				break;
			default: {
				const unreachable: never = result;
				return unreachable;
			}
		}
		const action = decide(spec, result.verdict);
		switch (action.kind) {
			case "info":
				return { kind: "info", line: describeVerdict(spec, result.verdict) };
			case "prompt":
				if (epoch !== startedAt) {
					return { kind: "info", line: `${describeVerdict(spec, result.verdict)}；判断返回前已有新输入，未发送 prompt` };
				}
				pi.logger.info(`${describeVerdict(spec, result.verdict)} → prompt`);
				pi.sendUserMessage(action.prompt, ctx.isIdle() ? { attribution: "agent" } : { deliverAs: "followUp", attribution: "agent" });
				return { kind: "sent" };
			default: {
				const unreachable: never = action;
				return unreachable;
			}
		}
	};

	pi.on("input", (event) => {
		if (event.source !== "extension") epoch += 1;
	});
	pi.on("session_switch", () => {
		epoch += 1;
	});
	pi.on("session_branch", () => {
		epoch += 1;
	});
	pi.on("session_tree", () => {
		epoch += 1;
	});

	pi.on("message_end", async (event, ctx) => {
		try {
			if (ctx.agent.kind !== "main") return;
			const message = event.message;
			if (message.role !== "assistant" || message.stopReason !== "stop") return;
			const reply = textOf(message.content, "\n").trim();
			if (reply === "") return;
			const specs: TurnJudgeSpec[] = [];
			const fileWarnings: string[] = [];
			for (const path of discoverSpecFiles(FILE_PATTERN, import.meta.dir, ctx.cwd)) {
				const parsed = parseSpecFile(path);
				switch (parsed.kind) {
					case "ok":
						specs.push(parsed.spec);
						break;
					case "disabled":
						break;
					case "invalid": {
						const key = `${path}\0${parsed.reason}`;
						if (warnedFiles.has(key)) break;
						warnedFiles.add(key);
						fileWarnings.push(`turn-judge: 跳过 ${path}：${parsed.reason}`);
						break;
					}
					default: {
						const unreachable: never = parsed;
						return unreachable;
					}
				}
			}
			if (fileWarnings.length > 0) notify(ctx, fileWarnings.join("\n"), "warning");
			if (specs.length === 0) return;
			const history = historyBefore(ctx, message.timestamp);
			const startedAt = epoch;
			const opened = await openNativeJudge(ctx);
			if (opened.kind === "inactive") return;
			// One notification per turn: consecutive UI notifications replace each other.
			void Promise.all(specs.map((spec) => judgeOne(ctx, opened.judge, spec, history, reply, startedAt)))
				.then((reports) => {
					const warnings = reports.flatMap((r) => (r.kind === "warning" ? [r.line] : []));
					const infos = reports.flatMap((r) => (r.kind === "info" ? [r.line] : []));
					if (warnings.length > 0) notify(ctx, warnings.join("\n"), "warning");
					if (infos.length > 0) notify(ctx, infos.join("\n"), "info");
				})
				.catch((error) => {
					pi.logger.warn("turn-judge: message_end failed", { error: errorText(error) });
				});
		} catch (error) {
			pi.logger.warn("turn-judge: message_end failed", { error: errorText(error) });
		}
	});
}

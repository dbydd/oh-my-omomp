import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { NativeJudge, isJudgmentApi } from "@oh-my-pi/pi-ai";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// ============================================================================
// turn-judge — after every main-session turn, ask a native judge (Jev) one
// question per `TURN-JUDGE-*.md` file about that turn, then either show the
// verdict or type the configured prompt.
//
// FILE FORMAT. `TURN-JUDGE-<label>.md`, discovered like `WATCHDOG-*.md`:
//   - user level:  <agent dir>/TURN-JUDGE-*.md          (~/.omp/agent by default)
//   - repo level:  <dir>/TURN-JUDGE-*.md and <dir>/.omp/TURN-JUDGE-*.md,
//                  walking from cwd up to the git root.
// Frontmatter (between `---` fences), one `key: value` per line; whole-line `#`
// comments are skipped. Keys are lowercased.
//   judge:   commandcode/typesafe/jev   # required: provider/model of a judgment-API model
//   name:    甩锅                        # optional; defaults to the file label
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
// OUTCOME. Jev answers one choice question with a probability per option.
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
// FAILURE POLICY. A failed or unavailable judge request shows a warning for
// that turn; an invalid file warns once per process (per reason). Headless
// sessions only log. Nothing blocks or changes the turn.
// ============================================================================

const FILE_PATTERN = /^TURN-JUDGE-.+\.md$/i;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const OPTION_KEY = /^option\.([^.\s]+)(?:\.(prompt|threshold))?$/;
const DEFAULT_MAX_CHARS = 30_000;
const JUDGE_TIMEOUT_MS = 90_000;

type Outcome =
	| { readonly kind: "info" }
	| { readonly kind: "prompt"; readonly prompt: string; readonly threshold: number };

type JudgeOption = { readonly label: string; readonly criteria: string | null; readonly outcome: Outcome };

type TurnJudgeSpec = {
	readonly name: string;
	readonly filePath: string;
	readonly judge: { readonly provider: string; readonly modelId: string };
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

type JudgeResult =
	| { readonly kind: "ok"; readonly verdict: Verdict }
	| { readonly kind: "failed"; readonly reason: string };

type Action =
	| { readonly kind: "prompt"; readonly option: string; readonly probability: number; readonly prompt: string }
	| { readonly kind: "info" };

// --- discovery + parsing ----------------------------------------------------

function agentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	if (override) return override;
	return join(homedir(), ".omp", "agent");
}

/** User agent dir + every dir from cwd up to (and including) the git root, plus each `.omp`. */
function discoverFiles(cwd: string): string[] {
	const dirs: string[] = [agentDir()];
	const home = homedir();
	let dir = resolve(cwd);
	for (;;) {
		dirs.push(dir, join(dir, ".omp"));
		if (existsSync(join(dir, ".git"))) break;
		const parent = dirname(dir);
		if (parent === dir || dir === home) break;
		dir = parent;
	}
	const files: string[] = [];
	const seen = new Set<string>();
	for (const d of dirs) {
		let names: string[];
		try {
			names = readdirSync(d);
		} catch {
			continue;
		}
		for (const n of names.sort()) {
			if (!FILE_PATTERN.test(n)) continue;
			const p = join(d, n);
			if (seen.has(p)) continue;
			seen.add(p);
			files.push(p);
		}
	}
	return files;
}

function unquote(value: string): string {
	return value.trim().replace(/^["']|["']$/g, "").trim();
}

function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } | null {
	const m = raw.match(FRONTMATTER_PATTERN);
	if (!m) return null;
	const fields: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const t = line.trim();
		if (t === "" || t.startsWith("#")) continue;
		const idx = t.indexOf(":");
		if (idx <= 0) continue;
		fields[t.slice(0, idx).trim().toLowerCase()] = t.slice(idx + 1).trim();
	}
	return { fields, body: raw.slice(m[0].length) };
}

type OptionsParse =
	| { readonly kind: "ok"; readonly options: readonly JudgeOption[] }
	| { readonly kind: "invalid"; readonly reason: string };

/** Collect flat `option.<label>[.prompt|.threshold]` keys into options, in declaration order. */
function parseOptions(fields: Record<string, string>): OptionsParse {
	const criteria = new Map<string, string | null>();
	const prompts = new Map<string, string>();
	const thresholds = new Map<string, string>();
	for (const [key, raw] of Object.entries(fields)) {
		const m = key.match(OPTION_KEY);
		if (!m) continue;
		const value = unquote(raw);
		switch (m[2]) {
			case undefined:
				criteria.set(m[1], value || null);
				break;
			case "prompt":
				if (!value) return { kind: "invalid", reason: `option.${m[1]}.prompt is empty` };
				prompts.set(m[1], value);
				break;
			case "threshold":
				thresholds.set(m[1], value);
				break;
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
	const judge = unquote(fields.judge ?? "");
	const slash = judge.indexOf("/");
	if (slash <= 0 || slash === judge.length - 1) return { kind: "invalid", reason: "judge must be provider/model" };
	const question = body.trim();
	if (question === "") return { kind: "invalid", reason: "empty body (the body is the question)" };
	let maxChars = DEFAULT_MAX_CHARS;
	if (fields.maxchars !== undefined) {
		maxChars = Number(unquote(fields.maxchars));
		if (!Number.isInteger(maxChars) || maxChars <= 0) return { kind: "invalid", reason: "maxChars must be a positive integer" };
	}
	const options = parseOptions(fields);
	if (options.kind === "invalid") return options;
	const label = basename(path).replace(/^TURN-JUDGE-/i, "").replace(/\.md$/i, "");
	return {
		kind: "ok",
		spec: {
			name: fields.name ? unquote(fields.name) : label,
			filePath: path,
			judge: { provider: judge.slice(0, slash), modelId: judge.slice(slash + 1) },
			question,
			options: options.options,
			maxChars,
		},
	};
}

// --- turn state ---------------------------------------------------------------

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const block of content) {
		if (typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string") {
			texts.push(block.text);
		}
	}
	return texts.join("\n");
}

/** The human's prompts and the model's text on the branch before the judged message, oldest first. */
function historyBefore(ctx: ExtensionContext, judgedTimestamp: number): HistoryLine[] {
	const lines: HistoryLine[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.timestamp >= judgedTimestamp) break;
		if (message.role === "user") {
			if (message.attribution !== "user" || message.synthetic === true) continue;
			const text = messageText(message.content).trim();
			if (text !== "") lines.push({ 角色: "用户", 内容: text });
		} else if (message.role === "assistant") {
			const text = messageText(message.content).trim();
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
		used += lines[i].内容.length;
		if (used > maxChars) break;
		kept.push(lines[i]);
	}
	return kept.reverse();
}

// --- judging --------------------------------------------------------------------

async function runJudge(ctx: ExtensionContext, spec: TurnJudgeSpec, state: TurnState): Promise<JudgeResult> {
	const model = ctx.modelRegistry.getAvailable("all").find(
		candidate => candidate.provider === spec.judge.provider && candidate.id === spec.judge.modelId,
	);
	if (!model) return { kind: "failed", reason: `judge ${spec.judge.provider}/${spec.judge.modelId} not found` };
	if (!isJudgmentApi(model.api)) return { kind: "failed", reason: `judge ${spec.judge.provider}/${spec.judge.modelId} has no judgment API (${model.api})` };
	const signal = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
	try {
		const sessionId = ctx.sessionManager.getSessionId();
		const apiKey = await ctx.modelRegistry.getApiKey(model, sessionId, { signal });
		if (!apiKey) return { kind: "failed", reason: "judge credentials unavailable" };
		const headers = await ctx.modelRegistry.resolveModelHeaders(model, signal);
		const judge = new NativeJudge({
			apiKey: ctx.modelRegistry.resolver(model, sessionId),
			api: model.api,
			provider: model.provider,
			model: model.id,
			baseUrl: model.baseUrl,
			headers,
		});
		const criteria: Record<string, string | null> = {};
		for (const option of spec.options) criteria[option.label] = option.criteria;
		const result = await judge.judge({
			state,
			questions: { turn: { type: "choice", instructions: spec.question, criteria } },
		}, { signal });
		const answer = result.answers.turn;
		return { kind: "ok", verdict: { choice: answer.choice, probabilities: answer.probabilities } };
	} catch (error) {
		return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
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
	const parts = spec.options.map(o => `${o.label} ${(verdict.probabilities[o.label] ?? 0).toFixed(2)}`);
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

	const judgeOne = async (ctx: ExtensionContext, spec: TurnJudgeSpec, history: readonly HistoryLine[], reply: string, startedAt: number): Promise<Report> => {
		const result = await runJudge(ctx, spec, { 过去的记录: fitHistory(history, spec.maxChars), 本轮回复: reply });
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

	pi.on("input", event => {
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

	pi.on("message_end", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const message = event.message;
		if (message.role !== "assistant" || message.stopReason !== "stop") return;
		const reply = messageText(message.content).trim();
		if (reply === "") return;
		const specs: TurnJudgeSpec[] = [];
		const fileWarnings: string[] = [];
		for (const path of discoverFiles(ctx.cwd)) {
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
		// One notification per turn: consecutive UI notifications replace each other.
		void Promise.all(specs.map(spec => judgeOne(ctx, spec, history, reply, startedAt))).then(reports => {
			const warnings = reports.flatMap(r => (r.kind === "warning" ? [r.line] : []));
			const infos = reports.flatMap(r => (r.kind === "info" ? [r.line] : []));
			if (warnings.length > 0) notify(ctx, warnings.join("\n"), "warning");
			if (infos.length > 0) notify(ctx, infos.join("\n"), "info");
		});
	});
}

// ============================================================================
// system-prompt-replace — text replacement over the final system prompt.
//
// WHY THIS EXISTS. OMP bundles its built-in prompt templates (tool
// descriptions included) into the binary, and offers no override directory.
// For Anthropic models the built-in tool descriptions are rendered into the
// system prompt, so a sentence there that contradicts APPEND_SYSTEM.md (the
// `task` tool's "Omit `agent` only for default ...; NEVER specify it.") can
// only be changed by rewriting the system prompt text.
//
// ORDER. `before_agent_start` handlers run one extension after another in
// load order, each receiving the prompt the previous one returned. Load order
// is: native discovery (`<agent dir>/extensions/`, settings.json `extensions`),
// then hooks, then plugin extensions, then CLI `-e` paths, then config.yml
// `extensions` in list order, then OMP's inline factories (SDK-supplied
// extensions, autoresearch, the custom-tools wrapper). This file therefore
// lives outside `<agent dir>/extensions/` and is registered as the LAST
// config.yml `extensions` entry, so it sees every path-loaded extension's
// additions. Inline factories still run after it; autoresearch rewrites the
// prompt only in autoresearch mode. Placing this file in `extensions/` would
// load it with the native batch, and the config entry would be dropped as a
// duplicate path.
//
// FILE. `system-prompt-replace.json` beside this module, resolved through
// import.meta.dir (including named profiles):
//
//   { "replacements": [
//       { "literal": "exact text", "replace": "new text" },
//       { "regex": "JS regex source", "replace": "new text, $1 allowed" }
//   ] }
//
// Each rule sets exactly one of `literal` / `regex`, plus `replace`. A literal
// replaces every occurrence verbatim (no `$` handling). A regex is compiled
// with the `g` flag and uses String.prototype.replace substitution patterns.
// Rules apply in file order, each to the output of the previous one, across
// every system-prompt block.
//
// TIMING. Every `before_agent_start`, in the main session and in every
// subagent. The file is re-read per prompt, so edits apply from the next
// prompt without restart.
//
// FAILURE POLICY. A missing file means no replacement. A malformed file
// degrades to no replacement plus a log warning, repeated only when the error
// changes or a valid read intervened. A rule
// whose target is absent from the main session's system prompt (template drift
// after an OMP upgrade, or a typo) raises a visible warning — UI notification,
// or stderr when headless — plus a log warning, once per rule per process.
// Subagents are not checked: their prompts legitimately lack text such as the
// `task` tool description. The prompt is never blocked.
// ============================================================================

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ExtensionAPI, z } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../../extensions/_shared/errors.ts";

const FILE_NAME = "system-prompt-replace.json";

// Keep validation sequential so the first failure retains the original reason.
const objectSchema = z.record(z.string(), z.unknown()).refine((value) => !Array.isArray(value));
const replacementsSchema = z.array(z.unknown());
const replacementSchema = z.string();
const matcherSchema = z.string().min(1);

type Matcher = { readonly kind: "literal"; readonly text: string } | { readonly kind: "regex"; readonly pattern: RegExp };

interface Rule {
	readonly label: string;
	readonly matcher: Matcher;
	readonly replace: string;
}

type Parsed = { readonly kind: "ok"; readonly rules: readonly Rule[] } | { readonly kind: "invalid"; readonly reason: string };

type RuleParse = { readonly kind: "ok"; readonly rule: Rule } | { readonly kind: "invalid"; readonly reason: string };

/** Rules already reported as missing their target, shared by every session in this process. */
const reportedMisses = new Set<string>();

function parseRule(value: unknown, index: number): RuleParse {
	const at = `replacements[${index}]`;
	const object = objectSchema.safeParse(value);
	if (!object.success) {
		return { kind: "invalid", reason: `${at} is not an object` };
	}
	const record = object.data;
	const unknownKey = Object.keys(record).find((key) => key !== "literal" && key !== "regex" && key !== "replace");
	if (unknownKey !== undefined) return { kind: "invalid", reason: `${at}: unknown key \`${unknownKey}\`` };
	const replacement = replacementSchema.safeParse(record.replace);
	if (!replacement.success) return { kind: "invalid", reason: `${at}: \`replace\` must be a string` };
	const { literal, regex } = record;
	if ((literal === undefined) === (regex === undefined)) {
		return { kind: "invalid", reason: `${at}: set exactly one of \`literal\` and \`regex\`` };
	}
	if (literal !== undefined) {
		const text = matcherSchema.safeParse(literal);
		if (!text.success) {
			return { kind: "invalid", reason: `${at}: \`literal\` must be a non-empty string` };
		}
		return {
			kind: "ok",
			rule: {
				label: `${at} literal ${JSON.stringify(text.data)}`,
				matcher: { kind: "literal", text: text.data },
				replace: replacement.data,
			},
		};
	}
	const expression = matcherSchema.safeParse(regex);
	if (!expression.success) {
		return { kind: "invalid", reason: `${at}: \`regex\` must be a non-empty string` };
	}
	let pattern: RegExp;
	try {
		pattern = new RegExp(expression.data, "g");
	} catch (error) {
		return { kind: "invalid", reason: `${at}: invalid regex: ${errorText(error)}` };
	}
	return {
		kind: "ok",
		rule: { label: `${at} regex /${expression.data}/`, matcher: { kind: "regex", pattern }, replace: replacement.data },
	};
}

function parseFile(source: string): Parsed {
	let json: unknown;
	try {
		json = JSON.parse(source);
	} catch (error) {
		return { kind: "invalid", reason: `invalid JSON: ${errorText(error)}` };
	}
	const object = objectSchema.safeParse(json);
	if (!object.success) {
		return { kind: "invalid", reason: "top level must be an object" };
	}
	const record = object.data;
	const unknownKey = Object.keys(record).find((key) => key !== "replacements");
	if (unknownKey !== undefined) return { kind: "invalid", reason: `unknown key \`${unknownKey}\`` };
	const replacements = replacementsSchema.safeParse(record.replacements);
	if (!replacements.success) return { kind: "invalid", reason: "`replacements` must be an array" };
	const rules: Rule[] = [];
	for (const [index, value] of replacements.data.entries()) {
		const parsed = parseRule(value, index);
		if (parsed.kind === "invalid") return parsed;
		rules.push(parsed.rule);
	}
	return { kind: "ok", rules };
}

export default function systemPromptReplace(pi: ExtensionAPI): void {
	/** Last parse failure already logged, so a broken file warns once per reason. */
	let warnedReason: string | null = null;

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const file = join(import.meta.dir, FILE_NAME);
			let source: string;
			try {
				source = await readFile(file, "utf8");
			} catch (error) {
				if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
				pi.logger.warn(`system-prompt-replace: cannot read ${file}: ${errorText(error)}`);
				return;
			}
			const parsed = parseFile(source);
			if (parsed.kind === "invalid") {
				if (warnedReason !== parsed.reason) {
					warnedReason = parsed.reason;
					pi.logger.warn(`system-prompt-replace: ${file}: ${parsed.reason}; not replacing`);
				}
				return;
			}
			warnedReason = null;

			let blocks = event.systemPrompt;
			let changed = false;
			for (const rule of parsed.rules) {
				let hits = 0;
				const matcher = rule.matcher;
				blocks = blocks.map((block) => {
					switch (matcher.kind) {
						case "literal": {
							const pieces = block.split(matcher.text);
							hits += pieces.length - 1;
							return pieces.join(rule.replace);
						}
						case "regex": {
							const count = block.match(matcher.pattern)?.length ?? 0;
							hits += count;
							return count === 0 ? block : block.replace(matcher.pattern, rule.replace);
						}
						default: {
							const unreachable: never = matcher;
							return unreachable;
						}
					}
				});
				if (hits > 0) {
					changed = true;
				} else if (ctx.agent.kind === "main" && !reportedMisses.has(rule.label)) {
					reportedMisses.add(rule.label);
					const notice = `system-prompt-replace: ${rule.label} found no target in the system prompt; update ${file}`;
					pi.logger.warn(notice);
					if (ctx.hasUI) ctx.ui.notify(notice, "warning");
					else process.stderr.write(`${notice}\n`);
				}
			}
			if (!changed) return;
			return { systemPrompt: blocks };
		} catch (error) {
			pi.logger.warn("system-prompt-replace: before_agent_start failed", { error: errorText(error) });
		}
	});
}

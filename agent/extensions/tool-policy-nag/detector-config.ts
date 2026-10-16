/**
 * Lane configuration for tool-policy-nag: the `tool-policy-nag` section of
 * omomp.* (the project's `.omp/` copy wins over the agent-dir copy; invalid
 * copies warn and fall through), read at every watched call.
 *
 * Three lanes, independently switchable — two ask whether a built-in tool
 * should have done the work, the third asks whether the call's side effects can
 * be read off the call at all:
 *
 * - `form` — the deterministic string lane (`heuristic.ts`): parses the command
 *   and counts the operations a built-in tool covers.
 * - `intent` — the intent lane (`intent.ts`): asks OMP's native JUDGE one
 *   `choice` question about what the call is trying to accomplish.
 * - `risk` — the risk lane (`risk.ts`): flags a long chain that both reads and
 *   writes, whose side-effect surface is unreadable. No judge.
 *
 *   { "form": { "detector": "heuristic" },
 *     "intent": { "threshold": 0.5 },
 *     "risk": { "minCommands": 4, "minChars": 600 } }
 *
 * `null` turns a lane off explicitly. The older single-detector shape is still
 * read, but only when no new block is present: `{"detector":"heuristic"}` means
 * form only, and `{"detector":"jev","threshold":…}` means intent only.
 * A missing `risk` block leaves that lane off; missing or unusable configuration
 * leaves the form lane on, as before.
 */
import { z } from "@oh-my-pi/pi-coding-agent";
import { defineOmompSection, loadOmompSection } from "../_shared/omomp.ts";
import type { RiskConfig } from "./risk.ts";

/** The deterministic string lane. */
export type FormLane = { readonly kind: "heuristic" };

/** The intent lane: one judged choice question per watched call. */
export type IntentLane = {
	readonly kind: "jev";
	readonly threshold: number;
};

/** The risk lane: deterministic, for calls whose side-effect surface is unreadable. */
export type RiskLane = { readonly kind: "risk" } & RiskConfig;

export type Lanes = {
	readonly form: FormLane | null;
	readonly intent: IntentLane | null;
	readonly risk: RiskLane | null;
};

const FORM: FormLane = { kind: "heuristic" };
/** No configuration, or unusable configuration: the string lane alone. */
const DEFAULT_LANES: Lanes = { form: FORM, intent: null, risk: null };

const thresholdSchema = z.number().refine((value) => value > 0 && value <= 1, "threshold must be a number in (0, 1]");
const positiveCount = (label: string) =>
	z.number().refine((value) => Number.isInteger(value) && value > 0, `${label} must be a positive integer`);
const intentBlock = z.object({ threshold: thresholdSchema });
const formBlock = z.object({ detector: z.literal("heuristic") });
const riskBlock = z.object({
	minCommands: positiveCount("minCommands"),
	minChars: positiveCount("minChars"),
	minPrograms: positiveCount("minPrograms"),
});

const lanesSchema = z.object({
	form: formBlock.nullable().optional(),
	intent: intentBlock.nullable().optional(),
	risk: riskBlock.nullable().optional(),
	detector: z.enum(["heuristic", "jev"]).optional(),
	threshold: thresholdSchema.optional(),
});

const omompSection = defineOmompSection(import.meta.dir, lanesSchema);

function lanesOf(value: z.infer<typeof lanesSchema>): Lanes {
	if (value.form !== undefined || value.intent !== undefined || value.risk !== undefined) {
		const intent = value.intent ?? undefined;
		const risk = value.risk ?? undefined;
		return {
			form: value.form == null ? null : FORM,
			intent: intent == null ? null : { kind: "jev", threshold: intent.threshold },
			risk: risk == null ? null : { kind: "risk", minCommands: risk.minCommands, minChars: risk.minChars, minPrograms: risk.minPrograms },
		};
	}
	switch (value.detector) {
		case "heuristic":
			return { ...DEFAULT_LANES, form: FORM };
		case "jev": {
			if (value.threshold === undefined) return DEFAULT_LANES;
			return { form: null, intent: { kind: "jev", threshold: value.threshold }, risk: null };
		}
		default:
			return DEFAULT_LANES;
	}
}

/** Re-read every watched call; the project's omomp section overrides the agent-dir one. */
export function loadLanes(cwd: string): { readonly lanes: Lanes; readonly warnings: readonly string[] } {
	const loaded = loadOmompSection(omompSection, cwd);
	const warnings = loaded.skipped.map(({ path, reason }) => `tool-policy-nag: 跳过 ${path}：${reason}`);
	switch (loaded.kind) {
		case "found":
			return { lanes: lanesOf(loaded.value), warnings };
		case "none":
			return { lanes: DEFAULT_LANES, warnings };
		default: {
			const unreachable: never = loaded;
			return unreachable;
		}
	}
}

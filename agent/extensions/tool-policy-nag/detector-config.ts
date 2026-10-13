/**
 * Lane configuration for tool-policy-nag, read from `tool-policy-nag.json`
 * (a cwd copy wins over the one beside this extension; invalid copies warn and
 * fall through) at every watched call.
 *
 * Two lanes, independently switchable:
 *
 * - `form` — the deterministic string lane (`heuristic.ts`): parses the command
 *   and counts the operations a built-in tool covers.
 * - `intent` — the intent lane (`intent.ts`): asks a judgment model one
 *   `choice` question about what the call is trying to accomplish.
 *
 *   { "form": { "detector": "heuristic" }, "intent": { "judge": "provider/model", "threshold": 0.5 } }
 *
 * `null` turns a lane off explicitly. The older single-detector shape is still
 * read, but only when neither `form` nor `intent` is present:
 * `{"detector":"heuristic"}` means form only, and
 * `{"detector":"jev","judge":…,"threshold":…}` means intent only. Missing or
 * unusable configuration leaves the form lane on, as before.
 */
import { z } from "@oh-my-pi/pi-coding-agent";
import { loadJsonConfig } from "../_shared/config.ts";

/** The deterministic string lane. */
export type FormLane = { readonly kind: "heuristic" };

/** The intent lane: one judged choice question per watched call. */
export type IntentLane = {
	readonly kind: "jev";
	readonly judge: { readonly provider: string; readonly modelId: string };
	readonly threshold: number;
};

export type Lanes = {
	readonly form: FormLane | null;
	readonly intent: IntentLane | null;
};

const FORM: FormLane = { kind: "heuristic" };
/** No configuration, or unusable configuration: the string lane alone. */
const DEFAULT_LANES: Lanes = { form: FORM, intent: null };

const judgeSchema = z
	.string()
	.transform((value) => value.trim())
	.refine((value) => {
		const slash = value.indexOf("/");
		return slash > 0 && slash < value.length - 1;
	}, "judge must be provider/model")
	.transform((value) => {
		const slash = value.indexOf("/");
		return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
	});
const thresholdSchema = z.number().refine((value) => value > 0 && value <= 1, "threshold must be a number in (0, 1]");
const intentBlock = z.object({ judge: judgeSchema, threshold: thresholdSchema });
const formBlock = z.object({ detector: z.literal("heuristic") });

const lanesSchema = z.object({
	form: formBlock.nullable().optional(),
	intent: intentBlock.nullable().optional(),
	detector: z.enum(["heuristic", "jev"]).optional(),
	judge: judgeSchema.optional(),
	threshold: thresholdSchema.optional(),
});

function lanesOf(value: z.infer<typeof lanesSchema>): Lanes {
	if (value.form !== undefined || value.intent !== undefined) {
		const intent = value.intent ?? undefined;
		return {
			form: value.form == null ? null : FORM,
			intent: intent == null ? null : { kind: "jev", judge: intent.judge, threshold: intent.threshold },
		};
	}
	switch (value.detector) {
		case "heuristic":
			return { form: FORM, intent: null };
		case "jev": {
			if (value.judge === undefined || value.threshold === undefined) return DEFAULT_LANES;
			return { form: null, intent: { kind: "jev", judge: value.judge, threshold: value.threshold } };
		}
		default:
			return DEFAULT_LANES;
	}
}

/** Re-read every watched call; cwd overrides the shipped copy, invalid copies warn and fall through. */
export function loadLanes(cwd: string): { readonly lanes: Lanes; readonly warnings: readonly string[] } {
	const loaded = loadJsonConfig("tool-policy-nag.json", lanesSchema, [cwd, import.meta.dir]);
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

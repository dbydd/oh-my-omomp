import { z } from "@oh-my-pi/pi-coding-agent";
import { loadJsonConfig } from "../_shared/config.ts";

export type JevDetector = {
	readonly kind: "jev";
	readonly judge: { readonly provider: string; readonly modelId: string };
	readonly threshold: number;
};
type Detector = { readonly kind: "heuristic" } | JevDetector;
const HEURISTIC: Detector = { kind: "heuristic" };
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
const detectorSchema = z.union([
	z.object({ detector: z.literal("heuristic") }).transform((): Detector => HEURISTIC),
	z
		.object({
			detector: z.literal("jev"),
			judge: judgeSchema,
			threshold: z.number().refine((value) => value > 0 && value <= 1, "threshold must be a number in (0, 1]"),
		})
		.transform((value): Detector => ({ kind: "jev", judge: value.judge, threshold: value.threshold })),
]);

/** Re-read every watched call; cwd overrides the shipped copy, invalid copies warn and fall through. */
export function loadDetector(cwd: string): { readonly detector: Detector; readonly warnings: readonly string[] } {
	const loaded = loadJsonConfig("tool-policy-nag.json", detectorSchema, [cwd, import.meta.dir]);
	const warnings = loaded.skipped.map(({ path, reason }) => `tool-policy-nag: 跳过 ${path}：${reason}`);
	switch (loaded.kind) {
		case "found":
			return { detector: loaded.value, warnings };
		case "none":
			return { detector: HEURISTIC, warnings };
		default: {
			const unreachable: never = loaded;
			return unreachable;
		}
	}
}

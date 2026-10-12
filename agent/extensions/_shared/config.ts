import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { zod } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "./errors.ts";

export type ConfigProblem = { readonly path: string; readonly reason: string };

export type ConfigLoad<T> =
	| { readonly kind: "found"; readonly value: T; readonly path: string; readonly skipped: readonly ConfigProblem[] }
	| { readonly kind: "none"; readonly skipped: readonly ConfigProblem[] };

/**
 * Load `fileName` from the first of `dirs` that holds a valid copy. A missing
 * copy is passed over silently; an unreadable or invalid one is recorded in
 * `skipped` and the next directory is tried. Extensions pass
 * `[ctx.cwd, import.meta.dir]`: a project copy wins over the one shipped with
 * the extension.
 */
export function loadJsonConfig<T>(fileName: string, schema: zod.ZodLikeSchema<T>, dirs: readonly string[]): ConfigLoad<T> {
	const skipped: ConfigProblem[] = [];
	for (const dir of dirs) {
		const path = join(dir, fileName);
		if (!existsSync(path)) continue;
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			skipped.push({ path, reason: errorText(error) });
			continue;
		}
		const parsed = schema.safeParse(raw);
		if (parsed.success) return { kind: "found", value: parsed.data, path, skipped };
		skipped.push({ path, reason: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ") });
	}
	return { kind: "none", skipped };
}

import type { Api, Model as HostModel } from "@oh-my-pi/pi-ai";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog";
import type { CreateAgentSessionOptions, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export type Model = HostModel<Api>;
/** A thinking level a helper session accepts. */
export type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

/**
 * `provider/id:level` → base and level. A level is `off` or one of the host's
 * efforts (minimal … max); a missing suffix, or any other (`auto`, `inherit`),
 * leaves the spec whole.
 */
export function splitLevel(spec: string): { readonly base: string; readonly level: ThinkingLevel | undefined } {
	const trimmed = spec.trim();
	const colon = trimmed.lastIndexOf(":");
	if (colon > 0) {
		const suffix = trimmed.slice(colon + 1);
		// The host's own effort values, so the level is typed without a cast; `off` is not an effort.
		const level = suffix === "off" ? "off" : THINKING_EFFORTS.find((effort) => effort === suffix);
		if (level !== undefined) return { base: trimmed.slice(0, colon), level };
	}
	return { base: trimmed, level: undefined };
}

/** A role alias or pattern through the host resolver, else an available `provider/id`, else a bare id. */
export function findModel(ctx: ExtensionContext, base: string): Model | undefined {
	const resolved = ctx.models?.resolve?.(base);
	if (resolved) return resolved;
	const available = ctx.modelRegistry.getAvailable();
	return available.find((model) => `${model.provider}/${model.id}` === base) ?? available.find((model) => model.id === base);
}

export type ModelChoice = { readonly model: Model; readonly level: ThinkingLevel | undefined; readonly spec: string };

/**
 * The first entry of a comma-separated `provider/id[:level]` chain that names
 * an available model. Registry lookup only; no request is sent.
 */
export function resolveModelChain(ctx: ExtensionContext, chain: string): ModelChoice | undefined {
	for (const spec of chain
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "")) {
		const { base, level } = splitLevel(spec);
		const model = findModel(ctx, base);
		if (model) return { model, level, spec };
	}
	return undefined;
}

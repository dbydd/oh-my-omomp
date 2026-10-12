import { type Api, isJudgmentApi, type Model, NativeJudge } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "./errors.ts";

export type JudgeRef = { readonly provider: string; readonly modelId: string };

export type JudgeModel = Model<Api>;

export type JudgeOpen =
	| { readonly kind: "ready"; readonly judge: NativeJudge; readonly model: JudgeModel }
	| { readonly kind: "unavailable"; readonly reason: string };

/**
 * A NativeJudge for `ref` with this session's credentials and headers. Never
 * throws. The model is matched by judgment API, not catalog kind: a custom
 * `models.yml` provider declared with `api: typesafe` keeps the default `chat`
 * kind unless the provider is named `typesafe`.
 */
export async function openNativeJudge(ctx: ExtensionContext, ref: JudgeRef, signal: AbortSignal): Promise<JudgeOpen> {
	const label = `${ref.provider}/${ref.modelId}`;
	const model = ctx.modelRegistry
		.getAvailable("all")
		.find((candidate) => candidate.provider === ref.provider && candidate.id === ref.modelId);
	if (!model) return { kind: "unavailable", reason: `judge ${label} not found` };
	if (!isJudgmentApi(model.api)) return { kind: "unavailable", reason: `judge ${label} has no judgment API (${model.api})` };
	try {
		const sessionId = ctx.sessionManager.getSessionId();
		const apiKey = await ctx.modelRegistry.getApiKey(model, sessionId, { signal });
		if (!apiKey) return { kind: "unavailable", reason: `judge ${label}: credentials unavailable` };
		const headers = await ctx.modelRegistry.resolveModelHeaders(model, signal);
		const judge = new NativeJudge({
			apiKey: ctx.modelRegistry.resolver(model, sessionId),
			api: model.api,
			provider: model.provider,
			model: model.id,
			baseUrl: model.baseUrl,
			headers,
		});
		return { kind: "ready", judge, model };
	} catch (error) {
		return { kind: "unavailable", reason: `judge ${label}: ${errorText(error)}` };
	}
}

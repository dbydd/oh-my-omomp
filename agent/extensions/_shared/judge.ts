import { createNativeJudge, isJudgmentApi, type Judge, type Model } from "@oh-my-pi/pi-ai";
import { AgentRegistry, type ExtensionContext, resolveScopedModels } from "@oh-my-pi/pi-coding-agent";

export type JudgeOpen = { readonly kind: "ready"; readonly judge: Judge; readonly model: Model } | { readonly kind: "inactive" };

const JUDGE_SCOPE: Parameters<typeof resolveScopedModels>[0] = {
	models: ["@judge"],
	messages: [],
	fileArgs: [],
	unknownFlags: new Map<string, boolean | string>(),
	unrecognizedFlags: [],
	invalidFlagValues: [],
};

/**
 * Use the host's role parser and the calling session's live settings.
 * ctx.models.resolve searches chat models only; the scope resolver accepts an
 * all-kind registry view without recreating role parsing. Snapshot the native
 * model so availability and execution agree after a role change. Credentials
 * and headers are requested from the host only when a judgment executes.
 */
export async function openNativeJudge(ctx: ExtensionContext): Promise<JudgeOpen> {
	const session = AgentRegistry.global()
		.list()
		.find((ref) => ref.session?.sessionManager === ctx.sessionManager)?.session;
	if (session == null) throw new Error("JUDGE: current OMP session is not registered");
	const [resolved] = await resolveScopedModels(
		JUDGE_SCOPE,
		{
			getAvailable: () => ctx.modelRegistry.getAvailable("all"),
			getDiscoverableProviders: () => ctx.modelRegistry.getDiscoverableProviders(),
			refresh: (mode, options) => ctx.modelRegistry.refresh(mode, options),
		},
		session.settings,
	);
	const model = resolved?.model;
	if (model === undefined || !isJudgmentApi(model.api)) return { kind: "inactive" };
	const sessionId = ctx.sessionManager.getSessionId();
	const judge: Judge = {
		label: `${model.provider}/${model.id}`,
		async judge(request, options) {
			const signal = options?.signal;
			const apiKey = await ctx.modelRegistry.getApiKey(model, sessionId, { signal });
			if (!apiKey) throw new Error(`judge ${model.provider}/${model.id}: credentials unavailable`);
			const headers = await ctx.modelRegistry.resolveModelHeaders(model, signal);
			return createNativeJudge(model, { apiKey: ctx.modelRegistry.resolver(model, sessionId), headers }).judge(request, options);
		},
	};
	return { kind: "ready", judge, model };
}

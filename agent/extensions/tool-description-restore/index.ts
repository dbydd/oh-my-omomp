import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

type FunctionTool = {
	type: string;
	function?: { name: string; description?: string };
};

export default function restoreToolDescriptions(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "magpie" || ctx.model.api !== "openai-completions") return;
		if (!event.payload || typeof event.payload !== "object") return;
		const payload = event.payload as { tools?: FunctionTool[] };
		if (!Array.isArray(payload.tools)) return;

		let descriptions: Map<string, string> | undefined;
		let tools: FunctionTool[] | undefined;
		for (let index = 0; index < payload.tools.length; index++) {
			const tool = payload.tools[index];
			if (tool?.type !== "function" || !tool.function || tool.function.description) continue;
			descriptions ??= new Map(pi.getAllTools().map(({ name, description }) => [name, description]));
			const description = descriptions.get(tool.function.name);
			if (!description?.trim()) continue;
			tools ??= payload.tools.slice();
			tools[index] = { ...tool, function: { ...tool.function, description } };
		}
		if (tools) return { ...payload, tools };
	});
}

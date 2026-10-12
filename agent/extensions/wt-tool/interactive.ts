import { stripVTControlCharacters } from "node:util";
import { type ExtensionContext, InteractiveMode } from "@oh-my-pi/pi-coding-agent";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { errorText } from "../_shared/errors.ts";

type Capture = { readonly kind: "ok"; readonly mode: InteractiveModeContext } | { readonly kind: "error"; readonly reason: string };

/** Live InteractiveMode behind ctx.ui, read through one recorded setEditorComponent call. */
export function captureInteractiveMode(ctx: ExtensionContext): Capture {
	const proto = InteractiveMode.prototype;
	const original = Object.getOwnPropertyDescriptor(proto, "setEditorComponent");
	if (typeof original?.value !== "function") {
		return { kind: "error", reason: "InteractiveMode.prototype.setEditorComponent is missing (omp internals changed)." };
	}
	let captured: unknown;
	Object.defineProperty(proto, "setEditorComponent", {
		...original,
		value: function (this: unknown): void {
			captured = this;
		},
	});
	try {
		ctx.ui.setEditorComponent(undefined);
	} finally {
		Object.defineProperty(proto, "setEditorComponent", original);
	}
	if (!(captured instanceof InteractiveMode)) {
		return { kind: "error", reason: "the interactive TUI instance is not reachable from this session." };
	}
	// The host's private InteractiveMode members hide its runtime structural context; instanceof proves the live instance.
	const mode = captured as unknown as InteractiveModeContext;
	if (mode.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) {
		return { kind: "error", reason: "the interactive TUI is attached to a different session." };
	}
	return { kind: "ok", mode };
}

/** Shadow a member only for one operation, restoring the original own-property descriptor. */
function shadow<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): () => void {
	const own = Object.getOwnPropertyDescriptor(target, key);
	Object.defineProperty(target, key, { value, configurable: true, writable: true, enumerable: false });
	return () => {
		if (own) Object.defineProperty(target, key, own);
		else delete target[key];
	};
}

function presentedText(content: unknown): string[] {
	const components: unknown[] = Array.isArray(content) ? content : [content];
	return components.flatMap((component) => {
		if ((typeof component !== "object" && typeof component !== "function") || component === null || !("getText" in component)) return [];
		const getText = component.getText;
		if (typeof getText !== "function") return [];
		const text = stripVTControlCharacters(String(getText.call(component))).trim();
		return text ? [text] : [];
	});
}

/** Run the human's built-in dispatcher and retain the text it shows, without changing the editor draft or history. */
export async function runSlashCommand(mode: InteractiveModeContext, text: string): Promise<string[]> {
	const shown: string[] = [];
	const record = (prefix: string, message: string): void => {
		const line = stripVTControlCharacters(message).trim();
		if (line) shown.push(`${prefix}${line}`);
	};
	const showError = mode.showError;
	const showWarning = mode.showWarning;
	const showStatus = mode.showStatus;
	const present = mode.present;
	const undo = [
		shadow(mode, "showError", (message) => {
			record("Error: ", message);
			showError.call(mode, message);
		}),
		shadow(mode, "showWarning", (message, options) => {
			record("Warning: ", message);
			showWarning.call(mode, message, options);
		}),
		shadow(mode, "showStatus", (message, options) => {
			record("", message);
			showStatus.call(mode, message, options);
		}),
		shadow(mode, "present", (content) => {
			shown.push(...presentedText(content));
			present.call(mode, content);
		}),
		shadow(mode.editor, "addToHistory", () => {}),
	];
	try {
		const handled = await executeBuiltinSlashCommand(text, { ctx: mode, draftDetached: true });
		if (handled === false) shown.push(`Error: the built-in ${text.split(" ", 1)[0]} command was not found (omp internals changed).`);
	} catch (error) {
		shown.push(`Error: ${errorText(error)}`);
	} finally {
		for (const restore of undo.reverse()) restore();
	}
	return shown;
}

export const describeShown = (shown: readonly string[]): string => (shown.length > 0 ? shown.join("\n") : "(it showed nothing)");

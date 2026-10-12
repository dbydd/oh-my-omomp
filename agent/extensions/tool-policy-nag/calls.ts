import { z } from "@oh-my-pi/pi-coding-agent";

export type WatchedCall =
	| { readonly kind: "shell"; readonly tool: string; readonly command: string; readonly tty: boolean }
	| { readonly kind: "eval"; readonly language: string; readonly code: string };

const shellSchema = z.object({ command: z.string() });
const execSchema = z.object({ cmd: z.string(), tty: z.unknown().optional() });
const writeSchema = z.object({ path: z.string(), content: z.string() });
const evalSchema = z.object({ language: z.string(), code: z.string() });

/** Device JSON is untrusted; malformed or non-shell payloads are intentionally ignored. */
function deviceShellCall(path: string, content: string): WatchedCall | null {
	if (path !== "xd://bash" && path !== "xd://bash_bg" && path !== "xd://exec_command") return null;
	let payload: unknown;
	try {
		payload = JSON.parse(content);
	} catch {
		// Invalid device JSON is an expected non-shell payload.
		return null;
	}
	return shellCall(path, payload);
}
function shellCall(tool: string, input: unknown): WatchedCall | null {
	if (tool === "exec_command" || tool === "xd://exec_command") {
		const parsed = execSchema.safeParse(input);
		return parsed.success ? { kind: "shell", tool, command: parsed.data.cmd, tty: parsed.data.tty === true } : null;
	}
	const parsed = shellSchema.safeParse(input);
	return parsed.success ? { kind: "shell", tool, command: parsed.data.command, tty: false } : null;
}

export function watchedCallOf(toolName: string, input: unknown): WatchedCall | null {
	switch (toolName) {
		case "bash":
		case "bash_bg":
		case "exec_command":
			return shellCall(toolName, input);
		case "write": {
			const parsed = writeSchema.safeParse(input);
			return parsed.success ? deviceShellCall(parsed.data.path, parsed.data.content) : null;
		}
		case "eval": {
			const parsed = evalSchema.safeParse(input);
			return parsed.success ? { kind: "eval", language: parsed.data.language, code: parsed.data.code } : null;
		}
		default:
			return null;
	}
}

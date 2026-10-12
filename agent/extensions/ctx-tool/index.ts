/**
 * Read-only context recall: registers the ctx tool, then the post-compaction hooks
 * (session_compact and auto_compaction_end) that use the same inventory/renderers.
 * Registration order is deliberate: the ctx tool is available before its hint hooks.
 * Registration does no I/O; requests read registry, session transcripts, sidecars,
 * and local://task-log/<agent-id>.md. No files are written by this extension.
 * The tool runs for main/sub sessions; post-compaction hints run only for main.
 * Tool errors are surfaced to the caller; hint failures are warned, never thrown.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerCtxTool } from "./inventory.ts";
import { registerPostCompactHint } from "./post-compact-hint.ts";

export default function ctxTool(pi: ExtensionAPI): void {
	registerCtxTool(pi);
	registerPostCompactHint(pi);
}

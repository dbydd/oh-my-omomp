/** Parse native result metadata once; identities are lexical, never inferred from tool text. */
import { resolve } from "node:path";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { FileIdentity, SourceResult } from "./coverage.ts";

const searchSchema = z.object({
	cwd: z.string().optional(),
	files: z.array(z.string().min(1)).optional(),
	hits: z.array(z.object({ rel: z.string().min(1), truncated: z.boolean().optional() })).optional(),
	truncated: z.boolean().optional(),
	partial: z.boolean().optional(),
	timedOut: z.boolean().optional(),
});
const readSchema = z.object({
	resolvedPath: z.string().min(1).optional(),
	isDirectory: z.boolean().optional(),
	displayReadTargets: z.array(z.string()).optional(),
	displayReadTargetLinks: z.array(z.string().nullable()).optional(),
	meta: z.object({ source: z.object({ type: z.string(), value: z.string().min(1) }).optional() }).optional(),
});

export function fileIdentity(path: string, cwd: string): FileIdentity {
	return /^[a-z][a-z\d+.-]*:\/\//i.test(path) ? path : resolve(cwd, path);
}

export function searchIdentity(tool: "grep" | "glob" | "find", details: unknown, cwd: string): SourceResult {
	const parsed = searchSchema.safeParse(details);
	if (!parsed.success) return { kind: "unknown", reason: `${tool} metadata invalid` };
	const data = parsed.data;
	const paths = tool === "find" ? data.hits?.map((hit) => hit.rel) : data.files;
	if (paths === undefined) return { kind: "unknown", reason: `${tool} file list missing` };
	return {
		kind: "search",
		files: paths.filter((path) => tool !== "glob" || !path.endsWith("/")).map((path) => fileIdentity(path, data.cwd ?? cwd)),
		partialResults: Boolean(data.truncated || data.partial || data.timedOut || data.hits?.some((hit) => hit.truncated)),
	};
}

export function readIdentity(details: unknown, input: string, cwd: string): SourceResult {
	const parsed = readSchema.safeParse(details);
	if (!parsed.success) return { kind: "unknown", reason: "read metadata invalid" };
	const data = parsed.data;
	if (data.displayReadTargets !== undefined || data.displayReadTargetLinks !== undefined) {
		return { kind: "unknown", reason: "composite read has no per-item success proof" };
	}
	const source = data.meta?.source;
	const files: FileIdentity[] = [];
	if (source !== undefined) {
		switch (source.type) {
			case "internal":
			case "url":
				files.push(source.value);
				break;
			case "path":
				files.push(fileIdentity(source.value, cwd));
				break;
			default:
				return { kind: "unknown", reason: `unsupported read source ${source.type}` };
		}
	}
	if (data.resolvedPath !== undefined && source?.type !== "url") files.push(fileIdentity(data.resolvedPath, cwd));
	if (files.length === 0 && data.isDirectory !== true) return { kind: "unknown", reason: "read identity missing" };
	return { kind: "read", files, inputIdentity: fileIdentity(input, cwd), directory: data.isDirectory === true };
}

/** Per-reply source identities and arithmetic group coverage; no IO or historical replay. */
export type FileIdentity = string;

export type CoverageValue = { kind: "scored"; ratio: number } | { kind: "not-applicable" } | { kind: "incomplete"; reason: string };

export type SourceResult =
	| { kind: "failed" }
	| { kind: "unknown"; reason: string }
	| { kind: "search"; files: readonly FileIdentity[]; partialResults: boolean }
	| { kind: "read"; files: readonly FileIdentity[]; inputIdentity: FileIdentity; directory: boolean };

export interface SourceObservation {
	kind: "search" | "read";
	result: SourceResult;
}

export interface GroupReport {
	searchedCount: number;
	readCount: number;
	coverage: CoverageValue;
	partialResults: boolean;
}

export interface ReplyReport {
	agentId: string;
	agentName: string;
	replyKind: "main" | "irc" | "yield" | "irc-auto";
	replySequence: number;
	groups: readonly GroupReport[];
	coverage: CoverageValue;
}

export function calculateCoverage(observations: readonly SourceObservation[]): {
	groups: readonly GroupReport[];
	coverage: CoverageValue;
} {
	const groups: GroupReport[] = [];
	let phase: "idle" | "searching" | "reading" = "idle";
	let searched = new Set<FileIdentity>();
	let read = new Set<FileIdentity>();
	let reasons = new Set<string>();
	let partialResults = false;
	const finish = (): void => {
		groups.push({
			searchedCount: searched.size,
			readCount: read.size,
			partialResults,
			coverage:
				reasons.size > 0
					? { kind: "incomplete", reason: [...reasons].join("; ") }
					: searched.size === 0
						? { kind: "not-applicable" }
						: { kind: "scored", ratio: read.size / searched.size },
		});
		searched = new Set();
		read = new Set();
		reasons = new Set();
		partialResults = false;
	};
	for (const observation of observations) {
		if (observation.kind === "search") {
			if (phase === "reading") finish();
			phase = "searching";
		} else {
			if (phase === "idle") continue;
			phase = "reading";
		}
		const result = observation.result;
		switch (result.kind) {
			case "failed":
				if (observation.kind === "search") reasons.add("search failed");
				break;
			case "unknown":
				if (observation.kind === "search" || searched.size > 0) reasons.add(result.reason);
				break;
			case "search":
				for (const file of result.files) searched.add(file);
				partialResults ||= result.partialResults;
				break;
			case "read": {
				if (result.directory) break;
				// An archive receipt can identify only its container. Credit an exact
				// input member, never every member (or the container) from that receipt.
				const members = [...searched].filter((file) => result.files.some((container) => file.startsWith(`${container}:`)));
				if (members.length > 0) {
					if (members.includes(result.inputIdentity)) read.add(result.inputIdentity);
					else reasons.add("archive member identity ambiguous");
					break;
				}
				for (const file of result.files) if (searched.has(file)) read.add(file);
				break;
			}
			default: {
				const unreachable: never = result;
				return unreachable;
			}
		}
	}
	if (phase !== "idle") finish();
	let sum = 0;
	let count = 0;
	const incomplete = new Set<string>();
	for (const group of groups) {
		switch (group.coverage.kind) {
			case "scored":
				sum += group.coverage.ratio;
				count++;
				break;
			case "incomplete":
				incomplete.add(group.coverage.reason);
				break;
			case "not-applicable":
				break;
			default: {
				const unreachable: never = group.coverage;
				return unreachable;
			}
		}
	}
	return {
		groups,
		coverage:
			incomplete.size > 0
				? { kind: "incomplete", reason: [...incomplete].join("; ") }
				: count > 0
					? { kind: "scored", ratio: sum / count }
					: { kind: "not-applicable" },
	};
}

function describeCoverage(value: CoverageValue): string {
	switch (value.kind) {
		case "scored":
			return `${(value.ratio * 100).toFixed(1)}%`;
		case "not-applicable":
			return "N/A（无可计算搜索文件）";
		case "incomplete":
			return `统计不完整（${value.reason}）`;
		default: {
			const unreachable: never = value;
			return unreachable;
		}
	}
}

export function formatReport(report: ReplyReport): string {
	const groups = report.groups.map(
		(group, index) =>
			`组${index + 1} ${group.readCount}/${group.searchedCount}=${describeCoverage(group.coverage)}${group.partialResults ? "（仅返回的部分结果）" : ""}`,
	);
	return `来源阅读充实度 [${report.agentName}/${report.replyKind}#${report.replySequence}]：${describeCoverage(report.coverage)}${groups.length > 0 ? `；${groups.join("；")}` : ""}（按组算术平均，仅本组 read）`;
}

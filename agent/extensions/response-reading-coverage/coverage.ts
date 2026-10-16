/** Per-reply source follow-up, classified against a frozen main-session empirical baseline. No IO or historical replay. */
export type FileIdentity = string;

export type CoverageValue =
	| { kind: "rated"; level: "low" | "medium" | "high" }
	| { kind: "not-applicable" }
	| { kind: "incomplete"; reason: string };

export type SourceResult =
	| { kind: "failed" }
	| { kind: "unknown"; reason: string }
	| { kind: "search"; files: readonly FileIdentity[]; partialResults: boolean }
	| { kind: "read"; files: readonly FileIdentity[]; inputIdentity: FileIdentity; directory: boolean };

export interface SourceObservation {
	kind: "search" | "read";
	result: SourceResult;
}

interface ReadingEvidence {
	searchedCount: number;
	readCount: number;
	partialResults: boolean;
}

export interface ReplyReport {
	agentId: string;
	agentName: string;
	replyKind: "main" | "irc" | "yield" | "irc-auto";
	replySequence: number;
	evidence: ReadingEvidence;
	coverage: CoverageValue;
	baselineCutoff: string;
}

/**
 * Calibrated on [2026-10-08T20:09:21Z, 2026-10-15T20:09:21Z), main replies only.
 * Each session contributes total weight 1. Width cutoffs are its weighted empirical
 * thirds; read cutoffs are the same inverse-ECDF thirds within each width stratum.
 * Counts describe returned sources, not an imaginary set that must all be read.
 * Refit offline with ci/reading-coverage-backtest.ts when the observation contract
 * or representative model/prompt/tool population changes; never train during a reply.
 */
function classifyReading(searchedCount: number, readCount: number): CoverageValue {
	let lower = 1;
	let upper = 6;
	if (searchedCount <= 3) {
		lower = 0;
		upper = 1;
	} else if (searchedCount <= 12) {
		upper = 2;
	}
	return { kind: "rated", level: readCount <= lower ? "low" : readCount > upper ? "high" : "medium" };
}

export function calculateCoverage(observations: readonly SourceObservation[]): {
	evidence: ReadingEvidence;
	coverage: CoverageValue;
	baselineCutoff: string;
} {
	const searched = new Set<FileIdentity>();
	const read = new Set<FileIdentity>();
	const reasons = new Set<string>();
	let partialResults = false;
	for (const observation of observations) {
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
				if (result.files.length > 0) partialResults ||= result.partialResults;
				break;
			case "read": {
				if (result.directory || searched.size === 0) break;
				// A container receipt can prove an exact input member, never its siblings.
				let hasMembers = false;
				let exactMember = false;
				for (const file of searched) {
					if (!result.files.some((container) => file.startsWith(`${container}:`))) continue;
					hasMembers = true;
					if (file === result.inputIdentity) exactMember = true;
				}
				if (hasMembers) {
					if (exactMember) read.add(result.inputIdentity);
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
	return {
		evidence: { searchedCount: searched.size, readCount: read.size, partialResults },
		coverage:
			reasons.size > 0
				? { kind: "incomplete", reason: [...reasons].join("; ") }
				: searched.size === 0
					? { kind: "not-applicable" }
					: classifyReading(searched.size, read.size),
		baselineCutoff: "2026-10-15T20:09:21Z",
	};
}

function describeCoverage(value: CoverageValue): string {
	switch (value.kind) {
		case "rated":
			switch (value.level) {
				case "low":
					return "低";
				case "medium":
					return "中";
				case "high":
					return "高";
				default: {
					const unreachable: never = value.level;
					return unreachable;
				}
			}
		case "not-applicable":
			return "不适用（无可评价搜索来源）";
		case "incomplete":
			return `统计不完整（${value.reason}）`;
		default: {
			const unreachable: never = value;
			return unreachable;
		}
	}
}

export function formatReport(report: ReplyReport): string {
	return `来源阅读充实度 [${report.agentName}/${report.replyKind}#${report.replySequence}]：${describeCoverage(report.coverage)}`;
}

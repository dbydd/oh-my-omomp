#!/usr/bin/env bun
// Offline backtest for response-reading-coverage: replay the seven days of main
// session history before a fixed cutoff through the extension's own identity
// parsers and calculateCoverage, then fit the session-weighted low/medium/high
// cuts and report how stable they are. Never runs inside a reply, never trains
// the live extension, and writes nothing: one de-contented JSON report on stdout.
//
//   bun ci/reading-coverage-backtest.ts --cutoff 2026-10-15T20:09:21Z [--sessions <dir>] [--windows]
//
// Sample: successful main-agent reply terminals timestamped in [cutoff-7d, cutoff);
// each window keeps its pre-interval context. Rated windows (S>0, no incomplete
// evidence) are the only fitted rows; 0/0, incomplete, cancelled and unfinished
// windows are counted and excluded. A sample that cannot fill three searched-width
// bands is replayed and reported with fit status "insufficient", never fitted.
// `--windows` adds one hashed row per window with the live core's verdict.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type CoverageValue, calculateCoverage, type SourceObservation } from "../agent/extensions/response-reading-coverage/coverage.ts";
import { readIdentity, searchIdentity } from "../agent/extensions/response-reading-coverage/identity.ts";

const DAY_MS = 86_400_000;
const INTERVAL_DAYS = 7;
const LOW_P = 1 / 3;
const HIGH_P = 2 / 3;

type Mapping = Record<string, unknown>;
type SourceTool = "grep" | "glob" | "find" | "read";
type SessionClass =
	| "main-root"
	| "main-parent-fork"
	| "explicit-sub-role"
	| "explicit-session-init-agent"
	| "ambiguous-storage-depth"
	| "ambiguous-noncanonical-name";
type Level = Extract<CoverageValue, { kind: "rated" }>["level"];
type NotApplicableCause = "no-source-calls" | "no-search-calls" | "searches-returned-no-files";
/** The live core's verdict for the window; `coreLevel` uses the core's frozen baseline, not this run's fit. */
type WindowState =
	| { kind: "rated"; coreLevel: Level }
	| { kind: "not-applicable"; cause: NotApplicableCause }
	| { kind: "incomplete"; reasons: readonly string[] };

/** One settled main reply; counts and hashes only. */
type Window = {
	session: string;
	key: string;
	terminalAt: number;
	day: string;
	searched: number;
	read: number;
	partial: boolean;
	state: WindowState;
	sourceCalls: number;
	startsBeforeInterval: boolean;
};

type Rated = { session: string; day: string; searched: number; read: number; partial: boolean };
type Weighted = { value: number; weight: number };
type Cuts = { lower: number; upper: number };
type Band = { maxSearched: number | null; cuts: Cuts; windows: number; sessions: number; weight: number };
type ConditionalModel = { kind: "conditional"; searchedCuts: readonly [number, number]; bands: readonly (Band | null)[] };
type GlobalModel = { kind: "global"; cuts: Cuts };
type Model = ConditionalModel | GlobalModel;
type Prediction = Level | "unclassifiable";

type Slot = { id: string; tool: SourceTool; input: unknown; calledAt: number; observation: SourceObservation | undefined };

type ReplayCounts = {
	timestampedEntriesBeforeHeader: number;
	inheritedForkEntriesSkipped: number;
	withinFileDuplicateEntries: number;
	resetBranchParentChange: number;
	resetBranchSummary: number;
	resetSessionExit: number;
	resetHumanUserMessage: number;
	resetHumanUserMessageAttributionMissing: number;
	resetHumanDeveloperMessage: number;
	resetHumanCustomMessage: number;
	sourceCallsDiscardedAtReset: number;
	preIntervalTerminals: number;
	duplicateTerminalWindows: number;
	unsuccessfulAssistantStops: number;
	duplicateToolCallIds: number;
	orphanSourceToolResults: number;
	duplicateSourceToolResults: number;
	unsettledSourceCallsAtEof: number;
};

type FileScan =
	| { kind: "created-after-cutoff" }
	| { kind: "unreadable" }
	| { kind: "no-header"; malformedLines: number }
	| {
			kind: "classified";
			sessionClass: SessionClass;
			active: boolean;
			malformedLines: number;
			windows: readonly Window[];
			keys: readonly string[];
	  };

function isMapping(value: unknown): value is Mapping {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Mapping, key: string): string | undefined {
	const field = value[key];
	return typeof field === "string" ? field : undefined;
}

function isSourceTool(value: unknown): value is SourceTool {
	return value === "grep" || value === "glob" || value === "find" || value === "read";
}

function timestampMs(value: unknown): number | undefined {
	const ms = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : Number.NaN;
	return Number.isFinite(ms) ? ms : undefined;
}

/** Key-sorted JSON so a copied terminal hashes the same wherever it was written. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isMapping(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** Mirrors the extension's successful settle: stop, no tool call, nonempty final-phase (else all) text. */
function successfulTerminal(message: Mapping): boolean {
	const content = message.content;
	if (message.stopReason !== "stop" || !Array.isArray(content)) return false;
	let phased = false;
	let finalText = "";
	let fallbackText = "";
	for (const block of content) {
		if (!isMapping(block)) continue;
		if (block.type === "toolCall") return false;
		if (block.type !== "text" || typeof block.text !== "string") continue;
		fallbackText += block.text;
		if (typeof block.textSignature !== "string") continue;
		let signature: unknown;
		try {
			signature = JSON.parse(block.textSignature);
		} catch {
			continue;
		}
		if (!isMapping(signature) || signature.v !== 1) continue;
		if (signature.phase !== "commentary" && signature.phase !== "final_answer") continue;
		phased = true;
		if (signature.phase === "final_answer") finalText += block.text;
	}
	return (phased ? finalText : fallbackText).trim().length > 0;
}

/** Mirrors the extension's tool_result handling for a settled builtin source call. */
function observe(slot: Slot, message: Mapping, cwd: string): SourceObservation {
	const kind = slot.tool === "read" ? "read" : "search";
	if (message.isError === true) return { kind, result: { kind: "failed" } };
	if (message.isError !== false) return { kind, result: { kind: "unknown", reason: "tool success unconfirmed" } };
	if (slot.tool !== "read") return { kind, result: searchIdentity(slot.tool, message.details, cwd) };
	const path = isMapping(slot.input) ? slot.input.path : undefined;
	return {
		kind,
		result:
			typeof path === "string" ? readIdentity(message.details, path, cwd) : { kind: "unknown", reason: "executed read input missing" },
	};
}

async function* fileLines(path: string): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let carry: Uint8Array[] = [];
	for await (const chunk of Bun.file(path).stream()) {
		let start = 0;
		for (let newline = chunk.indexOf(10); newline !== -1; newline = chunk.indexOf(10, start)) {
			const piece = chunk.subarray(start, newline);
			if (carry.length === 0) yield decoder.decode(piece);
			else {
				carry.push(piece);
				yield decoder.decode(Buffer.concat(carry));
				carry = [];
			}
			start = newline + 1;
		}
		if (start < chunk.length) carry.push(chunk.slice(start));
	}
	if (carry.length > 0) yield decoder.decode(Buffer.concat(carry));
}

/**
 * Main sessions are positively identified: SessionManager writes
 * `<fileSafe header.timestamp>_<header.id>.jsonl` directly in a project directory.
 * Subagents carry an explicit role or session_init.agent; anything else is ambiguous.
 */
function classify(header: Mapping, fileName: string, depth: number, subRole: boolean, initAgent: boolean): SessionClass {
	if (subRole) return "explicit-sub-role";
	if (initAgent) return "explicit-session-init-agent";
	if (depth !== 2) return "ambiguous-storage-depth";
	if (fileName !== canonicalFileName(header)) return "ambiguous-noncanonical-name";
	return typeof header.parentSession === "string" && header.parentSession !== "" ? "main-parent-fork" : "main-root";
}

function canonicalFileName(header: Mapping): string {
	return `${String(header.timestamp).replace(/[:.]/g, "-")}_${String(header.id)}.jsonl`;
}

/** Stateful replay of one main-candidate file in entry order; mirrors the live window lifecycle. */
class Replay {
	readonly windows: Window[] = [];
	readonly keys: string[] = [];
	private slots: Slot[] = [];
	private calls = new Map<string, Slot>();
	private readonly seenEntries = new Set<string>();
	private readonly branchIds = new Set<string>();
	private lastEntry: string | undefined;
	private readonly session: string;
	private readonly cwd: string;
	private readonly inheritedBefore: number | undefined;

	constructor(
		header: Mapping,
		private readonly start: number,
		private readonly cutoff: number,
		private readonly counts: ReplayCounts,
		private readonly committedKeys: ReadonlySet<string>,
	) {
		// Same 16-hex session key as the calibration extractor, so audit rows join.
		this.session = createHash("sha256").update(String(header.id)).digest("hex").slice(0, 16);
		this.cwd = stringField(header, "cwd") ?? "";
		this.inheritedBefore =
			typeof header.parentSession === "string" && header.parentSession !== "" ? timestampMs(header.timestamp) : undefined;
	}

	private reset(): void {
		this.counts.sourceCallsDiscardedAtReset += this.slots.length;
		this.slots = [];
		this.calls = new Map();
	}

	entry(entry: Mapping, at: number | undefined): void {
		if (at === undefined || at >= this.cutoff) return;
		const type = stringField(entry, "type");
		const id = stringField(entry, "id");
		const dedupe = `${id}\0${type}\0${at}`;
		if (this.seenEntries.has(dedupe)) {
			this.counts.withinFileDuplicateEntries++;
			return;
		}
		this.seenEntries.add(dedupe);
		// A parent fork copies its parent's prefix; only entries after the fork are this session's.
		if (this.inheritedBefore !== undefined && at < this.inheritedBefore) {
			this.counts.inheritedForkEntriesSkipped++;
			return;
		}
		const parent = stringField(entry, "parentId");
		if (parent && this.branchIds.has(parent) && this.lastEntry !== undefined && parent !== this.lastEntry) {
			this.counts.resetBranchParentChange++;
			this.reset();
		}
		if (id) {
			this.branchIds.add(id);
			this.lastEntry = id;
		}
		if (type === "branch_summary") {
			this.counts.resetBranchSummary++;
			this.reset();
		} else if (type === "custom" && entry.customType === "session_exit") {
			this.counts.resetSessionExit++;
			this.reset();
		} else if (type === "custom_message" && entry.attribution === "user") {
			this.counts.resetHumanCustomMessage++;
			this.reset();
		} else if (type === "message" && isMapping(entry.message)) {
			this.message(entry.message, id, at);
		}
	}

	private message(message: Mapping, id: string | undefined, at: number): void {
		switch (message.role) {
			case "user":
				if (message.attribution === "agent") return;
				this.counts.resetHumanUserMessage++;
				if (message.attribution === undefined) this.counts.resetHumanUserMessageAttributionMissing++;
				this.reset();
				return;
			case "developer":
				if (message.attribution !== "user") return;
				this.counts.resetHumanDeveloperMessage++;
				this.reset();
				return;
			case "assistant":
				this.assistant(message, id, at);
				return;
			case "toolResult":
				this.toolResult(message);
				return;
			default:
				return;
		}
	}

	private assistant(message: Mapping, id: string | undefined, at: number): void {
		if (message.stopReason === "aborted" || message.stopReason === "error") this.counts.unsuccessfulAssistantStops++;
		const content = Array.isArray(message.content) ? message.content : [];
		for (const block of content) {
			if (!isMapping(block) || block.type !== "toolCall" || !isSourceTool(block.name)) continue;
			const callId = stringField(block, "id") ?? "";
			if (this.calls.has(callId)) {
				this.counts.duplicateToolCallIds++;
				continue;
			}
			const slot: Slot = { id: callId, tool: block.name, input: block.arguments, calledAt: at, observation: undefined };
			this.slots.push(slot);
			this.calls.set(callId, slot);
		}
		if (!successfulTerminal(message)) return;
		if (at < this.start) {
			this.counts.preIntervalTerminals++;
			this.slots = [];
			this.calls = new Map();
			return;
		}
		// Entry IDs are short and collide across sessions; the key binds ID, time, response and content.
		const key = createHash("sha256")
			.update(`${id}\0${at}\0${String(message.responseId)}\0${canonicalJson(message.content)}`)
			.digest("hex");
		const slots = this.slots;
		this.slots = [];
		this.calls = new Map();
		if (this.committedKeys.has(key) || this.keys.includes(key)) {
			this.counts.duplicateTerminalWindows++;
			return;
		}
		const observations = slots.map(
			(slot): SourceObservation =>
				slot.observation ?? {
					kind: slot.tool === "read" ? "read" : "search",
					result: { kind: "unknown", reason: "tool result missing at terminal settle" },
				},
		);
		const { evidence, coverage } = calculateCoverage(observations);
		let state: WindowState;
		switch (coverage.kind) {
			case "rated":
				state = { kind: "rated", coreLevel: coverage.level };
				break;
			case "incomplete":
				state = { kind: "incomplete", reasons: coverage.reason.split("; ") };
				break;
			case "not-applicable":
				state = {
					kind: "not-applicable",
					cause:
						slots.length === 0
							? "no-source-calls"
							: slots.every((slot) => slot.tool === "read")
								? "no-search-calls"
								: "searches-returned-no-files",
				};
				break;
			default: {
				const unreachable: never = coverage;
				throw new Error(`unhandled coverage ${String(unreachable)}`);
			}
		}
		this.keys.push(key);
		this.windows.push({
			session: this.session,
			key: key.slice(0, 16),
			terminalAt: at,
			day: new Date(at).toISOString().slice(0, 10),
			searched: evidence.searchedCount,
			read: evidence.readCount,
			partial: evidence.partialResults,
			state,
			sourceCalls: slots.length,
			startsBeforeInterval: slots.some((slot) => slot.calledAt < this.start),
		});
	}

	private toolResult(message: Mapping): void {
		const callId = stringField(message, "toolCallId");
		const slot = callId === undefined ? undefined : this.calls.get(callId);
		if (slot === undefined) {
			if (isSourceTool(message.toolName)) this.counts.orphanSourceToolResults++;
			return;
		}
		if (slot.observation !== undefined) {
			this.counts.duplicateSourceToolResults++;
			return;
		}
		slot.observation = observe(slot, message, this.cwd);
	}

	finish(): void {
		this.counts.unsettledSourceCallsAtEof += this.slots.length;
	}
}

async function scanFile(
	path: string,
	segments: readonly string[],
	start: number,
	cutoff: number,
	counts: ReplayCounts,
	committedKeys: ReadonlySet<string>,
): Promise<FileScan> {
	const fileName = segments.at(-1) ?? "";
	let header: Mapping | undefined;
	let replay: Replay | undefined;
	let subRole = false;
	let initAgent = false;
	let active = false;
	let malformedLines = 0;
	let timestampedBeforeHeader = 0;
	try {
		for await (const line of fileLines(path)) {
			// A non-candidate file only needs its explicit subagent markers; a line
			// without either serialized entry type cannot carry one, so skip parsing it.
			if (
				header !== undefined &&
				replay === undefined &&
				!line.includes('"type":"model_change"') &&
				!line.includes('"type":"session_init"')
			) {
				continue;
			}
			if (line.trim() === "") continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				malformedLines++;
				continue;
			}
			if (!isMapping(entry)) {
				malformedLines++;
				continue;
			}
			if (entry.type === "session") {
				if (header === undefined) {
					header = entry;
					const created = timestampMs(entry.timestamp);
					if (created !== undefined && created >= cutoff) return { kind: "created-after-cutoff" };
					// Only a canonical project-level basename can be main; replay it while streaming.
					if (segments.length === 2 && fileName === canonicalFileName(entry)) {
						replay = new Replay(entry, start, cutoff, counts, committedKeys);
					}
				}
				continue;
			}
			const at = timestampMs(entry.timestamp);
			if (entry.type === "model_change" && typeof entry.role === "string" && entry.role.startsWith("subagent:")) subRole = true;
			if (entry.type === "session_init" && entry.agent) initAgent = true;
			if (header === undefined) {
				if (at !== undefined) timestampedBeforeHeader++;
			} else if (replay !== undefined) {
				if (at !== undefined && at >= start && at < cutoff) active = true;
				replay.entry(entry, at);
			}
		}
	} catch (error) {
		// Only a filesystem failure (e.g. a session removed mid-scan) is an unreadable file; replay bugs must surface.
		if (error instanceof Error && "code" in error && typeof error.code === "string") return { kind: "unreadable" };
		throw error;
	}
	if (header === undefined) return { kind: "no-header", malformedLines };
	replay?.finish();
	const sessionClass = classify(header, fileName, segments.length, subRole, initAgent);
	const main = sessionClass === "main-root" || sessionClass === "main-parent-fork";
	if (main) counts.timestampedEntriesBeforeHeader += timestampedBeforeHeader;
	return {
		kind: "classified",
		sessionClass,
		active,
		malformedLines,
		windows: main && replay ? replay.windows : [],
		keys: main && replay ? replay.keys : [],
	};
}

// --- fitting -------------------------------------------------------------------

/** Each session contributes total weight 1, split evenly over its rows. */
function sessionWeights(rows: readonly Rated[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(row.session, (counts.get(row.session) ?? 0) + 1);
	return new Map([...counts].map(([session, count]) => [session, 1 / count]));
}

function weighted(rows: readonly Rated[], weights: ReadonlyMap<string, number>, value: (row: Rated) => number): Weighted[] {
	return rows.map((row) => ({ value: value(row), weight: weights.get(row.session) ?? 0 })).sort((a, b) => a.value - b.value);
}

/** Inverse ECDF: the first observed value whose cumulative weight reaches p. Ties stay whole. */
function quantile(sorted: readonly Weighted[], p: number): number | undefined {
	const total = sorted.reduce((sum, item) => sum + item.weight, 0);
	let cumulative = 0;
	for (const item of sorted) {
		cumulative += item.weight;
		if (cumulative >= p * total - 1e-9 * total) return item.value;
	}
	return sorted.at(-1)?.value;
}

function thirds(sorted: readonly Weighted[]): Cuts | undefined {
	const lower = quantile(sorted, LOW_P);
	const upper = quantile(sorted, HIGH_P);
	return lower === undefined || upper === undefined ? undefined : { lower, upper };
}

function level(cuts: Cuts, read: number): Level {
	return read <= cuts.lower ? "low" : read > cuts.upper ? "high" : "medium";
}

function bandIndex(searchedCuts: readonly [number, number], searched: number): number {
	return searched <= searchedCuts[0] ? 0 : searched <= searchedCuts[1] ? 1 : 2;
}

function fitConditional(rows: readonly Rated[]): ConditionalModel | undefined {
	const weights = sessionWeights(rows);
	const widths = thirds(weighted(rows, weights, (row) => row.searched));
	if (widths === undefined) return undefined;
	const searchedCuts = [widths.lower, widths.upper] as const;
	const bands = [0, 1, 2].map((index): Band | null => {
		const members = rows.filter((row) => bandIndex(searchedCuts, row.searched) === index);
		const cuts = thirds(weighted(members, weights, (row) => row.read));
		if (cuts === undefined) return null;
		return {
			maxSearched: index < 2 ? (searchedCuts[index] ?? null) : null,
			cuts,
			windows: members.length,
			sessions: new Set(members.map((row) => row.session)).size,
			weight: members.reduce((sum, row) => sum + (weights.get(row.session) ?? 0), 0),
		};
	});
	return { kind: "conditional", searchedCuts, bands };
}

function fitGlobal(rows: readonly Rated[]): GlobalModel | undefined {
	const cuts = thirds(weighted(rows, sessionWeights(rows), (row) => row.read));
	return cuts === undefined ? undefined : { kind: "global", cuts };
}

function fit(kind: Model["kind"], rows: readonly Rated[]): Model | undefined {
	switch (kind) {
		case "conditional":
			return fitConditional(rows);
		case "global":
			return fitGlobal(rows);
		default: {
			const unreachable: never = kind;
			return unreachable;
		}
	}
}

function predict(model: Model | undefined, row: Rated): Prediction {
	if (model === undefined) return "unclassifiable";
	switch (model.kind) {
		case "global":
			return level(model.cuts, row.read);
		case "conditional": {
			const band = model.bands[bandIndex(model.searchedCuts, row.searched)];
			return band ? level(band.cuts, row.read) : "unclassifiable";
		}
		default: {
			const unreachable: never = model;
			return unreachable;
		}
	}
}

function cutsSignature(model: Model | undefined): string {
	if (model === undefined) return "none";
	switch (model.kind) {
		case "global":
			return `R${model.cuts.lower}/${model.cuts.upper}`;
		case "conditional":
			return `S${model.searchedCuts.join("/")} ${model.bands
				.map((band) => (band ? `R${band.cuts.lower}/${band.cuts.upper}` : "empty"))
				.join(" ")}`;
		default: {
			const unreachable: never = model;
			return unreachable;
		}
	}
}

function shares(rows: readonly Rated[], predictions: readonly Prediction[]): Record<Prediction, number> {
	const weights = sessionWeights(rows);
	const total: Record<Prediction, number> = { low: 0, medium: 0, high: 0, unclassifiable: 0 };
	rows.forEach((row, index) => {
		const prediction = predictions[index];
		if (prediction !== undefined) total[prediction] += weights.get(row.session) ?? 0;
	});
	const sum = total.low + total.medium + total.high + total.unclassifiable;
	return {
		low: round(total.low / sum),
		medium: round(total.medium / sum),
		high: round(total.high / sum),
		unclassifiable: round(total.unclassifiable / sum),
	};
}

function round(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

/** Session-weighted share of rows whose level matches the full-sample level, plus the raw count that changed. */
function agreement(rows: readonly Rated[], predictions: readonly Prediction[], full: Model | undefined) {
	const weights = sessionWeights(rows);
	let agree = 0;
	let total = 0;
	let changedWindows = 0;
	rows.forEach((row, index) => {
		const weight = weights.get(row.session) ?? 0;
		total += weight;
		if (predictions[index] === predict(full, row)) agree += weight;
		else changedWindows++;
	});
	return { sessionWeightedAgreement: total > 0 ? round(agree / total) : null, changedWindows, windows: rows.length };
}

/** Refit without each group in turn; score its rows against the full-sample levels. */
function leaveOneOut(kind: Model["kind"], rows: readonly Rated[], full: Model | undefined, group: (row: Rated) => string) {
	const heldOut: Prediction[] = new Array(rows.length);
	const signatures = new Map<string, number>();
	const groups = [...new Set(rows.map(group))].sort();
	for (const name of groups) {
		const model = fit(
			kind,
			rows.filter((row) => group(row) !== name),
		);
		const signature = cutsSignature(model);
		signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
		rows.forEach((row, index) => {
			if (group(row) === name) heldOut[index] = predict(model, row);
		});
	}
	const fullSignature = cutsSignature(full);
	return {
		folds: groups.length,
		foldsWithFullSampleCuts: signatures.get(fullSignature) ?? 0,
		heldOutVersusFullSample: agreement(rows, heldOut, full),
		heldOutLevelShares: shares(rows, heldOut),
		cutsSeen: Object.fromEntries([...signatures].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
	};
}

/** Train on days before the last two sample days, test those two days. */
function temporalHoldout(kind: Model["kind"], rows: readonly Rated[], full: Model | undefined) {
	const days = [...new Set(rows.map((row) => row.day))].sort();
	const testDays = days.slice(-2);
	const train = rows.filter((row) => row.day < (testDays[0] ?? ""));
	const test = rows.filter((row) => testDays.includes(row.day));
	const model = fit(kind, train);
	const predictions = test.map((row) => predict(model, row));
	return {
		trainDays: days.slice(0, -2),
		testDays,
		train: sampleSize(train),
		test: sampleSize(test),
		trainCuts: describeModel(model),
		testLevelShares: shares(test, predictions),
		testVersusFullSample: agreement(test, predictions, full),
	};
}

function sampleSize(rows: readonly Rated[]) {
	return { windows: rows.length, sessions: new Set(rows.map((row) => row.session)).size };
}

function describeModel(model: Model | undefined) {
	if (model === undefined) return null;
	switch (model.kind) {
		case "global":
			return { readCuts: model.cuts };
		case "conditional":
			return { searchedCuts: model.searchedCuts, bands: model.bands };
		default: {
			const unreachable: never = model;
			return unreachable;
		}
	}
}

function candidate(kind: Model["kind"], rows: readonly Rated[]) {
	const model = fit(kind, rows);
	const predictions = rows.map((row) => predict(model, row));
	return {
		cuts: describeModel(model),
		inSampleLevelShares: shares(rows, predictions),
		inSampleWindows: countBy(predictions, (prediction) => prediction),
		leaveOneSessionOut: leaveOneOut(kind, rows, model, (row) => row.session),
		leaveOneDayOut: leaveOneOut(kind, rows, model, (row) => row.day),
		temporalHoldout: temporalHoldout(kind, rows, model),
	};
}

/** Raw (per-window) and session-weighted inverse-ECDF quantiles. */
function distribution(rows: readonly Rated[], value: (row: Rated) => number) {
	if (rows.length === 0) return { n: 0 };
	const plain = rows.map((row) => ({ value: value(row), weight: 1 })).sort((a, b) => a.value - b.value);
	const sessionWeighted = weighted(rows, sessionWeights(rows), value);
	const points = (sorted: readonly Weighted[]) => ({
		min: sorted[0]?.value,
		p25: quantile(sorted, 0.25),
		p33: quantile(sorted, LOW_P),
		p50: quantile(sorted, 0.5),
		p67: quantile(sorted, HIGH_P),
		p75: quantile(sorted, 0.75),
		p90: quantile(sorted, 0.9),
		max: sorted.at(-1)?.value,
	});
	return {
		n: rows.length,
		mean: round(plain.reduce((sum, item) => sum + item.value, 0) / rows.length),
		perWindow: points(plain),
		sessionWeighted: points(sessionWeighted),
	};
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
	return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

// --- report --------------------------------------------------------------------

function parseCli(): { cutoff: number; cutoffText: string; root: string; windows: boolean } {
	const { values } = parseArgs({
		options: { cutoff: { type: "string" }, sessions: { type: "string" }, windows: { type: "boolean", default: false } },
		strict: true,
	});
	const text = values.cutoff;
	const cutoff = text !== undefined && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text) ? Date.parse(text) : Number.NaN;
	if (text === undefined || !Number.isFinite(cutoff)) {
		throw new Error(
			"usage: bun ci/reading-coverage-backtest.ts --cutoff <ISO UTC, e.g. 2026-10-15T20:09:21Z> [--sessions <dir>] [--windows]",
		);
	}
	return { cutoff, cutoffText: text, root: resolve(values.sessions ?? join(homedir(), ".omp/agent/sessions")), windows: values.windows };
}

function compareSegments(a: readonly string[], b: readonly string[]): number {
	for (let index = 0; index < Math.min(a.length, b.length); index++) {
		const left = a[index] ?? "";
		const right = b[index] ?? "";
		if (left !== right) return left < right ? -1 : 1;
	}
	return a.length - b.length;
}

async function replayHistory(root: string, start: number, cutoff: number) {
	const paths = [...new Bun.Glob("**/*.jsonl").scanSync({ cwd: root, dot: true, onlyFiles: true, followSymlinks: false })]
		.map((rel) => rel.split("/"))
		.sort(compareSegments);
	const counts: ReplayCounts = {
		timestampedEntriesBeforeHeader: 0,
		inheritedForkEntriesSkipped: 0,
		withinFileDuplicateEntries: 0,
		resetBranchParentChange: 0,
		resetBranchSummary: 0,
		resetSessionExit: 0,
		resetHumanUserMessage: 0,
		resetHumanUserMessageAttributionMissing: 0,
		resetHumanDeveloperMessage: 0,
		resetHumanCustomMessage: 0,
		sourceCallsDiscardedAtReset: 0,
		preIntervalTerminals: 0,
		duplicateTerminalWindows: 0,
		unsuccessfulAssistantStops: 0,
		duplicateToolCallIds: 0,
		orphanSourceToolResults: 0,
		duplicateSourceToolResults: 0,
		unsettledSourceCallsAtEof: 0,
	};
	// Files whose header is at or after the cutoff hold no pre-cutoff history and are not counted, so a
	// fixed cutoff reports the same files later. Non-candidate files parse only header and subagent-marker
	// lines; malformed counts cover parsed lines.
	const files = { scanned: 0, unreadable: 0, missingHeader: 0, malformedParsedLines: 0 };
	const classification: Record<string, number> = {};
	// Canonical project-level files with an entry in the interval, by final class.
	const activeCanonicalCandidates: Record<string, number> = {};
	const committedKeys = new Set<string>();
	const windows: Window[] = [];
	for (const [index, segments] of paths.entries()) {
		if (index % 2000 === 0) process.stderr.write(`scanning ${index}/${paths.length}\n`);
		const scan = await scanFile(join(root, ...segments), segments, start, cutoff, counts, committedKeys);
		if (scan.kind !== "created-after-cutoff") files.scanned++;
		switch (scan.kind) {
			case "created-after-cutoff":
				break;
			case "unreadable":
				files.unreadable++;
				break;
			case "no-header":
				files.missingHeader++;
				files.malformedParsedLines += scan.malformedLines;
				break;
			case "classified":
				files.malformedParsedLines += scan.malformedLines;
				classification[scan.sessionClass] = (classification[scan.sessionClass] ?? 0) + 1;
				if (scan.active) activeCanonicalCandidates[scan.sessionClass] = (activeCanonicalCandidates[scan.sessionClass] ?? 0) + 1;
				for (const key of scan.keys) committedKeys.add(key);
				windows.push(...scan.windows);
				break;
			default: {
				const unreachable: never = scan;
				throw new Error(`unhandled scan ${String(unreachable)}`);
			}
		}
	}
	windows.sort((a, b) => a.terminalAt - b.terminalAt || a.session.localeCompare(b.session) || a.key.localeCompare(b.key));
	return { files: { ...files, classification, activeCanonicalCandidates }, counts, windows };
}

async function main(): Promise<void> {
	const cli = parseCli();
	const start = cli.cutoff - INTERVAL_DAYS * DAY_MS;
	const { files, counts, windows } = await replayHistory(cli.root, start, cli.cutoff);

	const rated: Rated[] = windows
		.filter((window) => window.state.kind === "rated")
		.map((window) => ({ session: window.session, day: window.day, searched: window.searched, read: window.read, partial: window.partial }));
	if (rated.some((row) => row.searched === 0)) throw new Error("invariant: a rated window has S=0");
	const nonPartial = rated.filter((row) => !row.partial);
	const partial = rated.filter((row) => row.partial);
	const conditional = fitConditional(rated);
	// Three searched-width bands each need rated windows; a smaller sample is replayed and reported, never fitted.
	const fitted = conditional?.bands.every((band) => band !== null) ? conditional : undefined;
	const fullPredictions = rated.map((row) => predict(fitted, row));
	const method =
		"session weight 1/n over rated windows; S cuts = weighted inverse-ECDF q(1/3), q(2/3) -> bands S<=q1, S<=q2, rest; per band R cuts the same; R<=lower low, R>upper high, else medium; ties unsplit";

	const report = {
		interval: {
			startInclusive: new Date(start).toISOString(),
			cutoffExclusive: new Date(cli.cutoff).toISOString(),
			basis: "successful main reply terminal timestamp; windows keep pre-interval context",
			sessionsRoot: cli.root.startsWith(homedir()) ? `~${cli.root.slice(homedir().length)}` : cli.root,
		},
		files,
		replay: counts,
		sample: {
			windows: windows.length,
			sessionsWithWindows: new Set(windows.map((window) => window.session)).size,
			windowsWithSourceCalls: windows.filter((window) => window.sourceCalls > 0).length,
			windowsStartingBeforeInterval: windows.filter((window) => window.startsBeforeInterval).length,
			kinds: countBy(windows, (window) => window.state.kind),
			excluded: {
				// S=0,R=0 windows by core kind; none can be rated (asserted above), so none enters any fit.
				zeroZeroByKind: countBy(
					windows.filter((window) => window.searched === 0 && window.read === 0),
					(window) => window.state.kind,
				),
				zeroSearched: countBy(
					windows.flatMap((window) => (window.state.kind === "not-applicable" ? [window.state.cause] : [])),
					(cause) => cause,
				),
				incompleteReasons: countBy(
					windows.flatMap((window) => (window.state.kind === "incomplete" ? window.state.reasons : [])),
					(reason) => reason,
				),
			},
			rated: {
				...sampleSize(rated),
				partialResultWindows: partial.length,
				byDay: countBy(rated, (row) => row.day),
				windowsByDay: countBy(windows, (window) => `${window.day} ${window.state.kind}`),
			},
		},
		distributions: {
			searched: distribution(rated, (row) => row.searched),
			read: distribution(rated, (row) => row.read),
			readBySearchedBand: conditional
				? [0, 1, 2].map((index) =>
						distribution(
							rated.filter((row) => bandIndex(conditional.searchedCuts, row.searched) === index),
							(row) => row.read,
						),
					)
				: null,
		},
		fit: fitted
			? {
					status: "fitted",
					method,
					selected: "conditional",
					conditional: describeModel(fitted),
					levelShares: shares(rated, fullPredictions),
					levelWindows: countBy(fullPredictions, (prediction) => prediction),
				}
			: {
					status: "insufficient",
					reason: "rated windows do not fill three searched-width bands",
					method,
					searchedCuts: conditional?.searchedCuts ?? null,
				},
		candidates: fitted ? { conditional: candidate("conditional", rated), global: candidate("global", rated) } : null,
		sensitivity: fitted
			? {
					partialResults: {
						note: "partial = a non-empty search reported truncated/partial/timed-out results; S counts only returned files",
						bySearchedBand: [0, 1, 2].map((index) => {
							const members = rated.filter((row) => bandIndex(fitted.searchedCuts, row.searched) === index);
							return { windows: members.length, partial: members.filter((row) => row.partial).length };
						}),
						nonPartial: { ...sampleSize(nonPartial), cuts: describeModel(fitConditional(nonPartial)) },
						partial: { ...sampleSize(partial), cuts: describeModel(fitConditional(partial)) },
					},
				}
			: null,
		limitations: [
			"Levels place source follow-up reading relative to this main-session history; they do not measure comprehension or answer quality.",
			"History does not persist agent_end/willContinue: a terminal is a stop-reason assistant message with no tool call and nonempty final-phase (else all) text.",
			"History does not persist builtin tool provenance; any grep/glob/find/read call is treated as builtin.",
			"Native input source (interactive/rpc) is not persisted; user messages not attributed to the agent, and developer/custom messages attributed to the user, reset the window.",
			"Identities use the session header cwd, not a per-call cwd.",
			"Main sessions are identified by canonical project-level file names without explicit subagent evidence; ambiguous files are excluded, not guessed.",
			"Thresholds are an offline fit for this cutoff; refit by rerunning this command, the live extension never trains.",
			"A fixed cutoff reproduces only while pre-cutoff session entries stay on disk unchanged; entries at or after the cutoff are ignored.",
		],
		coreBaselineCutoff: calculateCoverage([]).baselineCutoff,
		windows: cli.windows
			? windows.map((window) => ({
					session: window.session,
					window: window.key,
					terminalAt: new Date(window.terminalAt).toISOString(),
					searched: window.searched,
					read: window.read,
					partial: window.partial,
					...window.state,
				}))
			: undefined,
	};
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();

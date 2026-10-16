/**
 * Warns the interactive omp process's main UI and agent when an owned descendant's
 * macOS phys_footprint exceeds 4 GiB. Main session_start starts one process-shared
 * monitor; session_switch refreshes delivery, and its owning main's session_shutdown
 * clears the managed timer before closing libproc. Child factories never own it.
 * Native 250 ms stable scans retain PID+birth ownership after reparenting; observed
 * descendant-led process groups can discover surviving members. A process born and
 * orphaned between observations without a known surviving group anchor cannot be
 * attributed retroactively from the process table.
 * No config, files, model calls, sampling subprocesses, signals, or automatic kills.
 * Unsupported platforms log once and never import the Darwin binding. Native/hook
 * failures warn without escaping into omp; delivery is attempted once per identity.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { type ProcessRecord, type ProcessSource, ProcessTracker } from "./tracker.ts";

const THRESHOLD_BYTES = 4n * 1024n ** 3n;
const POLL_MS = 250;

interface Monitor {
	readonly pi: ExtensionAPI;
	ctx: ExtensionContext;
	readonly source: ProcessSource;
	readonly tracker: ProcessTracker;
	readonly timer: Timer;
	problem: string | null;
}

type Lifetime =
	| { kind: "not-started" }
	| { kind: "starting"; pi: ExtensionAPI; ctx: ExtensionContext }
	| { kind: "active"; monitor: Monitor }
	| { kind: "stopped" };

// The loader reuses this module but invokes its factory separately for each child.
let lifetime: Lifetime = { kind: "not-started" };

function warn(pi: ExtensionAPI, message: string, error: unknown): void {
	try {
		pi.logger.warn(`child-memory-warning: ${message}`, { error: errorText(error) });
	} catch {
		// A failing logger must not escape an observational hook or suppress the other delivery channel.
	}
}

function deliver(monitor: Monitor, current: ProcessRecord, bytes: bigint, command: string): void {
	const { pi, ctx } = monitor;
	const text =
		`子进程内存超限：PID ${current.pid}，PPID ${current.parentPid}，孤儿：${current.parentPid === 1 ? "是" : "否"}；` +
		`phys_footprint ${(Number(bytes) / 1024 ** 3).toFixed(2)} GiB（${bytes} bytes），阈值 > 4 GiB。\n命令：${command}\n仅告警，未结束该进程。`;
	try {
		ctx.ui.notify(text, "warning");
	} catch (error) {
		warn(pi, "UI warning failed", error);
	}
	try {
		pi.sendUserMessage(text, ctx.isIdle() ? { attribution: "agent" } : { deliverAs: "aside", attribution: "agent" });
	} catch (error) {
		warn(pi, "main-agent warning failed", error);
	}
}

function sample(monitor: Monitor): void {
	try {
		const result = monitor.source.snapshot();
		if (result.kind === "unavailable") {
			if (monitor.problem !== result.reason) monitor.pi.logger.warn(`child-memory-warning: ${result.reason}`);
			monitor.problem = result.reason;
			return;
		}
		monitor.problem = null;
		for (const tracked of monitor.tracker.observe(result.snapshot)) {
			if (tracked.alerted) continue;
			const { pid, startedAt } = tracked.identity;
			const bytes = monitor.source.footprint(pid);
			if (bytes === null || bytes <= THRESHOLD_BYTES) continue;
			const command = monitor.source.command(pid);
			// A PID can exit/recycle while memory and argv are read. Also use the latest PPID.
			const current = monitor.source.process(pid);
			if (current === null || current.startedAt !== startedAt) continue;
			tracked.alerted = true;
			deliver(monitor, current, bytes, command);
		}
	} catch (error) {
		const problem = errorText(error);
		if (monitor.problem !== problem) warn(monitor.pi, "sampling failed", error);
		monitor.problem = problem;
	}
}

async function start(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.agent.kind !== "main" || lifetime.kind !== "not-started") return;
	if (process.platform !== "darwin") {
		lifetime = { kind: "stopped" };
		pi.logger.info("child-memory-warning: 未启用（仅支持 darwin）");
		return;
	}
	const starting: Lifetime = { kind: "starting", pi, ctx };
	lifetime = starting;
	let source: ProcessSource | null = null;
	try {
		// Keep the Darwin-only FFI module outside unsupported-platform startup.
		const native = await import("./native.ts");
		if (lifetime !== starting) return;
		source = native.openDarwinProcesses();
		const root = source.process(process.pid);
		if (root === null) {
			pi.logger.warn("child-memory-warning: cannot read omp process identity; monitoring not started");
			return;
		}
		const tracker = new ProcessTracker(root);
		const timer = ctx.setInterval(() => {
			if (lifetime.kind === "active" && lifetime.monitor.pi === pi) sample(lifetime.monitor);
		}, POLL_MS);
		const monitor: Monitor = { pi, ctx: starting.ctx, source, tracker, timer, problem: null };
		lifetime = { kind: "active", monitor };
		source = null; // Ownership moves to the active monitor before its first sample.
		sample(monitor);
	} catch (error) {
		warn(pi, "monitor initialization failed", error);
	} finally {
		if (source !== null) source.close();
		if (lifetime === starting) lifetime = { kind: "stopped" };
	}
}

export default function childMemoryWarning(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		try {
			await start(pi, ctx);
		} catch (error) {
			warn(pi, "session_start failed", error);
		}
	});
	pi.on("session_switch", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		if (lifetime.kind === "active" && lifetime.monitor.pi === pi) lifetime.monitor.ctx = ctx;
		else if (lifetime.kind === "starting" && lifetime.pi === pi) lifetime.ctx = ctx;
	});
	pi.on("session_shutdown", (_event, ctx) => {
		try {
			if (ctx.agent.kind !== "main") return;
			if (lifetime.kind === "starting" && lifetime.pi === pi) lifetime = { kind: "stopped" };
			else if (lifetime.kind === "active" && lifetime.monitor.pi === pi) {
				const { monitor } = lifetime;
				lifetime = { kind: "stopped" };
				try {
					monitor.ctx.clearTimer(monitor.timer);
				} finally {
					monitor.source.close();
				}
			}
		} catch (error) {
			warn(pi, "shutdown failed", error);
		}
	});
}

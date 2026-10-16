/** Darwin LP64 libproc/sysctl ABI. Imported only after the platform guard; no sampling subprocesses. */
import { dlopen, FFIType, type Library, ptr } from "bun:ffi";
import type { ProcessRecord, ProcessSource, SnapshotResult } from "./tracker.ts";

// SDK: libproc.h, sys/proc_info.h (PROC_PIDTBSDINFO), sys/resource.h (RUSAGE_INFO_V0).
const BSD_INFO_SIZE = 136;
const RUSAGE_SIZE = 96;
const ZOMBIE_STATUS = 5; // sys/proc.h: SZOMB; rusage can return terminal accounting for zombies.
const decoder = new TextDecoder();

const LIBPROC_ABI = {
	proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
	proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
	sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
} as const;

type NativeSymbols = Library<typeof LIBPROC_ABI>["symbols"];

function readProcess(symbols: NativeSymbols, bytes: Uint8Array, view: DataView, pid: number): ProcessRecord | null {
	if (symbols.proc_pidinfo(pid, 3, 0, ptr(bytes), BSD_INFO_SIZE) !== BSD_INFO_SIZE) return null;
	if (view.getUint32(12, true) !== pid || view.getUint32(4, true) === ZOMBIE_STATUS) return null;
	return {
		pid,
		parentPid: view.getUint32(16, true),
		groupId: view.getUint32(100, true),
		startedAt: view.getBigUint64(120, true) * 1_000_000n + view.getBigUint64(128, true),
	};
}

function argumentCapacity(symbols: NativeSymbols): number | null {
	const mib = new Int32Array([1, 8]); // CTL_KERN, KERN_ARGMAX
	const value = new Int32Array(1);
	const length = new BigUint64Array([4n]);
	if (symbols.sysctl(ptr(mib), mib.length, ptr(value), ptr(length), null, 0) !== 0 || length[0] !== 4n) return null;
	const capacity = value[0];
	return capacity !== undefined && capacity > 0 ? capacity + 4 : null;
}

/** KERN_PROCARGS2: argc, executable + padding NULs, then exactly argc argv strings; never decode the environment. */
function decodeCommand(bytes: Uint8Array, length: number): string | null {
	if (length < 4) return null;
	const argc = new DataView(bytes.buffer, bytes.byteOffset, length).getInt32(0, true);
	if (argc <= 0 || argc > length - 4) return null;
	let cursor = bytes.indexOf(0, 4);
	if (cursor < 0 || cursor >= length) return null;
	while (cursor < length && bytes[cursor] === 0) cursor++;
	const args: string[] = [];
	let characters = 0;
	for (let index = 0; index < argc && cursor < length && characters < 240; index++) {
		const end = bytes.indexOf(0, cursor);
		if (end < cursor || end >= length) return null;
		const argument = decoder.decode(bytes.subarray(cursor, Math.min(end, cursor + 960))).replace(/\p{Cc}/gu, " ");
		args.push(argument);
		characters += argument.length + 1;
		cursor = end + 1;
	}
	const command = args.join(" ");
	return command.length === 0 ? null : command.length > 240 ? `${command.slice(0, 239)}…` : command;
}

export function openDarwinProcesses(): ProcessSource {
	const library = dlopen("/usr/lib/libproc.dylib", LIBPROC_ABI);
	const symbols = library.symbols;
	const info = new Uint8Array(BSD_INFO_SIZE);
	const infoView = new DataView(info.buffer);
	const usage = new Uint8Array(RUSAGE_SIZE);
	const usageView = new DataView(usage.buffer);
	const path = new Uint8Array(4096);
	const capacity = argumentCapacity(symbols);
	const args = capacity === null ? null : new Uint8Array(capacity);
	const argsLength = new BigUint64Array(1);
	const argsMib = new Int32Array([1, 49, 0]); // CTL_KERN, KERN_PROCARGS2, pid
	let pidBuffer = new Int32Array(1024);

	return {
		snapshot(): SnapshotResult {
			const needed = symbols.proc_listallpids(null, 0);
			if (needed <= 0) return { kind: "unavailable", reason: "proc_listallpids sizing failed" };
			if (needed >= pidBuffer.length) pidBuffer = new Int32Array(needed + 256);
			let count = symbols.proc_listallpids(ptr(pidBuffer), pidBuffer.byteLength);
			// The kernel can add PIDs between sizing and filling. A full buffer is not a complete snapshot.
			while (count >= pidBuffer.length) {
				pidBuffer = new Int32Array(pidBuffer.length * 2);
				count = symbols.proc_listallpids(ptr(pidBuffer), pidBuffer.byteLength);
			}
			if (count <= 0) return { kind: "unavailable", reason: "proc_listallpids enumeration failed" };
			const processes = new Map<number, ProcessRecord>();
			const pids = new Set<number>();
			for (let index = 0; index < count; index++) {
				const pid = pidBuffer[index];
				if (pid === undefined || pid <= 0) continue;
				pids.add(pid);
				const current = readProcess(symbols, info, infoView, pid);
				if (current !== null) processes.set(pid, current);
			}
			// Recheck every parent/group anchor AFTER all candidate relations were read.
			// A reused PID or changed PPID/PGID must never authorize a new ownership edge.
			for (const [pid, current] of processes) {
				if (
					symbols.proc_pidinfo(pid, 3, 0, ptr(info), BSD_INFO_SIZE) !== BSD_INFO_SIZE ||
					infoView.getUint32(12, true) !== pid ||
					infoView.getUint32(4, true) === ZOMBIE_STATUS ||
					infoView.getUint32(16, true) !== current.parentPid ||
					infoView.getUint32(100, true) !== current.groupId ||
					infoView.getBigUint64(120, true) * 1_000_000n + infoView.getBigUint64(128, true) !== current.startedAt
				)
					processes.delete(pid);
			}
			return { kind: "available", snapshot: { processes, pids } };
		},
		process(pid) {
			return readProcess(symbols, info, infoView, pid);
		},
		footprint(pid) {
			return symbols.proc_pid_rusage(pid, 0, ptr(usage)) === 0 ? usageView.getBigUint64(72, true) : null;
		},
		command(pid) {
			if (args !== null) {
				argsMib[2] = pid;
				argsLength[0] = BigInt(args.byteLength);
				try {
					if (symbols.sysctl(ptr(argsMib), argsMib.length, ptr(args), ptr(argsLength), null, 0) === 0) {
						const length = Number(argsLength[0]);
						if (length >= 4 && length <= args.byteLength) {
							const command = decodeCommand(args, length);
							if (command !== null) return command;
						}
					}
				} finally {
					// sysctl may also copy environment bytes; retain neither them nor the full argv.
					args.fill(0);
				}
			}
			const length = symbols.proc_pidpath(pid, ptr(path), path.byteLength);
			return length > 0 ? decoder.decode(path.subarray(0, Math.min(length, 240))) : "(command unavailable)";
		},
		close() {
			library.close();
		},
	};
}

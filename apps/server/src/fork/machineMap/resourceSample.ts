/**
 * Fork: machine map resources (MM-1501). Pure parts of the resource sample: the parsers of the
 * small OS outputs, and the step from raw readings to a sample. Rates need two readings, so each
 * step returns the counters for the next one.
 */
import {
  type ProcessGroupUse,
  type ResourceProcess,
  type ResourceSample,
  TOP_PROCESS_COUNT,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** One row of `ps -A -o pid=,time=,rss=,comm=`. */
export interface PsProcess {
  readonly pid: number;
  /** Total CPU time since the process started. */
  readonly cpuMs: number;
  readonly rssBytes: number;
  readonly name: string;
}

export interface ByteCounters {
  readonly inBytes: number;
  readonly outBytes: number;
}

export interface UsedTotal {
  readonly usedBytes: number;
  readonly totalBytes: number;
}

/** What one sample reads. A null reading becomes null values in the sample. */
export interface RawReadings {
  readonly atMs: number;
  readonly cpuPercent: number | null;
  readonly cpuCount: number | null;
  readonly memory: UsedTotal | null;
  readonly load: readonly [number, number, number] | null;
  readonly swap: UsedTotal | null;
  /** Swap in plus swap out since boot. */
  readonly swapTrafficBytes: number | null;
  readonly disk: UsedTotal | null;
  /** Network bytes since boot, without loopback. */
  readonly net: ByteCounters | null;
  /** `process.cpuUsage()` user plus system, and the RSS of the T3 server. */
  readonly t3: { readonly cpuMicros: number; readonly rssBytes: number };
  readonly agents: ProcessGroupUse | null;
  readonly processes: ReadonlyArray<PsProcess> | null;
}

export interface SampleCounters {
  readonly atMs: number;
  readonly swapTrafficBytes: number | null;
  readonly net: ByteCounters | null;
  readonly t3CpuMicros: number;
  readonly processCpuMs: ReadonlyMap<number, number>;
}

const MAX_NAME = 40;

const round1 = (value: number) => Math.round(value * 10) / 10;

/** The words of one line of OS output, split on spaces and tabs. */
const words = (line: string): Array<string> =>
  line
    .replaceAll("\t", " ")
    .split(" ")
    .filter((word) => word.length > 0);

/** `[[dd-]hh:]mm:ss[.cc]`: Linux prints `01:02:03`, macOS prints `62:03.45`. */
export function parseCpuTime(text: string): number | null {
  const dash = text.indexOf("-");
  const days = dash === -1 ? 0 : Number(text.slice(0, dash));
  const parts = text
    .slice(dash + 1)
    .split(":")
    .map(Number);
  if (parts.length < 2 || parts.length > 3 || !Number.isFinite(days)) return null;
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null;
  const [a = 0, b = 0, c] = parts;
  const seconds = c === undefined ? a * 60 + b : a * 3600 + b * 60 + c;
  return Math.round((days * 86_400 + seconds) * 1000);
}

/** The executable name: the last path part of `comm`, at most 40 characters. */
const executableName = (comm: string): string => {
  const slash = comm.lastIndexOf("/");
  return (slash === -1 ? comm : comm.slice(slash + 1)).slice(0, MAX_NAME);
};

/** `ps -A -o pid=,time=,rss=,comm=`. RSS is in KiB on Linux and macOS. */
export function parsePs(output: string): ReadonlyArray<PsProcess> {
  const processes: Array<PsProcess> = [];
  for (const line of output.split("\n")) {
    const tokens = words(line);
    if (tokens.length < 4) continue;
    const [pidText = "", timeText = "", rssText = ""] = tokens;
    const pid = Number(pidText);
    const rssKib = Number(rssText);
    const cpuMs = parseCpuTime(timeText);
    // The command keeps its spaces: macOS prints the whole path of an app bundle.
    const comm = tokens.slice(3).join(" ");
    if (!Number.isSafeInteger(pid) || !Number.isFinite(rssKib) || cpuMs === null) continue;
    processes.push({ pid, cpuMs, rssBytes: rssKib * 1024, name: executableName(comm) });
  }
  return processes;
}

const meminfoKib = (meminfo: string, key: string): number | null => {
  for (const line of meminfo.split("\n")) {
    if (!line.startsWith(`${key}:`)) continue;
    const value = Number(words(line.slice(key.length + 1))[0]);
    return Number.isFinite(value) ? value : null;
  }
  return null;
};

/** Linux `/proc/meminfo`. A machine without swap reports a total of 0. */
export function parseLinuxSwap(meminfo: string): UsedTotal | null {
  const total = meminfoKib(meminfo, "SwapTotal");
  const free = meminfoKib(meminfo, "SwapFree");
  if (total === null || free === null) return null;
  return { usedBytes: Math.max(0, total - free) * 1024, totalBytes: total * 1024 };
}

/**
 * Linux `/proc/vmstat`: pages swapped in plus out since boot.
 * The kernel counts these in pages of 4 KiB on the machines we run (x86_64 and arm64 defaults).
 * Revisit if a machine runs a kernel with 16 KiB or 64 KiB pages.
 */
export function parseLinuxSwapTraffic(vmstat: string): number | null {
  let pages: number | null = null;
  for (const line of vmstat.split("\n")) {
    const [key, value] = words(line);
    if (key !== "pswpin" && key !== "pswpout") continue;
    const count = Number(value);
    if (!Number.isFinite(count)) return null;
    pages = (pages ?? 0) + count;
  }
  return pages === null ? null : pages * 4096;
}

const SIZE_UNITS: Readonly<Record<string, number>> = {
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

const sizeValue = (text: string | undefined): number | null => {
  if (text === undefined || text.length < 2) return null;
  const unit = SIZE_UNITS[text.slice(-1)];
  const value = Number(text.slice(0, -1));
  return unit === undefined || !Number.isFinite(value) ? null : Math.round(value * unit);
};

/** macOS `sysctl -n vm.swapusage`: `total = 1024.00M  used = 1.25M  free = ...`. */
export function parseDarwinSwap(output: string): UsedTotal | null {
  const tokens = words(output);
  const after = (key: string) => {
    const index = tokens.indexOf(key);
    return index === -1 || tokens[index + 1] !== "=" ? undefined : tokens[index + 2];
  };
  const total = sizeValue(after("total"));
  const used = sizeValue(after("used"));
  return total === null || used === null ? null : { usedBytes: used, totalBytes: total };
}

/** macOS `vm_stat`: swap ins plus swap outs since boot, in bytes. */
export function parseDarwinSwapTraffic(vmStat: string): number | null {
  const pageSizeText = vmStat.split("page size of ")[1]?.split(" ")[0];
  const pageSize = Number(pageSizeText);
  let pages: number | null = null;
  for (const line of vmStat.split("\n")) {
    const [key, value] = line.split(":");
    if (key?.trim() !== "Swapins" && key?.trim() !== "Swapouts") continue;
    const text = value?.trim() ?? "";
    const count = Number(text.endsWith(".") ? text.slice(0, -1) : text);
    if (!Number.isFinite(count)) return null;
    pages = (pages ?? 0) + count;
  }
  return pages === null || !Number.isFinite(pageSize) || pageSize <= 0 ? null : pages * pageSize;
}

/** Linux `/proc/net/dev`, every interface but loopback. */
export function parseLinuxNet(netDev: string): ByteCounters | null {
  let found = false;
  let inBytes = 0;
  let outBytes = 0;
  for (const line of netDev.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    if (name === "lo") continue;
    const fields = words(line.slice(colon + 1)).map(Number);
    // Receive bytes are the first field, transmit bytes the ninth.
    const received = fields[0];
    const sent = fields[8];
    if (received === undefined || sent === undefined) continue;
    if (!Number.isFinite(received) || !Number.isFinite(sent)) continue;
    found = true;
    inBytes += received;
    outBytes += sent;
  }
  return found ? { inBytes, outBytes } : null;
}

/**
 * macOS `netstat -ibn`: the link rows (`<Link#n>`) of every interface but loopback. The address
 * column is empty on some rows, so the byte columns count from the end.
 */
export function parseDarwinNet(netstat: string): ByteCounters | null {
  let found = false;
  let inBytes = 0;
  let outBytes = 0;
  for (const line of netstat.split("\n")) {
    const tokens = words(line);
    const [name = "", , network = ""] = tokens;
    if (!network.startsWith("<Link#") || name.startsWith("lo")) continue;
    // ... Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
    const received = Number(tokens.at(-5));
    const sent = Number(tokens.at(-2));
    if (!Number.isFinite(received) || !Number.isFinite(sent)) continue;
    found = true;
    inBytes += received;
    outBytes += sent;
  }
  return found ? { inBytes, outBytes } : null;
}

/** Bytes per second between two counters, or null after a reset or without a previous one. */
const rate = (current: number | null, previous: number | null, seconds: number): number | null =>
  current === null || previous === null || seconds <= 0 || current < previous
    ? null
    : Math.round((current - previous) / seconds);

const topProcesses = (
  processes: ReadonlyArray<PsProcess>,
  cpuOf: (process: PsProcess) => number | null,
  by: (process: PsProcess) => number,
): ReadonlyArray<ResourceProcess> =>
  processes
    .toSorted((a, b) => by(b) - by(a))
    .slice(0, TOP_PROCESS_COUNT)
    .map((process) => {
      const cpu = cpuOf(process);
      return {
        name: process.name,
        cpuPercent: cpu === null ? null : round1(cpu),
        memoryBytes: process.rssBytes,
      };
    });

/** One sample from raw readings. `previous` is null for the first sample of a connection. */
export function buildSample(
  raw: RawReadings,
  previous: SampleCounters | null,
): { readonly sample: ResourceSample; readonly counters: SampleCounters } {
  const elapsedMs = previous === null ? 0 : raw.atMs - previous.atMs;
  const seconds = elapsedMs / 1000;
  const processCpuMs = new Map(raw.processes?.map((p) => [p.pid, p.cpuMs]) ?? []);

  // The CPU of a process is its CPU time since the previous sample, as a percent of one core.
  const cpuOf = (process: PsProcess): number | null => {
    const before = previous?.processCpuMs.get(process.pid);
    if (before === undefined || elapsedMs <= 0 || process.cpuMs < before) return null;
    return ((process.cpuMs - before) / elapsedMs) * 100;
  };
  const processes = raw.processes;
  const topCpu =
    processes === null || previous === null
      ? null
      : topProcesses(
          processes.filter((p) => (cpuOf(p) ?? 0) > 0),
          cpuOf,
          (p) => cpuOf(p) ?? 0,
        );
  const topMemory =
    processes === null ? null : topProcesses(processes, cpuOf, (p) => p.rssBytes);

  const t3Cpu =
    previous === null || elapsedMs <= 0 || raw.t3.cpuMicros < previous.t3CpuMicros
      ? null
      : round1((raw.t3.cpuMicros - previous.t3CpuMicros) / 10 / elapsedMs);

  const sample: ResourceSample = {
    at: DateTime.formatIso(DateTime.makeUnsafe(raw.atMs)),
    cpuPercent: raw.cpuPercent === null ? null : round1(raw.cpuPercent),
    cpuCount: raw.cpuCount,
    load:
      raw.load === null
        ? null
        : [round1(raw.load[0]), round1(raw.load[1]), round1(raw.load[2])],
    memoryUsedBytes: raw.memory?.usedBytes ?? null,
    memoryTotalBytes: raw.memory?.totalBytes ?? null,
    swapUsedBytes: raw.swap?.usedBytes ?? null,
    swapTotalBytes: raw.swap?.totalBytes ?? null,
    swapBytesPerSecond: rate(
      raw.swapTrafficBytes,
      previous?.swapTrafficBytes ?? null,
      seconds,
    ),
    diskUsedBytes: raw.disk?.usedBytes ?? null,
    diskTotalBytes: raw.disk?.totalBytes ?? null,
    netInBytesPerSecond: rate(
      raw.net?.inBytes ?? null,
      previous?.net?.inBytes ?? null,
      seconds,
    ),
    netOutBytesPerSecond: rate(
      raw.net?.outBytes ?? null,
      previous?.net?.outBytes ?? null,
      seconds,
    ),
    t3: { cpuPercent: t3Cpu, memoryBytes: raw.t3.rssBytes },
    agents:
      raw.agents === null
        ? null
        : {
            count: raw.agents.count,
            cpuPercent: round1(raw.agents.cpuPercent),
            memoryBytes: raw.agents.memoryBytes,
          },
    topCpu,
    topMemory,
  };
  return {
    sample,
    counters: {
      atMs: raw.atMs,
      swapTrafficBytes: raw.swapTrafficBytes,
      net: raw.net,
      t3CpuMicros: raw.t3.cpuMicros,
      processCpuMs,
    },
  };
}

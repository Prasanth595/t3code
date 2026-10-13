// @effect-diagnostics nodeBuiltinImport:off - Effect has no free-space query (statfs).
/**
 * Fork: machine map resources (`apps/machine-map/SPEC.md`, MM-1501). One resource sample of this
 * machine for the portal. `MachineMap` takes a sample every minute while the portal connection is
 * open, so a server with the map off never samples.
 *
 * Each sample stays cheap: CPU and memory come from `HostResources`, the T3 process tree from the
 * native resource monitor that already runs, and the rest from small file reads, `statfs`, and on
 * macOS and Linux at most four short commands (`ps`, plus `vm_stat`, `sysctl` and `netstat` on
 * macOS).
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import type { ResourceSample } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import * as HostResources from "../../resourceTelemetry/HostResources.ts";
import * as ResourceTelemetry from "../../resourceTelemetry/ResourceTelemetry.ts";
import {
  buildSample,
  parseDarwinNet,
  parseDarwinSwap,
  parseDarwinSwapTraffic,
  parseLinuxNet,
  parseLinuxSwap,
  parseLinuxSwapTraffic,
  parsePs,
  type RawReadings,
  type SampleCounters,
  type UsedTotal,
} from "./resourceSample.ts";

export class MachineResources extends Context.Service<
  MachineResources,
  {
    /** MM-1501: one sample. Never fails; a reading that fails becomes null values. */
    readonly sample: Effect.Effect<ResourceSample>;
  }
>()("t3/fork/machineMap/MachineResources") {}

const make = Effect.gen(function* () {
  const hostResources = yield* HostResources.HostResources;
  const telemetry = yield* ResourceTelemetry.ResourceTelemetry;
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const counters = yield* Ref.make<SampleCounters | null>(null);
  // The counters of one sample are the base of the next, so two samples never interleave.
  const oneAtATime = yield* Semaphore.make(1);
  const unix = platform === "darwin" || platform === "linux";

  const output = (command: string, args: ReadonlyArray<string>) =>
    spawner
      .string(ChildProcess.make(command, args, { stdin: "ignore", stderr: "ignore" }))
      .pipe(
        Effect.timeout("2 seconds"),
        Effect.orElseSucceed(() => ""),
      );
  const file = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
  const orNull = <A>(text: string, parse: (text: string) => A | null) =>
    text.length === 0 ? null : parse(text);

  // `df` reports used as blocks minus free blocks, and the total as used plus what a user can
  // still write, so the percent matches `df`.
  const disk = Effect.tryPromise(() => NodeFSP.statfs(config.baseDir, { bigint: true })).pipe(
    Effect.map((stats): UsedTotal => {
      const used = (stats.blocks - stats.bfree) * stats.bsize;
      return { usedBytes: Number(used), totalBytes: Number(used + stats.bavail * stats.bsize) };
    }),
    Effect.orElseSucceed(() => null),
  );

  const swap = Effect.gen(function* () {
    if (platform === "linux") {
      const [meminfo, vmstat] = yield* Effect.all([file("/proc/meminfo"), file("/proc/vmstat")], {
        concurrency: "unbounded",
      });
      return {
        swap: orNull(meminfo, parseLinuxSwap),
        traffic: orNull(vmstat, parseLinuxSwapTraffic),
      };
    }
    if (platform === "darwin") {
      const [usage, vmStat] = yield* Effect.all(
        [output("/usr/sbin/sysctl", ["-n", "vm.swapusage"]), output("/usr/bin/vm_stat", [])],
        { concurrency: "unbounded" },
      );
      return {
        swap: orNull(usage, parseDarwinSwap),
        traffic: orNull(vmStat, parseDarwinSwapTraffic),
      };
    }
    // Windows reports no swap here. Revisit when the Windows machine runs the map and swap matters.
    return { swap: null, traffic: null };
  });

  const net =
    platform === "linux"
      ? file("/proc/net/dev").pipe(Effect.map((text) => orNull(text, parseLinuxNet)))
      : platform === "darwin"
        ? output("/usr/sbin/netstat", ["-ibn"]).pipe(
            Effect.map((text) => orNull(text, parseDarwinNet)),
          )
        : Effect.succeed(null);

  // Windows has no `ps`; its top lists stay null. Revisit when the Windows machine runs the map.
  const processes = unix
    ? output("ps", ["-A", "-o", "pid=,time=,rss=,comm="]).pipe(
        Effect.map((text) => orNull(text, parsePs)),
      )
    : Effect.succeed(null);

  /** The processes that the T3 server started, from the native resource monitor. */
  const agents = telemetry.refresh.pipe(
    Effect.catch(() => telemetry.latest),
    Effect.map((snapshot) => {
      const status = snapshot.health.native.status;
      if (status !== "healthy" && status !== "degraded") return null;
      const children = snapshot.processes.filter((entry) => entry.category === "server-child");
      return {
        count: children.length,
        cpuPercent: children.reduce((sum, entry) => sum + entry.cpuPercent, 0),
        memoryBytes: children.reduce((sum, entry) => sum + entry.residentBytes, 0),
      };
    }),
  );

  const readRaw = Effect.gen(function* () {
    const [host, diskUse, swapUse, netUse, processList, agentUse] = yield* Effect.all(
      [hostResources.read, disk, swap, net, processes, agents],
      { concurrency: "unbounded" },
    );
    const cpu = process.cpuUsage();
    const load = NodeOS.loadavg();
    return {
      atMs: yield* Clock.currentTimeMillis,
      cpuPercent: host.cpuUtilization === null ? null : host.cpuUtilization * 100,
      cpuCount: host.cpuCount > 0 ? host.cpuCount : null,
      memory:
        host.totalMemoryBytes > 0
          ? {
              usedBytes: host.totalMemoryBytes - host.availableMemoryBytes,
              totalBytes: host.totalMemoryBytes,
            }
          : null,
      // Windows has no load average: Node returns zeros there.
      load: platform === "win32" ? null : [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
      swap: swapUse.swap,
      swapTrafficBytes: swapUse.traffic,
      disk: diskUse,
      net: netUse,
      t3: { cpuMicros: cpu.user + cpu.system, rssBytes: process.memoryUsage.rss() },
      agents: agentUse,
      processes: processList,
    } satisfies RawReadings;
  });

  const sample: MachineResources["Service"]["sample"] = oneAtATime.withPermits(1)(
    Effect.gen(function* () {
      const raw = yield* readRaw;
      const next = buildSample(raw, yield* Ref.get(counters));
      yield* Ref.set(counters, next.counters);
      return next.sample;
    }),
  );

  return MachineResources.of({ sample });
});

export const layer = Layer.effect(MachineResources, make);

// @effect-diagnostics nodeBuiltinImport:off -- the guard reads RAM size and signals host processes it found under the server.
import * as NodeOS from "node:os";

import { PROCESS_OWNER_ENV } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { PROCESS_OWNER_INSTANCE } from "./agentScope.ts";

const WARNING_PRESSURE_LEVEL = 2;
const CRITICAL_PRESSURE_LEVEL = 4;
const WARNING_GRACE_MS = 30_000;
const CRITICAL_RESCAN_MS = 10_000;
const MIN_VICTIM_BYTES = 1024 ** 3;
const CRITICAL_SERVER_SHARE = 0.25;
const WARNING_SERVER_SHARE = 0.5;
const CHECK_INTERVAL = "2 seconds";
const RECLAIM_WAIT = "10 seconds";
const FREEZE_ROUNDS = 5;
const MAX_COMMAND_LENGTH = 200;
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "nu", "pwsh"]);
const UNIT_BYTES: Record<string, number> = {
  B: 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly bytes: number;
  readonly command: string;
}

export interface Victim {
  readonly pid: number;
  readonly command: string;
  readonly bytes: number;
  readonly pids: ReadonlyArray<number>;
  readonly owner?: string | undefined;
  readonly codexThreadId?: string | undefined;
}

/** Parses `top -l 1 -stats pid,ppid,mem,command`. MEM is the footprint, compressed pages included. */
export function parseTopProcesses(text: string): Array<ProcessEntry> {
  const entries: Array<ProcessEntry> = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)([BKMGT])[+-]?\s+(.*)$/.exec(line);
    if (match === null) continue;
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      bytes: Number(match[3]) * (UNIT_BYTES[match[4]!] ?? 1),
      command: match[5]!.trim(),
    });
  }
  return entries;
}

const isShell = (command: string) => SHELLS.has(command.replace(/^-/, ""));

export interface ProcessEnvironment {
  readonly owner?: string | undefined;
  readonly codexToolCall: boolean;
  readonly codexThreadId?: string | undefined;
}

const lastValue = (line: string, name: string) =>
  [...line.matchAll(new RegExp(`(?:^|\\s)${name}=(\\S+)`, "g"))].at(-1)?.[1];

/**
 * Parses `ps -axEww -o pid=,command=`, whose lines end with the environment, so
 * the last match wins. macOS hides the environment of its own binaries, such as
 * the shells, but not of the commands they run.
 */
export function parseProcessEnvironment(text: string): Map<number, ProcessEnvironment> {
  const environment = new Map<number, ProcessEnvironment>();
  for (const line of text.split("\n")) {
    const pid = /^\s*(\d+)\s/.exec(line);
    if (pid === null) continue;
    const owner = lastValue(line, PROCESS_OWNER_ENV);
    const codexToolCall = lastValue(line, "CODEX_TOOL_CALL_ID") !== undefined;
    if (owner === undefined && !codexToolCall) continue;
    environment.set(Number(pid[1]), {
      owner,
      codexToolCall,
      codexThreadId: lastValue(line, "CODEX_THREAD_ID"),
    });
  }
  return environment;
}

export function parseOwner(owner: string) {
  const [instance = "", kind = "", ...thread] = owner.split(":");
  const threadId = thread.join(":");
  return { instance, kind, threadId: threadId.length > 0 ? threadId : undefined };
}

/**
 * Victims are the outermost commands a shell under the server launched, such as
 * a test suite with its workers, and agent processes this server started that
 * outlived their parent. Agents, their launchers, MCP servers, the preview
 * browser, and jobs a user detached from a terminal are never picked, so
 * sessions survive and only see a command fail. Nothing is killed unless the
 * server's processes hold the given share of RAM, so pressure from other apps
 * never costs a session its command.
 */
export function pickVictim(
  entries: ReadonlyArray<ProcessEntry>,
  options: {
    readonly serverPid: number;
    readonly totalMemoryBytes: number;
    readonly minServerShare: number;
    readonly ownerInstance?: string | undefined;
    readonly environment?: ReadonlyMap<number, ProcessEnvironment> | undefined;
  },
): Victim | undefined {
  const environment = options.environment ?? new Map<number, ProcessEnvironment>();
  const children = new Map<number, Array<ProcessEntry>>();
  for (const entry of entries) {
    if (entry.pid === entry.ppid) continue;
    const siblings = children.get(entry.ppid);
    if (siblings === undefined) children.set(entry.ppid, [entry]);
    else siblings.push(entry);
  }
  const collect = (root: ProcessEntry) => {
    const pids: Array<number> = [];
    let bytes = 0;
    let owner: string | undefined;
    let codexThreadId: string | undefined;
    const stack = [root];
    while (stack.length > 0) {
      const entry = stack.pop()!;
      pids.push(entry.pid);
      bytes += entry.bytes;
      owner ??= environment.get(entry.pid)?.owner;
      codexThreadId ??= environment.get(entry.pid)?.codexThreadId;
      stack.push(...(children.get(entry.pid) ?? []));
    }
    return { pids, bytes, owner, codexThreadId };
  };

  let serverTreeBytes = entries.find((entry) => entry.pid === options.serverPid)?.bytes ?? 0;
  let victim: Victim | undefined;
  const consider = (root: ProcessEntry) => {
    const tree = collect(root);
    serverTreeBytes += tree.bytes;
    if (tree.bytes >= MIN_VICTIM_BYTES && (victim === undefined || tree.bytes > victim.bytes)) {
      victim = { pid: root.pid, command: root.command, ...tree };
    }
  };
  const startsCommand = (entry: ProcessEntry, parent: ProcessEntry) => {
    // Codex execs its shell into the command, so its commands have no shell
    // parent; they are the outermost processes carrying a tool call id.
    if (
      environment.get(entry.pid)?.codexToolCall === true &&
      environment.get(parent.pid)?.codexToolCall !== true
    ) {
      return true;
    }
    if (!isShell(parent.command)) return false;
    if (parent.ppid !== options.serverPid) return true;
    // A shell the server started is a terminal or a launcher an agent is
    // configured to run through. Agents are never Apple binaries, so their
    // owner is readable; a child without one is a terminal command such as
    // xcodebuild, whose environment macOS hides.
    const owner = environment.get(entry.pid)?.owner;
    return owner === undefined || parseOwner(owner).kind === "terminal";
  };
  const stack = [...(children.get(options.serverPid) ?? [])];
  while (stack.length > 0) {
    const entry = stack.pop()!;
    serverTreeBytes += entry.bytes;
    for (const child of children.get(entry.pid) ?? []) {
      if (startsCommand(child, entry)) consider(child);
      else stack.push(child);
    }
  }
  if (options.ownerInstance !== undefined) {
    for (const orphan of children.get(1) ?? []) {
      const owner = environment.get(orphan.pid)?.owner;
      if (owner === undefined) continue;
      const { instance, kind } = parseOwner(owner);
      if (instance === options.ownerInstance && kind !== "terminal") consider(orphan);
    }
  }
  return serverTreeBytes >= options.totalMemoryBytes * options.minServerShare ? victim : undefined;
}

/** Processes in `ps -axo pid=,ppid=` output that descend from `known` but are not in it yet. */
export function newDescendants(table: string, known: ReadonlySet<number>): Array<number> {
  const children = new Map<number, Array<number>>();
  for (const line of table.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (match === null) continue;
    const [pid, ppid] = [Number(match[1]), Number(match[2])];
    const siblings = children.get(ppid);
    if (siblings === undefined) children.set(ppid, [pid]);
    else siblings.push(pid);
  }
  const found: Array<number> = [];
  const seen = new Set(known);
  const stack = [...known];
  while (stack.length > 0) {
    for (const child of children.get(stack.pop()!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      stack.push(child);
    }
  }
  return found;
}

export interface StoppedCommand {
  readonly threadId: string;
  readonly codexThreadId?: string | undefined;
  readonly command: string;
  readonly cwd: string;
  readonly bytes: number;
  readonly processes: number;
  readonly pressure: "critical" | "warning";
}

/** Tells the thread whose command the guard stopped. */
export class MemoryGuardNotices extends Context.Service<
  MemoryGuardNotices,
  { readonly commandStopped: (stopped: StoppedCommand) => Effect.Effect<void> }
>()("t3/process/memoryGuard/MemoryGuardNotices") {}

/**
 * macOS has no cgroups, so concurrent agent commands can push memory pressure
 * until the machine stalls. Linux caps agents with a systemd slice instead.
 * Critical pressure acts at once. Warning pressure acts only when it lasts and
 * the server's processes hold half of RAM, since warning alone is common.
 */
const run = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const settings = yield* ServerSettings.ServerSettingsService;
  const notices = yield* MemoryGuardNotices;
  const enabled = settings.getSettings.pipe(
    Effect.map((current) => current.memoryGuardEnabled),
    Effect.orElseSucceed(() => false),
  );
  const totalMemoryBytes = NodeOS.totalmem();
  const read = (command: string, args: ReadonlyArray<string>) =>
    // `ps -E` prints every process environment, which can pass the default 8 MB cap.
    runner.run({ command, args, timeout: "30 seconds", maxOutputBytes: 64 * 1024 ** 2 }).pipe(
      Effect.option,
      Effect.map((result) =>
        result._tag === "Some" && result.value.code === 0 ? result.value.stdout : undefined,
      ),
    );
  const signal = (pid: number, name: NodeJS.Signals) =>
    Effect.try(() => process.kill(pid, name)).pipe(Effect.ignore);
  // Commands share their shell's process group, so a group kill cannot reach
  // workers forked after the snapshot. Freeze the tree, freeze what it forked
  // meanwhile, then kill all of it.
  const killTree = (pids: ReadonlyArray<number>) =>
    Effect.gen(function* () {
      const tree = new Set(pids);
      yield* Effect.forEach(tree, (pid) => signal(pid, "SIGSTOP"), { discard: true });
      for (let round = 0; round < FREEZE_ROUNDS; round++) {
        const table = yield* read("/bin/ps", ["-axo", "pid=,ppid="]);
        const forked = table === undefined ? [] : newDescendants(table, tree);
        if (forked.length === 0) break;
        for (const pid of forked) tree.add(pid);
        yield* Effect.forEach(forked, (pid) => signal(pid, "SIGSTOP"), { discard: true });
      }
      yield* Effect.forEach(tree, (pid) => signal(pid, "SIGKILL"), { discard: true });
      return tree.size;
    });
  const readCwd = (pid: number) =>
    read("/usr/sbin/lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"]).pipe(
      Effect.map((output) =>
        output
          ?.split("\n")
          .find((line) => line.startsWith("n"))
          ?.slice(1),
      ),
    );
  let warningSince: number | undefined;
  let nextScan = 0;

  const check = Effect.gen(function* () {
    if (!(yield* enabled)) {
      warningSince = undefined;
      return;
    }
    const level = Number(
      (yield* read("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]))?.trim(),
    );
    const now = yield* Clock.currentTimeMillis;
    let minServerShare = CRITICAL_SERVER_SHARE;
    if (level < WARNING_PRESSURE_LEVEL || Number.isNaN(level)) {
      warningSince = undefined;
      return;
    }
    const critical = level >= CRITICAL_PRESSURE_LEVEL;
    if (!critical) {
      warningSince ??= now;
      if (now - warningSince < WARNING_GRACE_MS) return;
      minServerShare = WARNING_SERVER_SHARE;
    }
    if (now < nextScan) return;
    const [top, environment] = yield* Effect.all(
      [
        read("/usr/bin/top", ["-l", "1", "-stats", "pid,ppid,mem,command"]),
        read("/bin/ps", ["-axEww", "-o", "pid=,command="]),
      ],
      { concurrency: 2 },
    );
    // Without environments, an agent launched through a shell looks like a command.
    if (top === undefined || environment === undefined) return;
    const victim = pickVictim(parseTopProcesses(top), {
      serverPid: process.pid,
      totalMemoryBytes,
      minServerShare,
      ownerInstance: PROCESS_OWNER_INSTANCE,
      environment: parseProcessEnvironment(environment),
    });
    if (victim === undefined) {
      nextScan = now + (critical ? CRITICAL_RESCAN_MS : WARNING_GRACE_MS);
      return;
    }
    const owner = victim.owner === undefined ? undefined : parseOwner(victim.owner);
    const threadId =
      owner?.instance === PROCESS_OWNER_INSTANCE && owner.kind !== "terminal"
        ? owner.threadId
        : undefined;
    const cwd = threadId === undefined ? undefined : yield* readCwd(victim.pid);
    const commandLine =
      threadId === undefined
        ? victim.command
        : (yield* read("/bin/ps", ["-o", "command=", "-p", String(victim.pid)]))
            ?.trim()
            .slice(0, MAX_COMMAND_LENGTH) || victim.command;
    const processes = yield* killTree(victim.pids);
    const pressure = critical ? "critical" : "warning";
    yield* Effect.logWarning("Killed the largest agent command: memory pressure is high", {
      pid: victim.pid,
      command: victim.command,
      bytes: victim.bytes,
      processes,
      pressure,
      threadId,
    });
    if (threadId !== undefined && cwd !== undefined) {
      yield* notices.commandStopped({
        threadId,
        codexThreadId: victim.codexThreadId,
        command: commandLine,
        cwd,
        bytes: victim.bytes,
        processes,
        pressure,
      });
    }
    yield* Effect.sleep(RECLAIM_WAIT);
  });

  return yield* check.pipe(Effect.repeat(Schedule.spaced(CHECK_INTERVAL)), Effect.asVoid);
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "darwin") yield* Effect.forkScoped(run);
  }),
);

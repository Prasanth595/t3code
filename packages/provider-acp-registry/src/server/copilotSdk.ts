// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Windows path math must run on any host for the shim lookup, and the SDK's child is a Node ChildProcess. The SDK seam is Promise-based, outside an Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type {
  CopilotSession,
  MessageOptions,
  ResumeSessionConfig,
  SessionConfig,
} from "@github/copilot-sdk";

/** The part of a Copilot SDK session the adapter drives; tests replace it with a fake. */
export interface CopilotSdkSession {
  readonly sessionId: string;
  readonly send: (options: MessageOptions) => Promise<string>;
  readonly sendAndWait: (options: MessageOptions, timeout?: number) => Promise<unknown>;
  readonly abort: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
  readonly rpc: {
    // switchTo, not setModel: only switchTo can clear an effort override (null).
    readonly model: Pick<CopilotSession["rpc"]["model"], "switchTo">;
    readonly mode: Pick<CopilotSession["rpc"]["mode"], "set">;
    readonly permissions: Pick<
      CopilotSession["rpc"]["permissions"],
      "setMode" | "handlePendingPermissionRequest"
    >;
    readonly tasks: Pick<CopilotSession["rpc"]["tasks"], "waitForPending" | "list">;
    readonly history: Pick<CopilotSession["rpc"]["history"], "compact">;
  };
}

export interface CopilotSdkClient {
  /** Spawns the CLI and runs the SDK's handshake with it. */
  readonly start: () => Promise<void>;
  readonly createSession: (config: SessionConfig) => Promise<CopilotSdkSession>;
  readonly resumeSession: (
    sessionId: string,
    config: ResumeSessionConfig,
  ) => Promise<CopilotSdkSession>;
  readonly stop: () => Promise<ReadonlyArray<Error>>;
  readonly forceStop: () => Promise<void>;
  /**
   * The Copilot process, so T3 can see it exit and stop its whole process tree. Undefined until
   * start() spawned it; once read, kept, since a failed stop() clears the SDK's own field.
   */
  readonly process: CopilotProcess | undefined;
}

export interface CopilotProcess {
  readonly id: number;
  /** True once the process exited; its pid may then belong to another process. */
  readonly hasExited: () => boolean;
  /** Resolves after the exit and after the SDK dispatched every notification it had read. */
  readonly exited: Promise<void>;
  /** SIGKILLs the process directly, for when the SDK no longer tracks it. */
  readonly kill: () => void;
  /**
   * Linux and macOS: freezes the CLI and SIGKILLs every process under it, which the SDK's kill
   * leaves running. Resolves with why it may have missed some.
   */
  readonly killDescendants: () => Promise<string | undefined>;
}

// A grandchild holding an inherited pipe can keep stdio open long after the exit.
const STDIO_CLOSE_TIMEOUT_MS = 5_000;
const PROCESS_LIST_TIMEOUT_MS = 5_000;

/** Pids under `rootPid` in a `pid ppid` listing, each parent before its children. */
export function descendantPids(listing: string, rootPid: number): ReadonlyArray<number> {
  const children = new Map<number, Array<number>>();
  for (const line of listing.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || !(pid > 1) || !Number.isSafeInteger(ppid)) {
      continue;
    }
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: Array<number> = [];
  const seen = new Set([rootPid]);
  const pending = [rootPid];
  for (let parent = pending.shift(); parent !== undefined; parent = pending.shift()) {
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      pending.push(child);
    }
  }
  return found;
}

/** Which process holds a pid: its parent, and its start time to tell a reused pid apart. */
export interface ProcessIdentity {
  readonly parent: number;
  readonly started: string;
}

/** From /proc; undefined once the process is gone. */
async function linuxIdentity(pid: string | number): Promise<ProcessIdentity | undefined> {
  try {
    // The command name in parentheses may hold spaces. After it come the state, the parent
    // pid, and 17 more fields up to the start time in clock ticks since boot.
    const stat = await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const started = fields[19];
    return started === undefined ? undefined : { parent: Number(fields[1]), started };
  } catch {
    return undefined;
  }
}

const hasProc = () =>
  NodeFSP.access("/proc/self/stat").then(
    () => true,
    () => false,
  );

const runPs = (args: ReadonlyArray<string>) =>
  new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile("ps", args, { timeout: PROCESS_LIST_TIMEOUT_MS }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

/** `pid ppid` lines; Linux reads /proc, so slim images without `ps` work too. */
const listProcesses = async (): Promise<string> => {
  if (!(await hasProc())) return runPs(["-A", "-o", "pid=,ppid="]);
  const entries = (await NodeFSP.readdir("/proc")).filter((entry) => /^[1-9][0-9]*$/.test(entry));
  const identities = await Promise.all(entries.map(linuxIdentity));
  return entries.map((entry, index) => `${entry} ${identities[index]?.parent ?? ""}`).join("\n");
};

const identify = async (pid: number): Promise<ProcessIdentity | undefined> => {
  if (await hasProc()) return linuxIdentity(pid);
  // lstart is the start time to the second, e.g. "Thu Oct 30 13:01:02 2026".
  const line = await runPs(["-o", "ppid=,lstart=", "-p", String(pid)]).then(
    (stdout) => stdout.trim(),
    () => "",
  );
  const [parent, ...started] = line.split(/\s+/);
  return parent === undefined || parent === "" || started.length === 0
    ? undefined
    : { parent: Number(parent), started: started.join(" ") };
};

/** False when the process refused the signal, such as one running as root; gone counts as sent. */
const signalProcess = (pid: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(pid, signal);
    return true;
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code === "ESRCH";
  }
};

// Each pass freezes one more generation; a tree still growing after this many is reported.
const MAX_FREEZE_PASSES = 16;

/**
 * Freezes `rootPid` and every process under it, then SIGKILLs the descendants. A listing that
 * finds nothing new proves the frozen tree complete. Resolves with why it may have missed some.
 */
export async function stopProcessTree(input: {
  readonly rootPid: number;
  readonly rootExited: () => boolean;
  readonly list: () => Promise<string>;
  readonly identify: (pid: number) => Promise<ProcessIdentity | undefined>;
  /** False when the process refused the signal; a process already gone counts as signalled. */
  readonly signal: (pid: number, signal: NodeJS.Signals) => boolean;
  readonly selfPid: number;
}): Promise<string | undefined> {
  // Start times by pid, parents first. Each was under the CLI or a frozen process when frozen.
  const frozen = new Map<number, string>();
  const refused = new Set<number>();
  const send = (pid: number, signal: NodeJS.Signals) => {
    const sent = input.signal(pid, signal);
    if (!sent) refused.add(pid);
    return sent;
  };
  const killFrozen = async (failure: string | undefined) => {
    for (const [pid, started] of [...frozen].reverse()) {
      // Someone else can kill a frozen process too, and its pid can then be reused. Checking
      // the start time leaves only the instant before the signal, as for the ACP path.
      if ((await input.identify(pid))?.started === started) send(pid, "SIGKILL");
    }
    if (failure !== undefined) return failure;
    return refused.size === 0
      ? undefined
      : `Copilot's processes ${[...refused].join(", ")} refused to stop`;
  };
  const exitedFailure = "Copilot exited before all of its processes were found";
  send(input.rootPid, "SIGSTOP");
  try {
    for (let pass = 0; pass < MAX_FREEZE_PASSES; pass += 1) {
      const listing = await input.list();
      // Once the CLI exited its pid can be reused, so this listing may show another tree.
      if (input.rootExited()) return await killFrozen(exitedFailure);
      const fresh = descendantPids(listing, input.rootPid).filter(
        (pid) => pid !== input.selfPid && !frozen.has(pid) && !refused.has(pid),
      );
      if (fresh.length === 0) return await killFrozen(undefined);
      // Parents come first, so each one's parent is frozen by the time it is checked.
      for (const pid of fresh) {
        // A listed pid can exit and be reused before its SIGSTOP; its parent tells them apart.
        const identity = await input.identify(pid);
        if (input.rootExited()) return await killFrozen(exitedFailure);
        if (
          identity === undefined ||
          (identity.parent !== input.rootPid && !frozen.has(identity.parent))
        ) {
          continue;
        }
        if (send(pid, "SIGSTOP")) frozen.set(pid, identity.started);
      }
    }
    return await killFrozen(`Copilot kept starting processes after ${MAX_FREEZE_PASSES} passes`);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return await killFrozen(`listing Copilot's processes failed: ${reason}`);
  }
}

/**
 * Tracks the SDK client's CLI child. Its exit alone is too early: notifications can still sit
 * in stdout or in the connection's queue, so this waits for stdio to close, then for the
 * connection's drain, the barrier the SDK itself awaits before it marks sessions disconnected.
 */
export function copilotClientProcess(client: object): CopilotProcess | undefined {
  // SDK 1.0.28 has no exit notification, pid accessor or drain hook; its CLI child and its
  // connection (with a memoized drain()) are private fields.
  const child: unknown = Reflect.get(client, "cliProcess");
  const connection: unknown = Reflect.get(client, "connection");
  const drain: unknown =
    typeof connection === "object" && connection !== null
      ? Reflect.get(connection, "drain")
      : undefined;
  if (!(child instanceof NodeChildProcess.ChildProcess) || child.pid === undefined) {
    return undefined;
  }
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  const stdioClosed = new Promise<void>((resolve) => {
    if (hasExited()) return resolve();
    child.once("close", () => resolve());
    child.once("exit", () => setTimeout(resolve, STDIO_CLOSE_TIMEOUT_MS).unref());
  });
  const pid = child.pid;
  return {
    id: pid,
    hasExited,
    kill: () => void child.kill("SIGKILL"),
    // Once the CLI exited its pid can be recycled, so only a live CLI's tree is ours.
    killDescendants: () =>
      hasExited()
        ? Promise.resolve(undefined)
        : stopProcessTree({
            rootPid: pid,
            rootExited: hasExited,
            list: listProcesses,
            identify,
            signal: signalProcess,
            selfPid: process.pid,
          }),
    exited: stdioClosed
      .then(() => (typeof drain === "function" ? Reflect.apply(drain, connection, []) : undefined))
      .then(
        () => undefined,
        () => undefined,
      ),
  };
}

export interface CopilotSdkClientOptions {
  readonly cliPath: string;
  readonly cwd: string;
  /** Replaces the inherited environment of the Copilot process. */
  readonly env: Readonly<Record<string, string>>;
}

export type MakeCopilotSdkClient = (options: CopilotSdkClientOptions) => Promise<CopilotSdkClient>;

// Loaded on first use so servers without T3_COPILOT_SDK never evaluate the SDK.
export const makeCopilotSdkClient: MakeCopilotSdkClient = async (options) => {
  const { CopilotClient, RuntimeConnection } = await import("@github/copilot-sdk");
  // An explicit stdio connection keeps the SDK off its koffi-backed in-process transport.
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: options.cliPath, env: { ...options.env } }),
    workingDirectory: options.cwd,
    useLoggedInUser: true,
  });
  let tracked: CopilotProcess | undefined;
  return {
    start: () => client.start(),
    createSession: (config) => client.createSession(config),
    resumeSession: (sessionId, config) => client.resumeSession(sessionId, config),
    stop: () => client.stop(),
    forceStop: () => client.forceStop(),
    get process() {
      tracked ??= copilotClientProcess(client);
      return tracked;
    },
  };
};

const WINDOWS_SHIM_EXTENSIONS = new Set([".cmd", ".bat", ".ps1", ""]);

/**
 * Executables to try, in order, for the command the ACP Registry resolved. The SDK spawns
 * without a shell, so an npm Windows shim maps to the Copilot binary it launches, then to
 * the loader script the SDK runs with Node.
 */
export function copilotSdkCliCandidates(input: {
  readonly command: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
}): ReadonlyArray<string> {
  const path = NodePath.win32;
  if (
    input.platform !== "win32" ||
    !WINDOWS_SHIM_EXTENSIONS.has(path.extname(input.command).toLowerCase())
  ) {
    return [input.command];
  }
  const scope = path.join(path.dirname(input.command), "node_modules", "@github");
  const binary = path.join(`copilot-win32-${input.architecture}`, "copilot.exe");
  return [
    path.join(scope, "copilot", "node_modules", "@github", binary),
    path.join(scope, binary),
    path.join(scope, "copilot", "npm-loader.js"),
  ];
}

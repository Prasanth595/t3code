import type {
  DesktopSshAutoPortForwardSyncResult,
  DesktopSshEnvironmentTarget,
  DesktopSshPortForward,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import {
  baseSshArgs,
  buildSshHostSpecEffect,
  resolveSshCommand,
  resolveSshTarget,
  sshTargetLogFields,
  targetConnectionKey,
} from "./command.ts";
import {
  SshCommandError,
  SshInvalidTargetError,
  SshPasswordPromptError,
} from "./errors.ts";

const TUNNEL_SHUTDOWN_TIMEOUT_MS = 2_000;
const TUNNEL_STDERR_TAIL_CHARS = 4_096;
const FORWARD_ESTABLISH_PROBE_MS = 250;

export interface SshPortForwardEntry {
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly localPort: number;
  readonly localUrl: string;
  readonly process: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
}

export interface SshPortForwardManagerShape {
  readonly forwardPort: (
    target: DesktopSshEnvironmentTarget,
    remotePort: number,
    preferredLocalPort?: number,
  ) => Effect.Effect<
    DesktopSshPortForward,
    SshCommandError | SshInvalidTargetError | SshPasswordPromptError | NetService.NetError,
    | ChildProcessSpawner.ChildProcessSpawner
    | NetService.NetService
    | SshAuth.SshPasswordPrompt
  >;

  readonly unforwardPort: (
    target: DesktopSshEnvironmentTarget,
    remotePort: number,
  ) => Effect.Effect<boolean>;

  readonly listForwardedPorts: (
    target?: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<ReadonlyArray<DesktopSshPortForward>>;

  readonly syncAutoPortForwards: (
    target: DesktopSshEnvironmentTarget,
    discoveredRemotePorts: ReadonlyArray<number>,
    excludePorts?: ReadonlyArray<number>,
  ) => Effect.Effect<
    DesktopSshAutoPortForwardSyncResult,
    SshCommandError | SshInvalidTargetError | SshPasswordPromptError | NetService.NetError,
    | ChildProcessSpawner.ChildProcessSpawner
    | NetService.NetService
    | SshAuth.SshPasswordPrompt
  >;

  readonly closeAllForTarget: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<void>;
}

export class SshPortForwardManager extends Context.Service<
  SshPortForwardManager,
  SshPortForwardManagerShape
>()("@t3tools/ssh/portForward/SshPortForwardManager") {}

const forwardKey = (target: DesktopSshEnvironmentTarget, remotePort: number): string =>
  `${targetConnectionKey(target)}\u0000${remotePort}`;

const toContractPortForward = (
  entry: SshPortForwardEntry,
  status: DesktopSshPortForward["status"] = "active",
  error?: string,
): DesktopSshPortForward => ({
  target: entry.target,
  remotePort: entry.remotePort,
  localPort: entry.localPort,
  localUrl: entry.localUrl,
  status,
  ...(error ? { error } : {}),
});

export const makeSshPortForwardManager = Effect.fn(
  "ssh/portForward.makeSshPortForwardManager",
)(function* (): Effect.fn.Return<SshPortForwardManagerShape, never, Scope.Scope> {
  const managerScope = yield* Scope.Scope;
  const forwardsRef = yield* Ref.make<Map<string, SshPortForwardEntry>>(new Map());

  const closeEntry = Effect.fn("ssh/portForward.closeEntry")(function* (
    entry: SshPortForwardEntry,
  ) {
    yield* Effect.logDebug("ssh.portForward.close.start", {
      ...sshTargetLogFields(entry.target),
      remotePort: entry.remotePort,
      localPort: entry.localPort,
    });
    yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
    yield* Effect.logInfo("ssh.portForward.close.succeeded", {
      ...sshTargetLogFields(entry.target),
      remotePort: entry.remotePort,
      localPort: entry.localPort,
    });
  });

  yield* Scope.addFinalizer(
    managerScope,
    Effect.gen(function* () {
      const current = yield* Ref.get(forwardsRef);
      const entries = [...current.values()];
      yield* Effect.forEach(entries, closeEntry, { concurrency: "unbounded" }).pipe(
        Effect.ignore,
      );
      yield* Ref.set(forwardsRef, new Map());
    }),
  );

  const forwardPort: SshPortForwardManagerShape["forwardPort"] = Effect.fn(
    "ssh/portForward.forwardPort",
  )(function* (target, remotePort, preferredLocalPort) {
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    const key = forwardKey(resolvedTarget, remotePort);
    const currentForwards = yield* Ref.get(forwardsRef);
    const existing = currentForwards.get(key);
    if (existing) {
      return toContractPortForward(existing);
    }

    const net = yield* NetService.NetService;
    const preferred = preferredLocalPort && preferredLocalPort > 0 ? preferredLocalPort : remotePort;
    const localPort = yield* net.findAvailablePort(preferred);
    const localUrl = `http://127.0.0.1:${localPort}`;

    const hostSpec = yield* buildSshHostSpecEffect(resolvedTarget);
    const childEnvironment = yield* SshAuth.buildSshChildEnvironment({}).pipe(
      Effect.mapError(
        (cause) =>
          new SshCommandError({
            command: ["ssh"],
            exitCode: null,
            stderr: "",
            message: "Failed to prepare SSH authentication helpers for port forward.",
            cause,
          }),
      ),
    );

    const args = [
      ...baseSshArgs(resolvedTarget, { batchMode: "no" }),
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
      "-o",
      "ControlPersist=no",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-n",
      "-N",
      "-L",
      `${localPort}:127.0.0.1:${remotePort}`,
      "--",
      hostSpec,
    ];

    const sshCommand = yield* resolveSshCommand;
    const forwardCommand = [sshCommand, ...args];
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const entryScope = yield* Scope.make("sequential");

    yield* Effect.logDebug("ssh.portForward.spawn.start", {
      ...sshTargetLogFields(resolvedTarget),
      command: forwardCommand,
      localPort,
      remotePort,
    });

    const child = yield* spawner
      .spawn(
        ChildProcess.make(sshCommand, args, {
          env: childEnvironment,
          extendEnv: true,
          stdin: {
            stream: Stream.empty,
            endOnDone: true,
          },
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, entryScope),
        Effect.mapError(
          (cause) =>
            new SshCommandError({
              command: forwardCommand,
              exitCode: null,
              stderr: "",
              message:
                cause instanceof Error
                  ? cause.message
                  : `Failed to spawn SSH port forward ${localPort}:${remotePort} for ${resolvedTarget.alias}.`,
              cause,
            }),
        ),
      );

    let stderrTail = "";
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          stderrTail = (stderrTail + chunk).slice(-TUNNEL_STDERR_TAIL_CHARS);
        }),
      ),
      Effect.ignore,
      Effect.forkIn(entryScope),
    );

    // Give SSH a brief window to fail immediately if the forward could not bind or connect
    const exitOrProbe = yield* Effect.raceFirst(
      child.exitCode.pipe(Effect.map(Number)),
      Effect.sleep(Duration.millis(FORWARD_ESTABLISH_PROBE_MS)).pipe(Effect.as(null)),
    );

    if (exitOrProbe !== null) {
      yield* Scope.close(entryScope, Exit.void).pipe(Effect.ignore);
      return yield* new SshCommandError({
        command: forwardCommand,
        exitCode: exitOrProbe,
        stderr: stderrTail,
        message:
          stderrTail.trim().length > 0
            ? stderrTail.trim()
            : `SSH port forward failed immediately (exit ${exitOrProbe}).`,
      });
    }

    const entry: SshPortForwardEntry = {
      key,
      target: resolvedTarget,
      remotePort,
      localPort,
      localUrl,
      process: child,
      scope: entryScope,
    };

    yield* Scope.addFinalizer(
      entryScope,
      child
        .kill({
          killSignal: "SIGTERM",
          forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
        })
        .pipe(Effect.ignore),
    );

    yield* Ref.update(forwardsRef, (map) => {
      const next = new Map(map);
      next.set(key, entry);
      return next;
    });

    yield* Effect.logInfo("ssh.portForward.spawn.succeeded", {
      ...sshTargetLogFields(resolvedTarget),
      localPort,
      remotePort,
      localUrl,
    });

    return toContractPortForward(entry);
  });

  const unforwardPort: SshPortForwardManagerShape["unforwardPort"] = Effect.fn(
    "ssh/portForward.unforwardPort",
  )(function* (target, remotePort) {
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    const key = forwardKey(resolvedTarget, remotePort);
    const current = yield* Ref.get(forwardsRef);
    const entry = current.get(key);
    if (!entry) {
      return false;
    }

    yield* Ref.update(forwardsRef, (map) => {
      const next = new Map(map);
      next.delete(key);
      return next;
    });

    yield* closeEntry(entry);
    return true;
  });

  const listForwardedPorts: SshPortForwardManagerShape["listForwardedPorts"] = Effect.fn(
    "ssh/portForward.listForwardedPorts",
  )(function* (target) {
    const current = yield* Ref.get(forwardsRef);
    const all = [...current.values()];
    if (!target) {
      return all.map((e) => toContractPortForward(e));
    }
    const targetKey = targetConnectionKey(target);
    return all
      .filter((e) => targetConnectionKey(e.target) === targetKey)
      .map((e) => toContractPortForward(e));
  });

  const syncAutoPortForwards: SshPortForwardManagerShape["syncAutoPortForwards"] = Effect.fn(
    "ssh/portForward.syncAutoPortForwards",
  )(function* (target, discoveredRemotePorts, excludePorts = []) {
    const excluded = new Set(excludePorts);
    const targetPortsToForward = discoveredRemotePorts.filter(
      (p) => Number.isInteger(p) && p > 0 && p < 65536 && !excluded.has(p),
    );

    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    const targetKey = targetConnectionKey(resolvedTarget);

    const currentMap = yield* Ref.get(forwardsRef);
    const existingTargetEntries = [...currentMap.values()].filter(
      (e) => targetConnectionKey(e.target) === targetKey,
    );
    const existingPorts = new Set(existingTargetEntries.map((e) => e.remotePort));
    const targetPortsSet = new Set(targetPortsToForward);

    const forwarded: number[] = [];
    const unforwarded: number[] = [];

    // Forward newly discovered ports
    for (const port of targetPortsToForward) {
      if (!existingPorts.has(port)) {
        const result = yield* Effect.exit(forwardPort(resolvedTarget, port));
        if (Exit.isSuccess(result)) {
          forwarded.push(port);
        } else {
          yield* Effect.logWarning("ssh.portForward.sync.failed", {
            ...sshTargetLogFields(resolvedTarget),
            port,
            cause: result.cause,
          });
        }
      }
    }

    // Unforward ports that are no longer reported as listening
    for (const entry of existingTargetEntries) {
      if (!targetPortsSet.has(entry.remotePort)) {
        yield* unforwardPort(resolvedTarget, entry.remotePort);
        unforwarded.push(entry.remotePort);
      }
    }

    const updatedCurrent = yield* Ref.get(forwardsRef);
    const activeForwards = [...updatedCurrent.values()]
      .filter((e) => targetConnectionKey(e.target) === targetKey)
      .map((e) => toContractPortForward(e));

    return {
      activeForwards,
      forwarded,
      unforwarded,
    };
  });

  const closeAllForTarget: SshPortForwardManagerShape["closeAllForTarget"] = Effect.fn(
    "ssh/portForward.closeAllForTarget",
  )(function* (target) {
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    const targetKey = targetConnectionKey(resolvedTarget);
    const current = yield* Ref.get(forwardsRef);
    const matching = [...current.values()].filter(
      (e) => targetConnectionKey(e.target) === targetKey,
    );

    yield* Ref.update(forwardsRef, (map) => {
      const next = new Map(map);
      for (const entry of matching) {
        next.delete(entry.key);
      }
      return next;
    });

    yield* Effect.forEach(matching, closeEntry, { concurrency: "unbounded" }).pipe(
      Effect.ignore,
    );
  });

  return SshPortForwardManager.of({
    forwardPort,
    unforwardPort,
    listForwardedPorts,
    syncAutoPortForwards,
    closeAllForTarget,
  });
});

export const layer = Layer.effect(SshPortForwardManager, makeSshPortForwardManager());

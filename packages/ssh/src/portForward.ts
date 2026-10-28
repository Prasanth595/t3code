import type {
  DesktopSshAutoPortForwardSyncResult,
  DesktopSshEnvironmentTarget,
  DesktopSshPortForward,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as NetService from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
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
const FORWARD_CONNECT_TIMEOUT_MS = 15_000;
const FORWARD_PROBE_INTERVAL_MS = 50;

export interface SshPortForwardEntry {
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly localPort: number;
  readonly localUrl: string;
  readonly process: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
}

export type SshPortForwardEffectContext =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | NetService.NetService
  | SshAuth.SshPasswordPrompt;

export type SshPortForwardEffectError =
  | SshCommandError
  | SshInvalidTargetError
  | SshPasswordPromptError
  | NetService.NetError;

export interface SshPortForwardManagerShape {
  readonly forwardPort: (
    target: DesktopSshEnvironmentTarget,
    remotePort: number,
    preferredLocalPort?: number,
  ) => Effect.Effect<DesktopSshPortForward, SshPortForwardEffectError, SshPortForwardEffectContext>;

  readonly unforwardPort: (
    target: DesktopSshEnvironmentTarget,
    remotePort: number,
  ) => Effect.Effect<
    boolean,
    SshCommandError | SshInvalidTargetError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  >;

  readonly listForwardedPorts: (
    target?: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<
    ReadonlyArray<DesktopSshPortForward>,
    SshCommandError | SshInvalidTargetError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  >;

  readonly syncAutoPortForwards: (
    target: DesktopSshEnvironmentTarget,
    discoveredRemotePorts: ReadonlyArray<number>,
    excludePorts?: ReadonlyArray<number>,
  ) => Effect.Effect<
    DesktopSshAutoPortForwardSyncResult,
    SshPortForwardEffectError,
    SshPortForwardEffectContext
  >;

  readonly closeAllForTarget: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<
    void,
    SshCommandError | SshInvalidTargetError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  >;
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

interface SshAuthAttemptInput<T> {
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly operation: (
    authOptions: SshAuth.SshAuthOptions,
  ) => Effect.Effect<T, SshPortForwardEffectError, SshPortForwardEffectContext>;
  readonly promptCount: number;
  readonly authSecret: string | null;
}

export const makeSshPortForwardManager = Effect.fn(
  "ssh/portForward.makeSshPortForwardManager",
)(function* (): Effect.fn.Return<SshPortForwardManagerShape, never, Scope.Scope> {
  const managerScope = yield* Scope.Scope;
  const forwardsRef = yield* Ref.make<Map<string, SshPortForwardEntry>>(new Map());
  const forwardLocks = yield* KeyedLock.make<string>();
  const authSecrets = new Map<string, string>();

  const resolveTarget = Effect.fn("ssh/portForward.resolveTarget")(function* (
    target: DesktopSshEnvironmentTarget,
  ) {
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);
    return {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    } satisfies DesktopSshEnvironmentTarget;
  });

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
      authSecrets.clear();
    }),
  );

  const promptForPassword = Effect.fn("ssh/portForward.promptForPassword")(function* (
    target: DesktopSshEnvironmentTarget,
    attempt: number,
  ): Effect.fn.Return<
    string,
    SshInvalidTargetError | SshPasswordPromptError,
    SshAuth.SshPasswordPrompt
  > {
    const promptService = yield* SshAuth.SshPasswordPrompt;
    const hostSpec = yield* buildSshHostSpecEffect(target);
    if (!promptService.isAvailable) {
      yield* Effect.logWarning("ssh.auth.passwordPrompt.unavailable", {
        ...sshTargetLogFields(target),
        attempt,
      });
      return yield* new SshPasswordPromptError({
        message: `SSH authentication failed for ${hostSpec}.`,
      });
    }

    yield* Effect.logInfo("ssh.auth.passwordPrompt.request", {
      ...sshTargetLogFields(target),
      attempt,
    });
    const password = yield* promptService.request({
      attempt,
      destination: target.alias.trim() || target.hostname.trim(),
      username: target.username,
      prompt: `Enter the SSH password or verification code for ${hostSpec}.`,
    });
    if (password === null) {
      yield* Effect.logWarning("ssh.auth.passwordPrompt.cancelled", {
        ...sshTargetLogFields(target),
        attempt,
      });
      return yield* new SshPasswordPromptError({
        message: `SSH authentication cancelled for ${hostSpec}.`,
      });
    }
    yield* Effect.logInfo("ssh.auth.passwordPrompt.received", {
      ...sshTargetLogFields(target),
      attempt,
    });
    return password;
  });

  const handleSshAuthFailure = Effect.fn("ssh/portForward.runWithSshAuthAttempt.handleFailure")(
    function* <T>(
      input: SshAuthAttemptInput<T> & {
        readonly error: SshPortForwardEffectError;
      },
    ): Effect.fn.Return<T, SshPortForwardEffectError, SshPortForwardEffectContext> {
      if (!SshAuth.isSshAuthFailure(input.error)) {
        return yield* input.error;
      }

      yield* Effect.logWarning("ssh.portForward.auth.failed", {
        ...sshTargetLogFields(input.target),
        key: input.key,
        promptCount: input.promptCount,
        cause: input.error,
      });
      const promptService = yield* SshAuth.SshPasswordPrompt;
      if (!promptService.isAvailable) {
        return yield* input.error;
      }
      if (input.authSecret !== null) {
        authSecrets.delete(input.key);
      }
      if (input.promptCount >= 2) {
        return yield* input.error;
      }

      const nextPromptCount = input.promptCount + 1;
      const nextAuthSecret = yield* promptForPassword(input.target, nextPromptCount);
      authSecrets.set(input.key, nextAuthSecret);
      return yield* runWithSshAuthAttempt({
        ...input,
        promptCount: nextPromptCount,
        authSecret: nextAuthSecret,
      });
    },
  );

  const runWithSshAuthAttempt = Effect.fn("ssh/portForward.runWithSshAuthAttempt")(function* <T>(
    input: SshAuthAttemptInput<T>,
  ): Effect.fn.Return<T, SshPortForwardEffectError, SshPortForwardEffectContext> {
    const promptService = yield* SshAuth.SshPasswordPrompt;
    const authOptions =
      input.authSecret === null
        ? {
            batchMode: promptService.isAvailable ? ("yes" as const) : ("no" as const),
            interactiveAuth: !promptService.isAvailable,
          }
        : {
            authSecret: input.authSecret,
            batchMode: "no" as const,
            interactiveAuth: true,
          };

    return yield* input
      .operation(authOptions)
      .pipe(Effect.catch((error) => handleSshAuthFailure({ ...input, error })));
  });

  const runWithSshAuth = Effect.fn("ssh/portForward.runWithSshAuth")(function* <T>(
    target: DesktopSshEnvironmentTarget,
    operation: (
      authOptions: SshAuth.SshAuthOptions,
    ) => Effect.Effect<T, SshPortForwardEffectError, SshPortForwardEffectContext>,
  ): Effect.fn.Return<T, SshPortForwardEffectError, SshPortForwardEffectContext> {
    const targetKey = targetConnectionKey(target);
    return yield* runWithSshAuthAttempt({
      key: targetKey,
      target,
      operation,
      promptCount: 0,
      authSecret: authSecrets.get(targetKey) ?? null,
    });
  });

  const spawnForwardProcess = Effect.fn("ssh/portForward.spawnForwardProcess")(function* (input: {
    readonly resolvedTarget: DesktopSshEnvironmentTarget;
    readonly key: string;
    readonly remotePort: number;
    readonly localPort: number;
    readonly localUrl: string;
    readonly authOptions: SshAuth.SshAuthOptions;
  }) {
    const { resolvedTarget, key, remotePort, localPort, localUrl, authOptions } = input;
    const hostSpec = yield* buildSshHostSpecEffect(resolvedTarget);
    const childEnvironment = yield* SshAuth.buildSshChildEnvironment({
      ...(authOptions.authSecret === undefined ? {} : { authSecret: authOptions.authSecret }),
      ...(authOptions.interactiveAuth === undefined ? {} : { interactiveAuth: authOptions.interactiveAuth }),
    }).pipe(
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
      ...baseSshArgs(resolvedTarget, { batchMode: authOptions.batchMode ?? "no" }),
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
      `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
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
    const stderrDrain = yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          stderrTail = (stderrTail + chunk).slice(-TUNNEL_STDERR_TAIL_CHARS);
        }),
      ),
      Effect.ignore,
      Effect.forkIn(entryScope),
    );

    const exitFailure = Effect.all(
      [Fiber.join(stderrDrain), child.exitCode.pipe(Effect.map(Number))],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new SshCommandError({
            command: forwardCommand,
            exitCode: null,
            stderr: "",
            message:
              cause instanceof Error
                ? cause.message
                : `Failed to monitor SSH port forward for ${resolvedTarget.alias}.`,
            cause,
          }),
      ),
      Effect.flatMap(([, exitCode]) => {
        const stderr = stderrTail.trim();
        const error = new SshCommandError({
          command: forwardCommand,
          exitCode,
          stderr,
          message:
            stderr.length > 0
              ? stderr
              : `SSH port forward failed immediately for ${resolvedTarget.alias} (exit ${exitCode}).`,
        });
        return Effect.fail(error);
      }),
    );

    const waitForListenerReady = Effect.gen(function* () {
      const net = yield* NetService.NetService;
      const deadline = Date.now() + FORWARD_CONNECT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const hasListener = yield* net.hasListenerOnHost(localPort, "127.0.0.1");
        if (hasListener) {
          return;
        }
        yield* Effect.sleep(Duration.millis(FORWARD_PROBE_INTERVAL_MS));
      }
      return yield* new SshCommandError({
        command: forwardCommand,
        exitCode: null,
        stderr: stderrTail,
        message: `Timed out waiting for SSH port forward listener on 127.0.0.1:${localPort}.`,
      });
    });

    yield* Effect.raceFirst(waitForListenerReady, exitFailure).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Scope.close(entryScope, Exit.void).pipe(Effect.ignore),
      ),
    );

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

    return entry;
  });

  const forwardPort: SshPortForwardManagerShape["forwardPort"] = Effect.fn(
    "ssh/portForward.forwardPort",
  )(function* (target, remotePort, preferredLocalPort) {
    const resolvedTarget = yield* resolveTarget(target);
    const key = forwardKey(resolvedTarget, remotePort);

    return yield* forwardLocks.withLock(
      key,
      Effect.gen(function* () {
        const currentForwards = yield* Ref.get(forwardsRef);
        const existing = currentForwards.get(key);
        if (existing) {
          return toContractPortForward(existing);
        }

        const net = yield* NetService.NetService;
        const preferred =
          preferredLocalPort && preferredLocalPort > 0 ? preferredLocalPort : remotePort;
        const localPort = yield* net.findAvailablePort(preferred);
        const localUrl = `http://127.0.0.1:${localPort}`;

        const entry = yield* runWithSshAuth(resolvedTarget, (authOptions) =>
          spawnForwardProcess({
            resolvedTarget,
            key,
            remotePort,
            localPort,
            localUrl,
            authOptions,
          }),
        );

        // If another entry was added while preparing, close previous cleanly before setting
        const previousEntry = (yield* Ref.get(forwardsRef)).get(key);
        if (previousEntry) {
          yield* closeEntry(previousEntry);
        }

        yield* Ref.update(forwardsRef, (map) => {
          const next = new Map(map);
          next.set(key, entry);
          return next;
        });

        // Monitor child exit code for its full lifetime; remove from active forwards upon exit
        yield* entry.process.exitCode.pipe(
          Effect.zipRight(
            Ref.update(forwardsRef, (map) => {
              if (map.get(key) !== entry) return map;
              const next = new Map(map);
              next.delete(key);
              return next;
            }),
          ),
          Effect.forkIn(managerScope),
        );

        yield* Effect.logInfo("ssh.portForward.spawn.succeeded", {
          ...sshTargetLogFields(resolvedTarget),
          localPort,
          remotePort,
          localUrl,
        });

        return toContractPortForward(entry);
      }),
    );
  });

  const unforwardPort: SshPortForwardManagerShape["unforwardPort"] = Effect.fn(
    "ssh/portForward.unforwardPort",
  )(function* (target, remotePort) {
    const resolvedTarget = yield* resolveTarget(target);
    const key = forwardKey(resolvedTarget, remotePort);

    return yield* forwardLocks.withLock(
      key,
      Effect.gen(function* () {
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
      }),
    );
  });

  const listForwardedPorts: SshPortForwardManagerShape["listForwardedPorts"] = Effect.fn(
    "ssh/portForward.listForwardedPorts",
  )(function* (target) {
    const current = yield* Ref.get(forwardsRef);
    const all = [...current.values()];
    if (!target) {
      return all.map((e) => toContractPortForward(e));
    }
    const resolvedTarget = yield* resolveTarget(target);
    const targetKey = targetConnectionKey(resolvedTarget);
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

    const resolvedTarget = yield* resolveTarget(target);
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
          if (
            Cause.hasFails(result.cause) &&
            Cause.failures(result.cause).some((e) => (e as { _tag?: string })._tag === "SshPasswordPromptError")
          ) {
            break;
          }
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
    const resolvedTarget = yield* resolveTarget(target);
    const targetKey = targetConnectionKey(resolvedTarget);
    authSecrets.delete(targetKey);

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

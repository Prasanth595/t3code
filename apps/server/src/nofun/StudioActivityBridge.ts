// StudioActivityBridge.ts — wires the studio activity publisher into the
// server runtime.
//
// Serializes event-driven snapshots, startup readback and idle reconciliation.
// Delivery is a durable one-snapshot outbox; a scoped timer retries with capped
// backoff even when no later application event arrives. No runtime command waits
// for HTTP. Scope closure interrupts the worker and removes the timer.

import type { OrchestrationProjectShell, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Startup Keychain lookup explicitly requires execFile with a bounded timeout and no shell.
import * as NodeChildProcess from "node:child_process";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { nofunTeamFromEnv } from "../terminal/contextEnv.ts";
import { personaRootViolation, readNofunPersonaScope } from "./persona.ts";
import {
  StudioActivityPublisher,
  activityPayloadHash,
  decodeStudioActivityState,
  type StudioActivityStateStore,
  type ActivityThreadRead,
} from "./StudioActivityPublisher.ts";
import {
  makeStudioActivitySink,
  readStudioActivityBridgeConfig,
  STUDIO_ACTIVITY_BRIDGE_TOKEN_ENV,
  STUDIO_ACTIVITY_BRIDGE_URL_ENV,
  type StudioActivityFetch,
  StudioActivityTransportError,
} from "./StudioActivitySink.ts";

/** Producer epoch for this bridge. Constant across restarts; the bridge
 * rejects a new epoch and any lower sequence, so each process seeds its
 * sequence from the wall clock (ms) to stay monotonic across restarts. */
export const STUDIO_ACTIVITY_BRIDGE_EPOCH = "t3.studio-activity.v1" as const;

export type StudioActivityTeam = "nofun" | "catches";

/**
 * Map shell rows to publisher reads from shell fields + project settings
 * only. Unknown projects (absent from settings) map to "unknown" and are
 * excluded downstream by the allowlist miss.
 */
export function toActivityReads(input: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly team: StudioActivityTeam;
  readonly isPrivateRoot: (workspaceRoot: string) => boolean;
}): ActivityThreadRead[] {
  const roots = new Map<string, string>();
  for (const project of input.projects) roots.set(String(project.id), project.workspaceRoot);
  return input.threads.map((thread) => {
    const projectId = String(thread.projectId);
    const repo = roots.get(projectId) ?? "";
    const projectKind =
      !roots.has(projectId) || repo.length === 0
        ? ("unknown" as const)
        : input.team === "catches"
          ? ("catches" as const)
          : input.isPrivateRoot(repo)
            ? ("private" as const)
            : ("standard" as const);
    const runId = thread.latestRunId ?? thread.activeRunId;
    const lastEventAt = DateTime.toDateUtc(thread.updatedAt).toISOString();
    return {
      threadId: String(thread.id),
      projectId,
      projectKind,
      repo,
      runId: runId === null ? null : String(runId),
      title: thread.title,
      state: thread.status,
      revision: lastEventAt,
      lastEventAt,
    };
  });
}

export interface StudioActivityBridgeOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchFn?: StudioActivityFetch;
  readonly timeoutMs?: number;
  /** Wall clock in ms that seeds the publish sequence. */
  readonly nowMs?: () => number;
  /** Minimum gap between coalesced publishes. */
  readonly minIntervalMs?: number;
  readonly idleIntervalMs?: number;
  readonly retryTickMs?: number;
  readonly stateStore?: StudioActivityStateStore;
  readonly publishOnStart?: boolean;
}

/**
 * Event-driven bridge layer. Requires the shared projection/project/event
 * stores from the surrounding runtime; provides nothing. Without credentials,
 * logs at debug and subscribes to nothing.
 */
export const layerWithBridgeOptions = (options: StudioActivityBridgeOptions = {}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const env = options.env ?? process.env;
      // Only the No Fun persona publishes. A CATCHES server can inherit the same env from the
      // login session; it must never post, not even an empty snapshot over No Fun's stream.
      if (nofunTeamFromEnv(env) !== "nofun") {
        yield* Effect.logDebug("studio activity bridge disabled for this persona");
        return;
      }
      let token = env[STUDIO_ACTIVITY_BRIDGE_TOKEN_ENV];
      if (token === undefined && (yield* HostProcessPlatform) === "darwin") {
        token = yield* Effect.promise(async () => {
          try {
            return await new Promise<string | undefined>((resolve) => {
              NodeChildProcess.execFile(
                "/usr/bin/security",
                [
                  "find-generic-password",
                  "-a",
                  env.USER ?? process.env.USER ?? "",
                  "-s",
                  "nofun-studio-bridge",
                  "-w",
                ],
                { encoding: "utf8", timeout: 2_000 },
                (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined),
              );
            });
          } catch {
            // Even synchronous spawn errors may carry command output. Discard them.
            return undefined;
          }
        });
        if (token === undefined) {
          yield* Effect.logDebug("keychain item nofun-studio-bridge unavailable");
        }
      }
      const config = readStudioActivityBridgeConfig({
        [STUDIO_ACTIVITY_BRIDGE_URL_ENV]:
          env[STUDIO_ACTIVITY_BRIDGE_URL_ENV] ?? "https://grok-bot-mcp-bridge.vercel.app",
        [STUDIO_ACTIVITY_BRIDGE_TOKEN_ENV]: token,
      });
      if (!config) {
        yield* Effect.logDebug(
          "studio activity bridge disabled; set NOFUN_STUDIO_BRIDGE_TOKEN or the macOS Keychain item nofun-studio-bridge to enable; NOFUN_STUDIO_BRIDGE_URL overrides the default URL",
        );
        return;
      }
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig.ServerConfig;
      // Namespace by endpoint and producer, never by credential bytes. Runtime
      // persistence uses the configured environment's state directory only.
      const statePath = path.join(
        serverConfig.stateDir,
        `studio-activity-${activityPayloadHash(config.baseUrl).slice(0, 16)}.json`,
      );
      const stateStore =
        options.stateStore ??
        ({
          load: () =>
            Effect.runPromise(
              Effect.gen(function* () {
                if (!(yield* fs.exists(statePath))) return null;
                const text = yield* fs.readFileString(statePath);
                return decodeStudioActivityState(JSON.parse(text));
              }),
            ),
          save: (state) =>
            Effect.runPromise(
              Effect.gen(function* () {
                yield* fs.writeFileString(`${statePath}.pending`, JSON.stringify(state), {
                  mode: 0o600,
                });
                yield* fs.rename(`${statePath}.pending`, statePath);
              }),
            ),
        } satisfies StudioActivityStateStore);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const events = yield* OrchestrationEventStore.OrchestrationEventStore;
      const bridgeScope = yield* Effect.scope;
      const scope = readNofunPersonaScope(env);
      const team = nofunTeamFromEnv(env);
      const allowedRoots = scope?.allowedRoots ?? [];
      // Single flag pair in one Ref so notify/drain coordinate atomically:
      // at most one publish in flight, at most one coalesced rerun.
      const state = yield* Ref.make({ inFlight: false, dirty: false });
      let publisherRef: StudioActivityPublisher | null = null;
      const publisher = new StudioActivityPublisher({
        epoch: STUDIO_ACTIVITY_BRIDGE_EPOCH,
        stateStore,
        nowMs: options.nowMs ?? Date.now,
        initialSequence: (options.nowMs ?? Date.now)(),
        allowedProjectIds: [],
        allowedRoots,
        reads: {
          listActivityThreads: () =>
            Effect.runPromise(
              Effect.gen(function* () {
                const snapshot = yield* projections.getShellSnapshot();
                const shells = yield* projects.listShells();
                // Fresh allowlist from current project settings per publish,
                // so created/deleted projects take effect without a restart.
                publisherRef?.setAllowedProjectIds(shells.map((shell) => String(shell.id)));
                return toActivityReads({
                  threads: snapshot.threads,
                  projects: shells,
                  team,
                  isPrivateRoot: (repo) => personaRootViolation(scope, repo) !== undefined,
                });
              }),
            ),
        },
        sink: makeStudioActivitySink({
          config,
          fetchFn: options.fetchFn,
          timeoutMs: options.timeoutMs,
        }),
      });
      publisherRef = publisher;
      const minIntervalMs = options.minIntervalMs ?? 10_000;
      const nowMs = options.nowMs ?? Date.now;
      let recoverAt = 0;
      let lastPublishAt = Number.NEGATIVE_INFINITY;
      let snapshotDue = options.publishOnStart ?? true;
      const reportFailure = (error: unknown) =>
        Effect.logWarning("studio activity delivery pending", {
          kind: error instanceof StudioActivityTransportError ? error.kind : "delivery_or_state",
          status: error instanceof StudioActivityTransportError ? error.status : null,
        });
      const drain: Effect.Effect<void> = Effect.gen(function* () {
        for (;;) {
          yield* Effect.promise(async () => {
            await publisher.initialize();
            if (nowMs() >= recoverAt) {
              // Keep each replay turn bounded; subsequent timer ticks drain more pages.
              recoverAt = nowMs() + (options.idleIntervalMs ?? 30_000);
              const more = await publisher.recover();
              if (more) recoverAt = nowMs();
            }
            // On restart, retry the exact durable identity before allocating a
            // fresh snapshot. A readback watermark may already have covered it.
            if (publisher.pendingCount > 0) {
              const outcomes = await publisher.retryPending();
              if (publisher.pendingCount > 0)
                return outcomes.find((outcome) => outcome.error)?.error;
            }
            if (snapshotDue && nowMs() - lastPublishAt >= minIntervalMs) {
              snapshotDue = false;
              lastPublishAt = nowMs();
              const result = await publisher.publishNow();
              if (!result.delivered && result.status === "send_failed") return result.error;
            }
          }).pipe(
            Effect.flatMap((error) => (error === undefined ? Effect.void : reportFailure(error))),
            Effect.catchCause(() => reportFailure(undefined)),
          );
          const rerun = yield* Ref.modify(state, (flag) =>
            flag.dirty
              ? ([true, { inFlight: true, dirty: false }] as const)
              : ([false, { inFlight: false, dirty: false }] as const),
          );
          if (!rerun) return;
          if (minIntervalMs > 0) yield* Effect.sleep(minIntervalMs);
        }
      });
      const notify = (changed: boolean) =>
        Effect.gen(function* () {
          if (changed) snapshotDue = true;
          const start = yield* Ref.modify(state, (flag) =>
            flag.inFlight
              ? ([false, { ...flag, dirty: true }] as const)
              : ([true, { inFlight: true, dirty: false }] as const),
          );
          if (start) yield* Effect.forkIn(drain, bridgeScope);
        });
      // Start behind the current tip: this is a live activity feed, not a
      // backfill. The stream itself is race-free replay-to-live.
      const after = yield* events.latestApplicationSequence.pipe(Effect.orElseSucceed(() => 0));
      yield* events.streamApplicationEvents({ afterSequence: after }).pipe(
        Stream.runForEach(() => notify(true)),
        Effect.catchCause(() => Effect.logDebug("studio activity subscriber ended")),
        Effect.forkScoped,
      );
      // Startup and idle recovery are independent of new orchestration events.
      yield* notify(false);
      yield* Effect.gen(function* () {
        for (;;) {
          yield* Effect.sleep(options.retryTickMs ?? 1000);
          yield* notify(false);
        }
      }).pipe(Effect.forkScoped);
      yield* Effect.logDebug("studio activity bridge enabled");
    }),
  );

/** Production layer: env + fetch from the server process. */
export const layer = layerWithBridgeOptions();

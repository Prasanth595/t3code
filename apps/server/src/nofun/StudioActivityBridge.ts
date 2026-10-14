// StudioActivityBridge.ts — wires the studio activity publisher into the
// server runtime.
//
// The bridge subscribes to the EXISTING application-event stream (the same
// race-free project/thread event source that feeds the shell stream), so
// every committed thread/project activity notifies the publisher. No new
// scheduler, timer or polling loop is added: delivery is purely event-driven.
//
// Configuration is read once at startup. Environment values win; an unset URL
// uses the studio bridge, and an unset token uses the macOS Keychain item
// nofun-studio-bridge. Without a token the layer subscribes to nothing.
// Credentials and Keychain command output are never logged.
//
// The reads adapter maps shell fields only (thread/run ids, title, state,
// revision, last event time) plus project settings (workspace root,
// allowlist). No prompt or message content ever reaches the envelope:
// anything not on the allowlist is excluded by the publisher.
//
// Bounded: at most one publish in flight plus one coalesced rerun; sends
// never throw (the sink swallows network/non-2xx/timeout failures) and the
// notifier catches everything else, so bridge delivery can never block or
// crash the runtime. No automatic retry: each publish is a full snapshot
// that supersedes the previous one.

import type { OrchestrationProjectShell, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Startup Keychain lookup explicitly requires execFile with a bounded timeout and no shell.
import * as NodeChildProcess from "node:child_process";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { nofunTeamFromEnv } from "../terminal/contextEnv.ts";
import { personaRootViolation, readNofunPersonaScope } from "./persona.ts";
import { StudioActivityPublisher, type ActivityThreadRead } from "./StudioActivityPublisher.ts";
import {
  makeStudioActivitySink,
  readStudioActivityBridgeConfig,
  STUDIO_ACTIVITY_BRIDGE_TOKEN_ENV,
  STUDIO_ACTIVITY_BRIDGE_URL_ENV,
  type StudioActivityFetch,
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
        initialSequence: (options.nowMs ?? Date.now)(),
        allowedProjectIds: [],
        allowedRoots,
        reads: {
          listActivityThreads: () =>
            Effect.runPromise(
              Effect.gen(function* () {
                const snapshot = yield* projections
                  .getShellSnapshot()
                  .pipe(Effect.orElseSucceed(() => null));
                if (snapshot === null) return [];
                const shells = yield* projects.listShells().pipe(Effect.orElseSucceed(() => []));
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
      const publishOnce = Effect.promise(() => publisher.publishNow()).pipe(
        Effect.catchCause(() => Effect.logDebug("studio activity publish failed")),
      );
      const drain: Effect.Effect<void> = Effect.gen(function* () {
        for (;;) {
          yield* publishOnce;
          const rerun = yield* Ref.modify(state, (flag) =>
            flag.dirty
              ? ([true, { inFlight: true, dirty: false }] as const)
              : ([false, { inFlight: false, dirty: false }] as const),
          );
          if (!rerun) return;
          // Busy turns emit events continuously; coalesce them so the bridge
          // sees at most one snapshot per interval.
          if (minIntervalMs > 0) yield* Effect.sleep(minIntervalMs);
        }
      });
      const notify = Effect.gen(function* () {
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
        Stream.runForEach(() => notify),
        Effect.catchCause(() => Effect.logDebug("studio activity subscriber ended")),
        Effect.forkScoped,
      );
      yield* Effect.logDebug("studio activity bridge enabled");
    }),
  );

/** Production layer: env + fetch from the server process. */
export const layer = layerWithBridgeOptions();

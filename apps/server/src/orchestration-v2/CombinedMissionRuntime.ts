import { CommandId } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as MissionMcpAuthority from "../mcp/MissionMcpAuthority.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import { Mission } from "../../../../packages/contracts/src/mission.ts";
import {
  emptyMissionExecution,
  missionRetroReportReceipts,
  missionRetroSkillEvaluations,
} from "../../../../packages/contracts/src/missionExecution.ts";
import * as Lifecycle from "./MissionManagerLifecycleStore.ts";
import * as Manager from "./MissionManagerRuntimeAdapter.ts";
import * as ReplayArtifacts from "./MissionRetroReplayArtifacts.ts";
import * as Runner from "./MissionRetroReplayRunner.ts";
import * as SkillStore from "./MissionRetroSkillEvaluationStore.ts";
import * as Missions from "./MissionService.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";

export class CombinedMissionRuntimeError extends Schema.TaggedError<CombinedMissionRuntimeError>()(
  "CombinedMissionRuntimeError",
  {
    code: Schema.Literals([
      "authority_unavailable",
      "scope_denied",
      "replay_unconfigured",
      "replay_unavailable",
      "mission_inactive",
      "request_conflict",
    ]),
  },
) {}

type RuntimeError =
  | CombinedMissionRuntimeError
  | Runner.MissionRetroReplayRunError
  | ReplayArtifacts.MissionRetroReplayArtifactError
  | SkillStore.MissionRetroSkillEvaluationStoreError
  | Lifecycle.MissionManagerLifecycleStoreError
  | Manager.MissionManagerRuntimeError
  | Missions.MissionServiceError;
type Role = "delivery" | "retro";
type ReplayCommand = {
  readonly commandId: CommandId;
  readonly expectedRevision: number;
  readonly evaluationId: string;
  readonly planId: string;
};

/** Capabilities expire with this request; no authority or currency callback is caller supplied. */
export interface CombinedMissionRequest {
  readonly replayAndRecord: (
    command: ReplayCommand,
  ) => Effect.Effect<SkillStore.MissionRetroSkillEvaluationResult, RuntimeError>;
  readonly launchStandby: (
    reservationId: string,
  ) => Effect.Effect<
    Effect.Success<ReturnType<Manager.MissionManagerRuntimeAdapter["Service"]["launchStandby"]>>,
    RuntimeError
  >;
  readonly readLifecycleFacts: (
    reservationId: string,
    step: Lifecycle.ManagerLifecycleStep,
  ) => Effect.Effect<Lifecycle.ManagerLifecycleFacts, RuntimeError>;
  readonly advance: (
    command: Omit<Lifecycle.ManagerLifecycleCommand, "missionId" | "role">,
  ) => Effect.Effect<Lifecycle.ManagerLifecycleResult, RuntimeError>;
  readonly cleanupIncumbent: (
    reservationId: string,
  ) => Effect.Effect<
    Effect.Success<ReturnType<Manager.MissionManagerRuntimeAdapter["Service"]["cleanupIncumbent"]>>,
    RuntimeError
  >;
  readonly wakeCurrentRole: (
    command: Omit<Manager.WakeRequest, "missionId" | "role">,
  ) => Effect.Effect<
    Effect.Success<ReturnType<Manager.MissionManagerRuntimeAdapter["Service"]["wakeCurrentRole"]>>,
    RuntimeError
  >;
}

export class CombinedMissionRuntime extends Context.Service<
  CombinedMissionRuntime,
  {
    readonly status: Effect.Effect<{
      readonly authority: "available" | "authority_unavailable";
      readonly replay: "configured" | "unconfigured" | "unavailable";
    }>;
    readonly withRequest: <A, E, R>(
      scope: McpInvocationScope,
      request: { readonly missionId: string; readonly role: Role },
      use: (runtime: CombinedMissionRequest) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | RuntimeError, R>;
  }
>()("t3/orchestration-v2/CombinedMissionRuntime") {}

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Plan = Schema.Struct({
  missionId: Id,
  candidateId: Id,
  targetSkillRef: Id,
  sourceReportHash: Digest,
  authorId: Id,
  targetOwnership: Schema.Literals(["owned", "upstream", "unknown"]),
  candidateClaim: Schema.Struct({
    candidateId: Id,
    targetSkillRef: Id,
    sourceReportHash: Digest,
    claimedPass: Schema.Boolean,
  }),
  snapshots: Schema.Struct({ old: Id, new: Id }),
  fixtures: Schema.Struct({ failure: Id, positive: Id, negative: Id }),
});
const StartupConfig = Schema.Struct({
  // The accepted runner strictly decodes its own config before any executable is used.
  runner: Schema.Unknown,
  approvedConfigDigest: Digest,
  reportArtifactDirectory: Id,
  plans: Schema.Record(Id, Plan),
});
type StartupConfig = typeof StartupConfig.Type;
const decodeConfig = Schema.decodeUnknownSync(Schema.fromJsonString(StartupConfig), {
  onExcessProperty: "error",
});
const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));
const decodePolicy = Schema.decodeUnknownSync(MissionMcpAuthority.TrustedNoFunMissionPolicy, {
  onExcessProperty: "error",
});
const fail = (code: CombinedMissionRuntimeError["code"]) =>
  new CombinedMissionRuntimeError({ code });

/** Separate owner-controlled replay config; the existing B8 mission policy format is unchanged. */
const readStartupConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const server = yield* ServerConfig.ServerConfig;
  const named = yield* Config.String("T3CODE_NOFUN_COMBINED_MISSION_CONFIG_FILE").pipe(
    Config.option,
  );
  const filename = Option.getOrElse(named, () =>
    path.join(server.stateDir, "nofun", "combined-mission-runtime.json"),
  );
  if (!path.isAbsolute(filename)) return yield* fail("replay_unavailable");
  const stat = yield* fs.stat(filename).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (e) =>
        e.reason._tag === "NotFound" && Option.isNone(named)
          ? Effect.succeedNone
          : Effect.fail(fail("replay_unavailable")),
    }),
  );
  if (Option.isNone(stat)) return Option.none<StartupConfig>();
  const uid = process.getuid?.();
  if (
    stat.value.type !== "File" ||
    (stat.value.mode & 0o077) !== 0 ||
    Number(stat.value.size) > 65536 ||
    (uid !== undefined && Option.isSome(stat.value.uid) && stat.value.uid.value !== uid)
  )
    return yield* fail("replay_unavailable");
  const bytes = yield* fs
    .readFileString(filename)
    .pipe(Effect.mapError(() => fail("replay_unavailable")));
  const config = yield* Effect.try({
    try: () => decodeConfig(bytes),
    catch: () => fail("replay_unavailable"),
  });
  if (
    !path.isAbsolute(config.reportArtifactDirectory) ||
    Object.values(config.plans).some(
      (p) =>
        ![p.snapshots.old, p.snapshots.new, ...Object.values(p.fixtures)].every((x) =>
          path.isAbsolute(x),
        ),
    )
  )
    return yield* fail("replay_unavailable");
  return Option.some(config);
}).pipe(Effect.mapError(() => fail("replay_unavailable")));

const make = Effect.gen(function* () {
  const policy = yield* MissionMcpAuthority.MissionMcpTrustedPolicy;
  const currentPolicy = () => {
    try {
      return policy.current === undefined ? undefined : decodePolicy(policy.current());
    } catch {
      return undefined;
    }
  };
  const managerActions = yield* Semaphore.make(1);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* Projections.ProjectionStoreV2;
  // Force the shared production dependencies to finish construction in the parent memo map.
  // A request forks that map: only the authority-dependent adapters/stores are new.
  yield* Sessions.ProviderSessionManagerV2;
  yield* ThreadLaunch.ThreadLaunchService;
  yield* ThreadManagement.ThreadManagementService;
  const parentMemo = Option.getOrThrow(yield* Effect.serviceOption(Layer.CurrentMemoMap));
  const startupContext =
    yield* Effect.context<
      Exclude<
        | Layer.Services<typeof RuntimeLayer.layerMissionManagerLifecycle>
        | Layer.Services<typeof Missions.layer>,
        Lifecycle.MissionManagerLifecycleAuthority | Missions.MissionAuthority
      >
    >();
  const events = yield* Events.OrchestrationEventStore;
  const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
  const configured = yield* (
    currentPolicy()?.environmentId === environmentId
      ? readStartupConfig
      : Effect.succeed(Option.none<StartupConfig>())
  ).pipe(Effect.result);
  const config = configured._tag === "Success" ? configured.success : Option.none<StartupConfig>();
  const runner = Option.isSome(config)
    ? yield* Layer.build(
        Runner.layer(config.value.runner as Runner.MissionRetroReplayRunnerConfig),
      ).pipe(
        Effect.map((ctx) => Option.some(Context.get(ctx, Runner.MissionRetroReplayRunner))),
        Effect.catch(() => Effect.succeedNone),
      )
    : Option.none<Runner.MissionRetroReplayRunner["Service"]>();
  const approved =
    Option.isSome(runner) && Option.isSome(config)
      ? yield* runner.value.configDigest.pipe(
          Effect.map((digest) => digest === config.value.approvedConfigDigest),
          Effect.orElseSucceed(() => false),
        )
      : false;
  const replayStatus =
    configured._tag === "Failure" || (Option.isSome(config) && !approved)
      ? ("unavailable" as const)
      : Option.isSome(config)
        ? ("configured" as const)
        : ("unconfigured" as const);

  const withRequest: CombinedMissionRuntime["Service"]["withRequest"] = (inputScope, input, use) =>
    Effect.scoped(
      Effect.gen(function* () {
        // Snapshot caller-owned identity before the first yield.
        const scope = {
          ...inputScope,
          thread: inputScope.thread === undefined ? undefined : { ...inputScope.thread },
          capabilities: new Set(inputScope.capabilities),
        };
        const request = { ...input };
        const trusted = currentPolicy();
        if (trusted === undefined || trusted.environmentId !== environmentId)
          return yield* fail("authority_unavailable");
        if (
          scope.thread === undefined ||
          scope.client !== undefined ||
          !scope.capabilities.has("orchestration") ||
          scope.environmentId !== environmentId ||
          registry.isActiveScope === undefined
        )
          return yield* fail("scope_denied");
        const authenticatedScope = { ...scope, thread: scope.thread };
        const identity = stableStringify(trusted);
        let open = true;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            open = false;
          }),
        );
        const isCurrent = () => open && stableStringify(currentPolicy()) === identity;
        const assertLive = Effect.gen(function* () {
          if (!isCurrent() || !(yield* registry.isActiveScope!(authenticatedScope)) || !isCurrent())
            return yield* fail("scope_denied");
        });
        const canonical = Effect.gen(function* () {
          yield* assertLive;
          const rows = yield* sql<{
            revision: number;
            snapshot_json: string;
          }>`SELECT revision, snapshot_json FROM projection_missions WHERE mission_id = ${request.missionId} AND team_id = ${trusted.teamId} AND authority_environment_id = ${environmentId}`.pipe(
            Effect.mapError(() => fail("scope_denied")),
          );
          if (rows[0] === undefined) return yield* fail("scope_denied");
          const mission = yield* decodeMission(rows[0].snapshot_json).pipe(
            Effect.mapError(() => fail("scope_denied")),
          );
          const manager = mission.managers[request.role];
          if (
            mission.id !== request.missionId ||
            mission.revision !== rows[0].revision ||
            mission.teamId !== trusted.teamId ||
            mission.authorityEnvironmentId !== environmentId ||
            manager?.threadId !== scope.thread!.threadId ||
            manager.epoch === undefined
          )
            return yield* fail("scope_denied");
          const thread = yield* projections
            .getThread(scope.thread!.threadId)
            .pipe(Effect.mapError(() => fail("scope_denied")));
          if (
            thread.deletedAt !== null ||
            thread.archivedAt !== null ||
            thread.providerInstanceId !== scope.thread!.providerInstanceId ||
            thread.modelSelection.instanceId !== scope.thread!.providerInstanceId ||
            !mission.bindings.some((b) => b.projectId === thread.projectId)
          )
            return yield* fail("scope_denied");
          const projects = yield* sql<{
            project_id: string;
            workspace_root: string;
            deleted_at: string | null;
          }>`SELECT project_id, workspace_root, deleted_at FROM projection_projects WHERE ${sql.in("project_id", trusted.allowedProjectIds)}`.pipe(
            Effect.mapError(() => fail("scope_denied")),
          );
          if (
            !mission.bindings.every((b) =>
              projects.some(
                (p) =>
                  p.project_id === b.projectId &&
                  p.workspace_root === b.workspaceRoot &&
                  p.deleted_at === null,
              ),
            )
          )
            return yield* fail("scope_denied");
          yield* assertLive;
          return { mission, manager };
        });
        const initial = yield* canonical;
        const assertCanonical = Effect.gen(function* () {
          const next = yield* canonical;
          if (next.manager.epoch !== initial.manager.epoch) return yield* fail("scope_denied");
          if (next.mission.status !== "active") return yield* fail("mission_inactive");
          return next.mission;
        });
        // The cores own their transactions and reject an ambient one. Preserve
        // the real client's connection/transaction service, adding the live
        // credential check INSIDE their transaction before its commit.
        const sqlLive = assertLive.pipe(
          Effect.mapError(
            (cause) =>
              new SqlError.SqlError({ reason: new SqlError.AuthorizationError({ cause }) }),
          ),
        );
        const sqlCanonical = assertCanonical.pipe(
          Effect.mapError(
            (cause) =>
              new SqlError.SqlError({ reason: new SqlError.AuthorizationError({ cause }) }),
          ),
        );
        const withTransaction: SqlClient.SqlClient["withTransaction"] = (effect) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sqlCanonical;
              const result = yield* effect;
              yield* sqlLive;
              return result;
            }),
          );
        const requestSql = new Proxy(sql, {
          get: (target, key, receiver) =>
            key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver),
        });
        const authority = Layer.succeed(Missions.MissionAuthority, {
          teamId: trusted.teamId,
          environmentId,
          controllerThreadId: scope.thread.threadId,
        });
        const missions = Missions.layer.pipe(Layer.provide(authority));
        const requestScope = yield* Scope.Scope;
        const memo = yield* Layer.forkMemoMap(parentMemo);
        const managerContext = yield* Layer.buildWithMemoMap(
          RuntimeLayer.layerMissionManagerLifecycle.pipe(
            Layer.provide(
              Layer.succeed(Lifecycle.MissionManagerLifecycleAuthority, {
                teamId: trusted.teamId,
                environmentId,
                role: request.role,
                isCurrent,
              }),
            ),
          ),
          memo,
          requestScope,
        ).pipe(Effect.provide(Context.add(startupContext, SqlClient.SqlClient, requestSql)));
        const adapter = Context.get(managerContext, Manager.MissionManagerRuntimeAdapter);
        const lifecycle = Context.get(managerContext, Lifecycle.MissionManagerLifecycleStore);
        const checked = <A, E>(effect: Effect.Effect<A, E>) =>
          Effect.gen(function* () {
            yield* assertCanonical;
            const result = yield* effect;
            yield* assertLive;
            return result;
          });
        const transactional = <A, E extends RuntimeError>(effect: Effect.Effect<A, E>) =>
          sql
            .withTransaction(checked(effect))
            .pipe(Effect.mapError((e) => (e._tag === "SqlError" ? fail("scope_denied") : e)));
        const runtime: CombinedMissionRequest = {
          launchStandby: (reservationId) =>
            managerActions.withPermits(1)(
              transactional(adapter.launchStandby({ ...request, reservationId })),
            ),
          readLifecycleFacts: (reservationId, step) =>
            managerActions.withPermits(1)(
              transactional(adapter.readLifecycleFacts({ ...request, reservationId, step })),
            ),
          advance: (command) =>
            managerActions.withPermits(1)(checked(lifecycle.advance({ ...command, ...request }))),
          cleanupIncumbent: (reservationId) =>
            managerActions.withPermits(1)(
              transactional(adapter.cleanupIncumbent({ ...request, reservationId })),
            ),
          wakeCurrentRole: (command) =>
            managerActions.withPermits(1)(
              transactional(adapter.wakeCurrentRole({ ...command, ...request })),
            ),
          replayAndRecord: (inputCommand) =>
            Effect.gen(function* () {
              const command = { ...inputCommand };
              if (request.role !== "retro") return yield* fail("scope_denied");
              const mission = yield* assertCanonical;
              if (replayStatus !== "configured" || Option.isNone(config) || Option.isNone(runner))
                return yield* fail(
                  replayStatus === "unconfigured" ? "replay_unconfigured" : "replay_unavailable",
                );
              const plan = config.value.plans[command.planId];
              if (plan === undefined || plan.missionId !== mission.id)
                return yield* fail("scope_denied");
              const recorded = missionRetroSkillEvaluations(
                mission.execution ?? emptyMissionExecution(),
              ).find((entry) => entry.evaluationId === command.evaluationId);
              if (
                recorded !== undefined &&
                (recorded.candidateId !== plan.candidateId ||
                  recorded.targetSkillRef !== plan.targetSkillRef ||
                  recorded.sourceReportHash !== plan.sourceReportHash)
              )
                return yield* fail("request_conflict");
              // A lost reply must recover the accepted store receipt, whose
              // expected revision precedes the committed mission revision.
              if (recorded === undefined && mission.revision !== command.expectedRevision)
                return yield* fail("request_conflict");
              const report = missionRetroReportReceipts(
                mission.execution ?? emptyMissionExecution(),
              ).find((r) => r.sourceReportHash === plan.sourceReportHash);
              if (report === undefined) return yield* fail("scope_denied");
              if ((yield* runner.value.configDigest) !== config.value.approvedConfigDigest)
                return yield* fail("replay_unavailable");
              // Each process in the paired replay is admitted under this request,
              // including after an earlier run yielded to policy/mission changes.
              const replayLive = Effect.gen(function* () {
                const current = yield* assertCanonical;
                if (current.revision !== command.expectedRevision)
                  return yield* fail("request_conflict");
              }).pipe(
                Effect.mapError((cause) =>
                  PlatformError.badArgument({
                    module: "ChildProcessSpawner",
                    method: "spawn",
                    description: "Mission replay authority is no longer current.",
                    cause,
                  }),
                ),
              );
              const spawn: ChildProcessSpawner.ChildProcessSpawner["Service"]["spawn"] = (
                process,
              ) =>
                Effect.gen(function* () {
                  yield* replayLive;
                  const child = yield* spawner.spawn(process);
                  yield* replayLive;
                  const exitCode = child.exitCode.pipe(Effect.tap(() => replayLive));
                  return new Proxy(child, {
                    get: (target, key, receiver) =>
                      key === "exitCode" ? exitCode : Reflect.get(target, key, receiver),
                  });
                });
              const requestRunner = Context.get(
                yield* Layer.buildWithMemoMap(
                  Runner.layer(config.value.runner as Runner.MissionRetroReplayRunnerConfig).pipe(
                    Layer.provide(
                      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, { ...spawner, spawn }),
                    ),
                  ),
                  memo,
                  requestScope,
                ),
                Runner.MissionRetroReplayRunner,
              );
              const replay =
                recorded !== undefined
                  ? {
                      artifactRef: recorded.evidenceArtifactRef,
                      artifactSha: recorded.evidenceArtifactSha,
                    }
                  : yield* requestRunner.replay({
                      scope: {
                        teamId: trusted.teamId,
                        environmentId,
                        originMissionId: mission.id,
                        candidateId: plan.candidateId,
                        targetSkillRef: plan.targetSkillRef,
                        sourceReportHash: report.sourceReportHash,
                        normalizedReportHash: report.normalizedReportHash,
                      },
                      evaluationId: command.evaluationId,
                      retroEpoch: initial.manager.epoch!,
                      authorId: plan.authorId,
                      targetOwnership: plan.targetOwnership,
                      candidateClaim: plan.candidateClaim,
                      snapshots: plan.snapshots,
                      fixtures: plan.fixtures,
                    });
              const producer = ReplayArtifacts.layerReplayEvidenceProducer({
                artifactDirectory: (config.value.runner as Runner.MissionRetroReplayRunnerConfig)
                  .artifactDirectory,
                reportArtifactDirectory: config.value.reportArtifactDirectory,
                reviewerId: (config.value.runner as Runner.MissionRetroReplayRunnerConfig)
                  .reviewerId,
                approvedConfigDigests: [config.value.approvedConfigDigest],
                isCurrent,
                readUserIntent: Effect.gen(function* () {
                  const m = yield* assertCanonical;
                  return { stop: m.status === "stopped", pause: m.status === "paused" };
                }).pipe(Effect.orElseSucceed(() => ({ stop: null, pause: null }))),
              }).pipe(Layer.provide(missions));
              const storeContext = yield* Layer.buildWithMemoMap(
                SkillStore.layer.pipe(
                  Layer.provide(producer),
                  Layer.provide(
                    Layer.succeed(SkillStore.MissionRetroSkillEvaluationAuthority, {
                      teamId: trusted.teamId,
                      environmentId,
                      retroThreadId: scope.thread!.threadId,
                      retroEpoch: initial.manager.epoch!,
                      isCurrent,
                    }),
                  ),
                ),
                memo,
                requestScope,
              ).pipe(
                Effect.provide(Context.add(startupContext, SqlClient.SqlClient, requestSql)),
                Effect.provideService(Events.OrchestrationEventStore, events),
                Effect.provideService(Receipts.OrchestrationCommandReceiptRepository, receipts),
              );
              return yield* checked(
                Context.get(storeContext, SkillStore.MissionRetroSkillEvaluationStore).record({
                  commandId: command.commandId,
                  missionId: mission.id,
                  expectedRevision: command.expectedRevision,
                  evaluationId: command.evaluationId,
                  candidateId: plan.candidateId,
                  evidenceArtifactRef: replay.artifactRef,
                  evidenceArtifactSha: replay.artifactSha,
                }),
              );
            }),
        };
        const result = yield* use(runtime);
        yield* assertLive;
        return result;
      }),
    );
  return CombinedMissionRuntime.of({
    status: Effect.sync(() => ({
      authority:
        currentPolicy()?.environmentId !== environmentId ? "authority_unavailable" : "available",
      replay: replayStatus,
    })),
    withRequest,
  });
});

/** Built once in server startup over MissionMcpRuntime's exact policy and real runtime layers. */
export const layer = Layer.effect(CombinedMissionRuntime, make);

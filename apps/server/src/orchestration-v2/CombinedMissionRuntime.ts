import { CommandId } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
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

import * as Scheduler from "../scheduling/Scheduler.ts";
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
  missionManagerReservations,
  missionRetroReportReceipts,
  missionRetroSkillEvaluations,
} from "../../../../packages/contracts/src/missionExecution.ts";
import { reserveDueRotation } from "./MissionManagerDailyRotation.ts";
import * as Transfer from "./MissionManagerTransferStore.ts";
import * as Handoff from "./MissionManagerHandoffArtifacts.ts";
import { evaluateManagerRotation, type ManagerRotationDecision } from "./MissionManagerRotation.ts";
import { managerReservationState } from "../../../../packages/contracts/src/missionManagerTransfer.ts";
import type { MissionCompletionSelector } from "../../../../packages/contracts/src/missionCompletion.ts";
import * as Completion from "./MissionCompletionRouteResolver.ts";
import * as Lifecycle from "./MissionManagerLifecycleStore.ts";
import * as Manager from "./MissionManagerRuntimeAdapter.ts";
import * as ReplayArtifacts from "./MissionRetroReplayArtifacts.ts";
import * as Runner from "./MissionRetroReplayRunner.ts";
import * as SkillStore from "./MissionRetroSkillEvaluationStore.ts";
import * as Missions from "./MissionService.ts";
import * as Planning from "./MissionPlanningStore.ts";
import type { ProPlanningEvent } from "../../../../packages/contracts/src/missionProPlanning.ts";
import type { HostTransportBinding } from "../../../../packages/contracts/src/missionHostProtocol.ts";
import * as Peer from "./MissionPeerHttp.ts";
import type { MissionPeerHandshakeError } from "./MissionPeerHandshake.ts";
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
      "planning_unavailable",
      "host_unavailable",
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
  | Planning.MissionPlanningStoreError
  | MissionPeerHandshakeError
  | Missions.MissionServiceError
  | Transfer.MissionManagerTransferStoreError
  | Completion.MissionCompletionRouteResolverError;
type Role = "delivery" | "retro";
type ReplayCommand = {
  readonly commandId: CommandId;
  readonly expectedRevision: number;
  readonly evaluationId: string;
  readonly planId: string;
};

/** Capabilities expire with this request; no authority or currency callback is caller supplied. */
export interface CombinedMissionRequest {
  /** Reread canonical decisions, attempts, pending reviews and role lineage after a restart. */
  readonly readState: Effect.Effect<Mission, RuntimeError>;
  readonly reserveRotation: (command: {
    readonly commandId: CommandId;
    readonly expectedRevision: number;
  }) => Effect.Effect<
    | { readonly kind: "hold"; readonly decision: ManagerRotationDecision }
    | {
        readonly kind: "reserved";
        readonly reservation: import("../../../../packages/contracts/src/missionManagerTransfer.ts").MissionManagerReservation;
        readonly recovered: boolean;
      }
    | { readonly kind: "denied"; readonly code: string },
    RuntimeError
  >;
  readonly wakeCompletion: (
    selector: MissionCompletionSelector,
  ) => Effect.Effect<unknown, RuntimeError>;
  /** Cut over once, then activate the exact successor even if the incumbent loses its reply. */
  readonly transferAndWake: (command: {
    readonly commandId: CommandId;
    readonly expectedRevision: number;
    readonly reservationId: string;
  }) => Effect.Effect<unknown, RuntimeError>;
  /** Authenticates the peer channel only; never readiness, execution or artifact ACK. */
  readonly connectHost: Effect.Effect<HostTransportBinding, RuntimeError>;
  readonly commitPlanning: (command: {
    readonly commandId: CommandId;
    readonly event: ProPlanningEvent;
  }) => Effect.Effect<Planning.MissionPlanningResult, RuntimeError>;
  readonly restartPlanning: (command: {
    readonly commandId: CommandId;
    readonly planningId: string;
  }) => Effect.Effect<Planning.MissionPlanningResult, RuntimeError>;
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
  rotation: Schema.optional(
    Schema.Struct({
      enabled: Schema.Literal(true),
      authorityRef: Id,
      missionIds: Schema.Array(Id),
    }),
  ),
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
  const serverConfig = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const handoffDirectory = path.join(serverConfig.stateDir, "nofun", "manager-artifacts");
  const boundary = yield* Effect.serviceOption(Manager.MissionManagerBoundaryFacts);
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
  // Observations must come from an independently configured trusted producer.
  // Tool parameters and an available operator quota never stand in for it.
  const planningFacts = yield* Effect.serviceOption(Planning.MissionPlanningFactsPort);
  const peerClient = yield* Effect.serviceOption(Peer.MissionPeerHttp);
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

  yield* Effect.logInfo("Mission P1/P2/P3 consumers registered", {
    roles: "canonical-read/reserve/standby/quiesce/CAS/wake/adoption/retirement",
    replay: replayStatus,
    boundaryFacts: Option.isSome(boundary) ? "configured" : "unconfigured; transfers hold",
    automation: "explicit requests only; no schedule activated",
  });

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
        const planningStore = Effect.gen(function* () {
          if (request.role !== "delivery") return yield* fail("scope_denied");
          if (Option.isNone(planningFacts)) return yield* fail("planning_unavailable");
          const context = yield* Layer.buildWithMemoMap(
            Planning.layer.pipe(
              Layer.provide(authority),
              Layer.provide(Layer.succeed(SqlClient.SqlClient, requestSql)),
              Layer.provide(
                Layer.succeed(Receipts.OrchestrationCommandReceiptRepository, receipts),
              ),
              Layer.provide(Layer.succeed(Planning.MissionPlanningFactsPort, planningFacts.value)),
            ),
            memo,
            requestScope,
          );
          return Context.get(context, Planning.MissionPlanningStore);
        });
        const roleAuthority = Layer.succeed(Transfer.MissionManagerReservationAuthority, {
          teamId: trusted.teamId,
          environmentId,
          controllerThreadId: scope.thread.threadId,
          role: request.role,
          isCurrent,
        });
        // These are runtime observations, never tool arguments. Missing external
        // process/write evidence stays unknown and prevents a reservation.
        const readRotationFacts = Effect.gen(function* () {
          const mission = yield* assertCanonical;
          const owner = mission.managers[request.role]!;
          const reservations = missionManagerReservations(
            mission.execution ?? emptyMissionExecution(),
          ).filter((r) => r.role === request.role);
          const last = reservations.at(-1);
          const external = Option.isSome(boundary)
            ? yield* boundary.value.quiesceBoundary({
                ...request,
                incumbentThreadId: owner.threadId!,
                incumbentEpoch: owner.epoch!,
              })
            : null;
          const routing = Option.isSome(boundary)
            ? yield* boundary.value.completionRoutingReady(request)
            : null;
          return {
            teamId: trusted.teamId,
            environmentId,
            missionId: mission.id,
            role: request.role,
            currentThreadId: owner.threadId!,
            currentEpoch: owner.epoch!,
            observedRevision: mission.revision,
            projectTimezone: mission.projectTimezone ?? "",
            nowIso: DateTime.formatIso(yield* DateTime.now),
            lastSlot: last ? { localDate: last.localDate, ordinal: last.ordinal } : null,
            safeBoundary:
              external === null
                ? null
                : {
                    incumbentIntegrationRunning: external.integrationRunning !== false,
                    incumbentGuiOwned: external.guiOwned !== false,
                    unresolvedShellWrite: external.unmanagedShellWrites === "present",
                    sharedWriteUnknown:
                      external.sharedWrites !== "none" ||
                      external.unmanagedShellWrites === "unknown",
                    quiescenceUnknown:
                      external.integrationRunning === null || external.guiOwned === null,
                    childWorkersPending: false,
                    completionRoutingReady: routing === true,
                  },
            retroQueueDepth: (mission.execution?.retroAnalyses ?? []).filter(
              (r) => r.status !== "settled",
            ).length,
            userStopRequested: mission.status === "stopped",
            userPauseRequested: mission.status === "paused",
            fence: adapter.currentFence(),
          } satisfies Transfer.ManagerTrustedFacts;
        });
        const factsPort = Layer.succeed(Transfer.MissionManagerTrustedFactsPort, {
          readFacts: () =>
            readRotationFacts.pipe(
              Effect.mapError(
                (cause) =>
                  new Transfer.MissionManagerTransferStoreError({
                    operation: "reserve",
                    category: "scope_denied",
                    cause,
                  }),
              ),
            ),
          isCurrent: (facts) => isCurrent() && facts.fence === adapter.currentFence(),
        });
        const runtime: CombinedMissionRequest = {
          readState: assertCanonical,
          reserveRotation: (command) =>
            managerActions.withPermits(1)(
              checked(
                Effect.gen(function* () {
                  const mission = yield* assertCanonical;
                  const facts = yield* readRotationFacts;
                  const decision = evaluateManagerRotation({
                    mission,
                    role: request.role,
                    projectTimezone: mission.projectTimezone,
                    nowIso: facts.nowIso!,
                    lastSlot: facts.lastSlot ?? null,
                    safeBoundary: facts.safeBoundary ?? {
                      incumbentIntegrationRunning: false,
                      incumbentGuiOwned: false,
                      unresolvedShellWrite: false,
                      sharedWriteUnknown: true,
                      quiescenceUnknown: true,
                      childWorkersPending: false,
                      completionRoutingReady: false,
                    },
                    retroQueueDepth: facts.retroQueueDepth ?? undefined,
                    userStopRequested: facts.userStopRequested === true,
                    userPauseRequested: facts.userPauseRequested === true,
                  });
                  if (decision.kind !== "rotate") return { kind: "hold" as const, decision };
                  const previous = missionManagerReservations(
                    mission.execution ?? emptyMissionExecution(),
                  ).find(
                    (r) => r.role === request.role && managerReservationState(r) !== "retired",
                  );
                  if (previous)
                    return { kind: "reserved" as const, reservation: previous, recovered: true };
                  if (mission.revision !== command.expectedRevision)
                    return yield* fail("request_conflict");
                  const artifact = yield* Handoff.stageManagerHandoffArtifact({
                    artifactDirectory: handoffDirectory,
                    input: {
                      mission,
                      intent: decision.intent,
                      routePolicy: { ref: "mission-mcp-policy", revision: trusted.revision },
                    },
                  });
                  const context = yield* Layer.buildWithMemoMap(
                    Transfer.layer.pipe(
                      Layer.provide(roleAuthority),
                      Layer.provide(factsPort),
                      Layer.provide(
                        Handoff.layerFilesystemManagerHandoffArtifactPort(handoffDirectory),
                      ),
                    ),
                    memo,
                    requestScope,
                  ).pipe(
                    Effect.provide(Context.add(startupContext, SqlClient.SqlClient, requestSql)),
                    Effect.provideService(Events.OrchestrationEventStore, events),
                    Effect.provideService(Receipts.OrchestrationCommandReceiptRepository, receipts),
                  );
                  const intent = decision.intent;
                  const result = yield* Context.get(
                    context,
                    Transfer.MissionManagerTransferStore,
                  ).reserve({
                    commandId: command.commandId,
                    missionId: mission.id,
                    role: request.role,
                    expectedRevision: command.expectedRevision,
                    projectTimezone: intent.timezone,
                    currentThreadId: intent.currentThreadId,
                    currentEpoch: intent.currentEpoch,
                    localDate: intent.localDate,
                    ordinal: intent.ordinal,
                    reason: intent.reason,
                    artifactRef: artifact.artifactRef,
                  });
                  return Result.isFailure(result)
                    ? { kind: "denied" as const, code: result.failure.code }
                    : {
                        kind: "reserved" as const,
                        reservation: result.success.reservation,
                        recovered: result.success.recovered,
                      };
                }),
              ),
            ),
          wakeCompletion: (selector) =>
            managerActions.withPermits(1)(
              checked(
                Effect.gen(function* () {
                  if (selector.missionId !== request.missionId) return yield* fail("scope_denied");
                  const context = yield* Layer.buildWithMemoMap(
                    Completion.layer.pipe(Layer.provide(roleAuthority)),
                    memo,
                    requestScope,
                  ).pipe(Effect.provideService(SqlClient.SqlClient, requestSql));
                  const route = yield* Context.get(
                    context,
                    Completion.MissionCompletionRouteResolver,
                  ).resolve(selector);
                  if (route.kind === "hold") return route;
                  if (route.candidate.role !== request.role) return yield* fail("scope_denied");
                  return yield* adapter.wakeCurrentRole({
                    ...request,
                    wakeKey: route.candidate.notificationId,
                    expectedOwner: {
                      threadId: route.candidate.targetThreadId,
                      epoch: route.candidate.targetEpoch,
                    },
                    instruction:
                      "A canonical completion is awaiting review. Reread the mission and inspect its original producing task/run and exact result before accepting or integrating. Notification: " +
                      route.candidate.notificationId,
                  });
                }),
              ),
            ),
          transferAndWake: (command) =>
            managerActions.withPermits(1)(
              Effect.gen(function* () {
                yield* assertCanonical;
                const transfer = yield* lifecycle.advance({
                  ...command,
                  ...request,
                  step: "transfer",
                });
                if (Result.isFailure(transfer)) return transfer;
                // No outer SQL transaction around external thread/session commands:
                // those commands own their commits. The lifecycle CAS is durable first.
                yield* assertLive;
                const wake = yield* adapter.wakeCurrentRole({
                  ...request,
                  reservationId: command.reservationId,
                  wakeKey: `activate:${command.reservationId}`,
                  instruction:
                    "Adopt the canonical manager role. Reread accepted decisions, attempts, pending reviews and the immutable handoff before acting. Confirm routing with the requested ACK.",
                });
                return { transfer, wake };
              }),
            ),
          connectHost: managerActions.withPermits(1)(
            Effect.gen(function* () {
              if (request.role !== "delivery") return yield* fail("scope_denied");
              if (Option.isNone(peerClient)) return yield* fail("host_unavailable");
              yield* assertCanonical;
              const binding = yield* peerClient.value.connect;
              // The network wait must not let a rotated manager retain a result.
              yield* assertCanonical;
              if (binding.teamId !== trusted.teamId || binding.environmentId !== environmentId)
                return yield* fail("scope_denied");
              return binding;
            }),
          ),
          commitPlanning: (command) =>
            managerActions.withPermits(1)(
              checked(
                Effect.gen(function* () {
                  const store = yield* planningStore;
                  return yield* store.commit({ ...command, missionId: request.missionId });
                }),
              ),
            ),
          restartPlanning: (command) =>
            managerActions.withPermits(1)(
              checked(
                Effect.gen(function* () {
                  const store = yield* planningStore;
                  return yield* store.restart({ ...command, missionId: request.missionId });
                }),
              ),
            ),
          launchStandby: (reservationId) =>
            managerActions.withPermits(1)(
              checked(adapter.launchStandby({ ...request, reservationId })),
            ),
          readLifecycleFacts: (reservationId, step) =>
            managerActions.withPermits(1)(
              checked(adapter.readLifecycleFacts({ ...request, reservationId, step })),
            ),
          advance: (command) =>
            managerActions.withPermits(1)(checked(lifecycle.advance({ ...command, ...request }))),
          cleanupIncumbent: (reservationId) =>
            managerActions.withPermits(1)(
              checked(adapter.cleanupIncumbent({ ...request, reservationId })),
            ),
          wakeCurrentRole: (command) =>
            managerActions.withPermits(1)(
              checked(adapter.wakeCurrentRole({ ...command, ...request })),
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
  // Reuse the application scheduler. A reservation is the explicit durable
  // opt-in; startup never creates daily threads or activates a fleet. Running
  // after the incumbent turn settles makes quiescence possible without asking
  // a manager to mutate its own role from inside an active provider turn.
  const scheduler = yield* Scheduler.Scheduler;
  const reconcileManagers = managerActions
    .withPermits(1)(
      Effect.scoped(
        Effect.gen(function* () {
          const trusted = currentPolicy();
          if (
            !trusted ||
            trusted.environmentId !== environmentId ||
            trusted.allowedProjectIds.length === 0
          )
            return;
          const policyIdentity = stableStringify(trusted);
          const isCurrent = () => stableStringify(currentPolicy()) === policyIdentity;
          const rows = yield* sql<{
            snapshot_json: string;
          }>`SELECT snapshot_json FROM projection_missions WHERE team_id = ${trusted.teamId} AND authority_environment_id = ${environmentId}`;
          for (const row of rows) {
            const mission = yield* decodeMission(row.snapshot_json).pipe(Effect.option);
            if (
              Option.isNone(mission) ||
              mission.value.status !== "active" ||
              !mission.value.bindings.every((b) => trusted.allowedProjectIds.includes(b.projectId))
            )
              continue;
            // Daily activation is an explicit owner-configured allowlist, separate
            // from merely installing/registering these consumers.
            if (
              approved &&
              Option.isSome(config) &&
              config.value.rotation?.missionIds.includes(mission.value.id)
            ) {
              for (const role of ["delivery", "retro"] as const) {
                const owner = mission.value.managers[role];
                if (!owner?.threadId || owner.epoch === undefined) continue;
                const memo = yield* Layer.forkMemoMap(parentMemo);
                const context = yield* Layer.buildWithMemoMap(
                  RuntimeLayer.layerMissionManagerLifecycle.pipe(
                    Layer.provide(
                      Layer.succeed(Lifecycle.MissionManagerLifecycleAuthority, {
                        teamId: trusted.teamId,
                        environmentId,
                        role,
                        isCurrent,
                      }),
                    ),
                  ),
                  memo,
                  yield* Scope.Scope,
                ).pipe(Effect.provide(startupContext));
                yield* reserveDueRotation(mission.value.id).pipe(
                  Effect.provide(Context.merge(startupContext, context)),
                  Effect.provideService(Transfer.MissionManagerReservationAuthority, {
                    teamId: trusted.teamId,
                    environmentId,
                    controllerThreadId: owner.threadId,
                    role,
                    isCurrent,
                  }),
                );
              }
            }
            const pending = missionManagerReservations(
              mission.value.execution ?? emptyMissionExecution(),
            ).filter((r) => managerReservationState(r) !== "retired");
            for (const reservation of pending) {
              if (!isCurrent()) return;
              const role = reservation.role;
              const request = {
                missionId: mission.value.id,
                role,
                reservationId: reservation.reservationId,
              };
              const memo = yield* Layer.forkMemoMap(parentMemo);
              const context = yield* Layer.buildWithMemoMap(
                RuntimeLayer.layerMissionManagerLifecycle.pipe(
                  Layer.provide(
                    Layer.succeed(Lifecycle.MissionManagerLifecycleAuthority, {
                      teamId: trusted.teamId,
                      environmentId,
                      role,
                      isCurrent,
                    }),
                  ),
                ),
                memo,
                yield* Scope.Scope,
              ).pipe(Effect.provide(startupContext));
              const adapter = Context.get(context, Manager.MissionManagerRuntimeAdapter);
              const lifecycle = Context.get(context, Lifecycle.MissionManagerLifecycleStore);
              for (let stepIndex = 0; stepIndex < 6 && isCurrent(); stepIndex += 1) {
                const latest = yield* sql<{
                  snapshot_json: string;
                }>`SELECT snapshot_json FROM projection_missions WHERE mission_id = ${request.missionId} AND team_id = ${trusted.teamId} AND authority_environment_id = ${environmentId}`;
                if (!latest[0]) break;
                const canonical = yield* decodeMission(latest[0].snapshot_json);
                if (canonical.status !== "active") break;
                const current = missionManagerReservations(
                  canonical.execution ?? emptyMissionExecution(),
                ).find((r) => r.reservationId === reservation.reservationId);
                if (!current) break;
                const state = managerReservationState(current);
                if (state === "retired") break;
                if (state === "reserved") {
                  const launch = yield* adapter.launchStandby(request);
                  if (launch.kind === "hold") break;
                }
                if (state === "transferred") {
                  // Reissuing a lost activation wake uses exactly the same epoch/key.
                  yield* adapter.wakeCurrentRole({
                    ...request,
                    wakeKey: `activate:${reservation.reservationId}`,
                    expectedOwner: {
                      threadId: current.successorThreadId,
                      epoch: current.currentEpoch + 1,
                    },
                    instruction:
                      "Adopt the canonical manager role. Reread accepted decisions, attempts, pending reviews and the immutable handoff before acting. Confirm routing with the requested ACK.",
                  });
                }
                if (state === "routing_confirmed") {
                  const cleanup = yield* adapter.cleanupIncumbent(request);
                  if (cleanup.kind === "hold") break;
                }
                const step =
                  state === "reserved"
                    ? "standby"
                    : state === "standby_ready"
                      ? "quiesce"
                      : state === "quiesced"
                        ? "transfer"
                        : state === "transferred"
                          ? "routing"
                          : "retire";
                const result = yield* lifecycle.advance({
                  ...request,
                  step,
                  commandId: CommandId.make(
                    `manager-reconcile:${reservation.reservationId}:${step}`,
                  ),
                  expectedRevision: canonical.revision,
                });
                if (Result.isFailure(result)) break;
              }
            }
            // Canonical results survive mailbox ACK and parent retirement.
            // Re-derive their current role every tick; the epoch/key-bound
            // thread command coalesces repeats without another provider turn.
            for (const role of ["delivery", "retro"] as const) {
              if (!isCurrent()) return;
              const latest = yield* sql<{
                snapshot_json: string;
              }>`SELECT snapshot_json FROM projection_missions WHERE mission_id = ${mission.value.id} AND team_id = ${trusted.teamId} AND authority_environment_id = ${environmentId}`;
              if (!latest[0]) continue;
              const current = yield* decodeMission(latest[0].snapshot_json);
              const owner = current.managers[role];
              if (current.status !== "active" || !owner?.threadId || owner.epoch === undefined)
                continue;
              const selectors: MissionCompletionSelector[] =
                role === "delivery"
                  ? (current.execution?.results ?? [])
                      .filter((r) => r.reviewReceipt === undefined)
                      .map((r) => ({
                        kind: "task-result",
                        missionId: current.id,
                        taskId: r.taskId,
                        attemptNumber: r.attemptNumber,
                        resultRevision: r.provenance.resultRevision,
                      }))
                  : (current.execution?.retroReportReceipts ?? []).map((r) => ({
                      kind: "retro-report",
                      missionId: current.id,
                      checkpointId: r.checkpointId,
                      reportRevision: r.reportRevision,
                    }));
              if (selectors.length === 0) continue;
              const memo = yield* Layer.forkMemoMap(parentMemo);
              const roleAuthority = Layer.succeed(Transfer.MissionManagerReservationAuthority, {
                teamId: trusted.teamId,
                environmentId,
                controllerThreadId: owner.threadId,
                role,
                isCurrent,
              });
              const context = yield* Layer.buildWithMemoMap(
                Layer.mergeAll(
                  Completion.layer.pipe(Layer.provide(roleAuthority)),
                  RuntimeLayer.layerMissionManagerLifecycle.pipe(
                    Layer.provide(
                      Layer.succeed(Lifecycle.MissionManagerLifecycleAuthority, {
                        teamId: trusted.teamId,
                        environmentId,
                        role,
                        isCurrent,
                      }),
                    ),
                  ),
                ),
                memo,
                yield* Scope.Scope,
              ).pipe(Effect.provide(startupContext));
              const resolver = Context.get(context, Completion.MissionCompletionRouteResolver);
              const adapter = Context.get(context, Manager.MissionManagerRuntimeAdapter);
              for (const selector of selectors) {
                const route = yield* resolver.resolve(selector);
                if (route.kind !== "candidate") continue;
                yield* adapter.wakeCurrentRole({
                  missionId: current.id,
                  role,
                  wakeKey: route.candidate.notificationId,
                  expectedOwner: {
                    threadId: route.candidate.targetThreadId,
                    epoch: route.candidate.targetEpoch,
                  },
                  instruction:
                    "A canonical completion is awaiting review. Reread the mission and inspect its original producing task/run and exact result before accepting or integrating. Notification: " +
                    route.candidate.notificationId,
                });
              }
            }
          }
        }),
      ),
    )
    .pipe(
      Effect.catch(() =>
        Effect.logWarning("Mission manager reconciliation held; durable reservation retained"),
      ),
    );
  yield* scheduler.register("mission-manager-lifecycle", reconcileManagers);
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

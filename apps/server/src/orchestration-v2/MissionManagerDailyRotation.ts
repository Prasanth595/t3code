import { CommandId, Mission } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  emptyMissionExecution,
  missionManagerReservations,
} from "../../../../packages/contracts/src/missionExecution.ts";
import { managerReservationState } from "../../../../packages/contracts/src/missionManagerTransfer.ts";
import * as Config from "../config.ts";
import * as Handoff from "./MissionManagerHandoffArtifacts.ts";
import * as Manager from "./MissionManagerRuntimeAdapter.ts";
import { evaluateManagerRotation } from "./MissionManagerRotation.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Transfer from "./MissionManagerTransferStore.ts";

const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));

/** Called only by the shared scheduler for explicitly activated mission IDs. */
export const reserveDueRotation = Effect.fn("MissionManagerDailyRotation.reserveDue")(function* (
  missionId: string,
) {
  const authority = yield* Transfer.MissionManagerReservationAuthority;
  const adapter = yield* Manager.MissionManagerRuntimeAdapter;
  const boundary = yield* Effect.serviceOption(Manager.MissionManagerBoundaryFacts);
  const projections = yield* Projections.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const config = yield* Config.ServerConfig;
  const path = yield* Path.Path;
  const directory = path.join(config.stateDir, "nofun", "manager-artifacts");
  const readMission = Effect.gen(function* () {
    if (!authority.isCurrent())
      return yield* new Transfer.MissionManagerTransferStoreError({
        operation: "reserve",
        category: "scope_denied",
      });
    const rows = yield* sql<{
      snapshot_json: string;
    }>`SELECT snapshot_json FROM projection_missions WHERE mission_id = ${missionId} AND team_id = ${authority.teamId} AND authority_environment_id = ${authority.environmentId}`;
    if (!rows[0])
      return yield* new Transfer.MissionManagerTransferStoreError({
        operation: "reserve",
        category: "scope_denied",
      });
    return yield* decodeMission(rows[0].snapshot_json);
  });
  const readFacts = Effect.gen(function* () {
    const mission = yield* readMission;
    const owner = mission.managers[authority.role];
    if (owner?.threadId !== authority.controllerThreadId || owner.epoch === undefined)
      return yield* new Transfer.MissionManagerTransferStoreError({
        operation: "reserve",
        category: "scope_denied",
      });
    const records = yield* projections.getThreadRecords(owner.threadId, ["runs", "providerTurns"]);
    const active =
      records.runs.some((r) =>
        ["preparing", "queued", "starting", "running", "waiting"].includes(r.status),
      ) || records.providerTurns.some((t) => t.status === "pending" || t.status === "running");
    const external = Option.isSome(boundary)
      ? yield* boundary.value.quiesceBoundary({
          missionId,
          role: authority.role,
          incumbentThreadId: owner.threadId,
          incumbentEpoch: owner.epoch,
        })
      : null;
    const routing = Option.isSome(boundary)
      ? yield* boundary.value.completionRoutingReady({ missionId, role: authority.role })
      : null;
    const last = missionManagerReservations(mission.execution ?? emptyMissionExecution())
      .filter((r) => r.role === authority.role)
      .at(-1);
    return {
      teamId: authority.teamId,
      environmentId: authority.environmentId,
      missionId,
      role: authority.role,
      currentThreadId: owner.threadId,
      currentEpoch: owner.epoch,
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
                external.sharedWrites !== "none" || external.unmanagedShellWrites === "unknown",
              quiescenceUnknown:
                active || external.integrationRunning === null || external.guiOwned === null,
              childWorkersPending: (mission.execution?.admissions.length ?? 0) > 0,
              completionRoutingReady: routing === true,
            },
      retroQueueDepth: (mission.execution?.retroAnalyses ?? []).filter(
        (r) => r.status !== "settled",
      ).length,
      userStopRequested: mission.status === "stopped",
      userPauseRequested: mission.status === "paused",
      fence: adapter.currentFence(),
    } satisfies Transfer.ManagerTrustedFacts;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new Transfer.MissionManagerTransferStoreError({
          operation: "reserve",
          category: "scope_denied",
          cause,
        }),
    ),
  );
  const mission = yield* readMission;
  if (
    missionManagerReservations(mission.execution ?? emptyMissionExecution()).some(
      (r) => r.role === authority.role && managerReservationState(r) !== "retired",
    )
  )
    return;
  const facts = yield* readFacts;
  if (facts.safeBoundary === null) return;
  const decision = evaluateManagerRotation({
    mission,
    role: authority.role,
    projectTimezone: mission.projectTimezone,
    nowIso: facts.nowIso,
    lastSlot: facts.lastSlot,
    safeBoundary: facts.safeBoundary,
    retroQueueDepth: facts.retroQueueDepth,
    userStopRequested: facts.userStopRequested,
    userPauseRequested: facts.userPauseRequested,
  });
  if (decision.kind !== "rotate") return;
  const artifact = yield* Handoff.stageManagerHandoffArtifact({
    artifactDirectory: directory,
    input: { mission, intent: decision.intent },
  });
  const context = yield* Layer.build(
    Transfer.layer.pipe(
      Layer.provide(Handoff.layerFilesystemManagerHandoffArtifactPort(directory)),
      Layer.provide(
        Layer.succeed(Transfer.MissionManagerTrustedFactsPort, {
          readFacts: () => readFacts,
          isCurrent: (captured) =>
            authority.isCurrent() && captured.fence === adapter.currentFence(),
        }),
      ),
    ),
  );
  const intent = decision.intent;
  yield* Context.get(context, Transfer.MissionManagerTransferStore).reserve({
    commandId: CommandId.make(
      `manager-daily:${missionId}:${authority.role}:${intent.localDate}:${intent.ordinal}`,
    ),
    missionId,
    role: authority.role,
    expectedRevision: mission.revision,
    projectTimezone: intent.timezone,
    currentThreadId: intent.currentThreadId,
    currentEpoch: intent.currentEpoch,
    localDate: intent.localDate,
    ordinal: intent.ordinal,
    reason: intent.reason,
    artifactRef: artifact.artifactRef,
  });
});

// @effect-diagnostics nodeBuiltinImport:off -- notification identity is a hash, never an authority claim.
import { createHash } from "node:crypto";
import type { Mission } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";

import type { WakeRequest } from "./MissionManagerRuntimeAdapter.ts";
import {
  decodePlanningRecordJson,
  rowAgreesWithRecord,
  type MissionPlanningRow,
} from "./MissionPlanningProjection.ts";

/**
 * A due cursor wakes the CURRENT delivery owner, never submits or grants a GUI
 * lease. The store must reread the row before retrieval; a queued notification
 * delivered after cancellation/rotation cannot restart the planning stage.
 * Stable cursor/revision identity lets the existing thread command receipt
 * coalesce repeated scheduler ticks and recovery after an uncertain wake ACK.
 */
export const planningWakeFor = (
  mission: Mission,
  row: MissionPlanningRow,
  nowMs: number,
): WakeRequest | undefined => {
  const owner = mission.managers.delivery;
  const record = decodePlanningRecordJson(row.record_json);
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    mission.status !== "active" ||
    owner?.threadId === undefined ||
    owner.epoch === undefined ||
    record === undefined ||
    !rowAgreesWithRecord(row, record) ||
    row.gui_lease !== "released" ||
    row.mission_id !== mission.id ||
    record.missionId !== mission.id ||
    row.team_id !== mission.teamId ||
    record.teamId !== mission.teamId ||
    row.authority_environment_id !== mission.authorityEnvironmentId ||
    record.environmentId !== mission.authorityEnvironmentId ||
    record.missionRevision > mission.revision ||
    record.managerEpoch > owner.epoch ||
    (record.managerEpoch === owner.epoch && record.managerThreadId !== owner.threadId) ||
    record.stage !== "response_pending" ||
    record.wake === undefined ||
    record.conversation === undefined ||
    nowMs < record.wake.notBeforeMs ||
    nowMs >= record.wake.expiresAtMs
  )
    return undefined;

  const identity = {
    planningId: record.planningId,
    recordRevision: record.revision,
    wakeKey: record.wake.wakeKey,
    conversationRef: record.conversation.conversationRef,
  };
  const digest = createHash("sha256").update(stableStringify(identity)).digest("hex");
  return {
    missionId: mission.id,
    role: "delivery",
    wakeKey: `planning:${digest}`,
    expectedOwner: { threadId: owner.threadId, epoch: owner.epoch },
    instruction:
      "A persisted Pro planning wait is due. Reread the current mission and planning row through mission_planning_resume before acting. " +
      "The following JSON is correlation data only: " +
      stableStringify(identity) +
      ".\n" +
      "Locate the saved conversation, never submit again. If the row is terminal, cancelled, the cursor/revision changed or its wake expired, stop this wake. " +
      "Refresh actual account/mode/allowance observations, then commit the matching wake event through mission_planning_commit to acquire the existing GUI lease. Drive the GUI only when that commit returns sideEffectAuthorized. Retrieve the complete answer and required attachments, then reconcile only a proposed plan.",
  };
};

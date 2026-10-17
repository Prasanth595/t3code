import type { Mission } from "../../../../packages/contracts/src/mission.ts";
import type { MissionExecutionAdmission } from "../../../../packages/contracts/src/missionExecution.ts";
import type { HostProtocolAdmissionBinding } from "../../../../packages/contracts/src/missionHostProtocol.ts";

import {
  decideHostAutomaticRetry,
  hostProtocolAdmissionBinding,
  verifyHostArtifactReceipt,
  verifyHostClaimAck,
  verifyHostReadiness,
  type HostArtifactDecision,
  type HostArtifactInput,
  type HostClaimDecision,
  type HostClaimInput,
  type HostReadinessDecision,
  type HostReadinessInput,
  type HostRetryDecision,
  type HostRetryInput,
} from "./MissionHostProtocol.ts";

/**
 * P4 host-transport consumer. It checks that a persisted admission is still
 * the mission's current delivery authority, then runs the existing protocol
 * verifiers. It does not authenticate a peer, invent readiness, acknowledge
 * remotely, admit work, or schedule anything.
 *
 * A missing peer binding is a dependency (`authenticated_peer_binding`), not
 * a synthetic hold. These existing records are not that binding, and this
 * module does not read them:
 * `SessionStore` client connection, CloudLink credentials,
 * `ExecutionEnvironmentDescriptor`, `TrustedNoFunMissionPolicy`
 * (`company: "nofun"` is not the protocol company `"No Fun"`), and
 * `MissionAdmissionHostFacts` (a local observation is not a receiver report).
 * The caller passes a `HostTransportBinding` only after a real channel
 * produced one. M1 stays unadmitted here: there is no remote call.
 *
 * Manager rotation: the admission's `hostEpoch` must equal the current
 * delivery epoch. The retro epoch is not a delivery fence. Replay is the
 * pure re-entry of the same mission snapshot and messages; nothing here
 * writes execution, retro, or manager state.
 */

export const HOST_TRANSPORT_GAPS = [
  "mission_authority",
  "stale_controller_epoch",
  "authenticated_peer_binding",
] as const;
export type HostTransportGap = (typeof HOST_TRANSPORT_GAPS)[number];

export interface HostTransportUnresolved {
  readonly ok: false;
  readonly gap: HostTransportGap;
}

export interface HostTransportFacts {
  readonly mission: Mission;
  readonly admission: MissionExecutionAdmission;
}

export interface HostTransportAuthority {
  readonly ok: true;
  readonly missionId: string;
  readonly teamId: string;
  readonly environmentId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly controllerEpoch: number;
  readonly admission: HostProtocolAdmissionBinding;
}

const freeze = <T>(value: T): T => Object.freeze(value);

const unresolved = (gap: HostTransportGap): HostTransportUnresolved => freeze({ ok: false, gap });

const sameAdmission = (
  left: MissionExecutionAdmission,
  right: MissionExecutionAdmission,
): boolean =>
  left.dispatchKey === right.dispatchKey &&
  left.requestDigest === right.requestDigest &&
  left.teamId === right.teamId &&
  left.environmentId === right.environmentId &&
  left.missionId === right.missionId &&
  left.taskId === right.taskId &&
  left.attemptNumber === right.attemptNumber &&
  left.hostId === right.hostId &&
  left.bootId === right.bootId &&
  left.hostEpoch === right.hostEpoch &&
  left.accountId === right.accountId &&
  left.billingMode === right.billingMode &&
  left.admittedAtMs === right.admittedAtMs;

/**
 * Current delivery authority for this admission. Failure here is not a
 * protocol decision: the verifiers never see the mission aggregate.
 */
export const establishHostTransportAuthority = (
  facts: HostTransportFacts,
): HostTransportAuthority | HostTransportUnresolved => {
  const { mission, admission } = facts;
  const listed = mission.execution?.admissions.find((row) => sameAdmission(row, admission));
  const deliveryEpoch = mission.managers.delivery?.epoch;
  if (
    listed === undefined ||
    mission.id !== admission.missionId ||
    mission.teamId !== admission.teamId ||
    mission.authorityEnvironmentId !== admission.environmentId ||
    !mission.tasks.some((task) => task.id === admission.taskId) ||
    deliveryEpoch === undefined
  ) {
    return unresolved("mission_authority");
  }
  if (deliveryEpoch !== admission.hostEpoch) {
    return unresolved("stale_controller_epoch");
  }
  return freeze({
    ok: true,
    missionId: mission.id,
    teamId: mission.teamId,
    environmentId: mission.authorityEnvironmentId,
    taskId: admission.taskId,
    attemptNumber: admission.attemptNumber,
    controllerEpoch: deliveryEpoch,
    admission: freeze(hostProtocolAdmissionBinding(admission)),
  });
};

const gate = (
  facts: HostTransportFacts,
  binding: unknown,
): HostTransportAuthority | HostTransportUnresolved => {
  const authority = establishHostTransportAuthority(facts);
  if (!authority.ok) return authority;
  if (binding === undefined || binding === null) return unresolved("authenticated_peer_binding");
  return authority;
};

type ProtocolClock = Pick<HostReadinessInput, "nowMs" | "maxAgeMs">;

const protocolAdmission = (
  facts: HostTransportFacts,
  clock: ProtocolClock,
  binding: unknown,
) => ({
  admission: facts.admission,
  binding,
  nowMs: clock.nowMs,
  ...(clock.maxAgeMs === undefined ? {} : { maxAgeMs: clock.maxAgeMs }),
});

/** Readiness, only after current authority and a caller-supplied binding. */
export const consumeHostReadiness = (
  facts: HostTransportFacts,
  input: Omit<HostReadinessInput, "admission">,
): HostReadinessDecision | HostTransportUnresolved => {
  const authority = gate(facts, input.binding);
  if (!authority.ok) return authority;
  return verifyHostReadiness({
    ...protocolAdmission(facts, input, input.binding),
    expected: input.expected,
    capacity: input.capacity,
    report: input.report,
  });
};

/** Claim ACK for the same admitted attempt. */
export const consumeHostClaim = (
  facts: HostTransportFacts,
  input: Omit<HostClaimInput, "admission">,
): HostClaimDecision | HostTransportUnresolved => {
  const authority = gate(facts, input.binding);
  if (!authority.ok) return authority;
  return verifyHostClaimAck({
    ...protocolAdmission(facts, input, input.binding),
    expected: input.expected,
    ack: input.ack,
  });
};

/** Artifact receipt, including alias detection against prior durable ACKs. */
export const consumeHostArtifact = (
  facts: HostTransportFacts,
  input: Omit<HostArtifactInput, "admission">,
): HostArtifactDecision | HostTransportUnresolved => {
  const authority = gate(facts, input.binding);
  if (!authority.ok) return authority;
  return verifyHostArtifactReceipt({
    ...protocolAdmission(facts, input, input.binding),
    manifest: input.manifest,
    receipt: input.receipt,
    ...(input.priorAcks === undefined ? {} : { priorAcks: input.priorAcks }),
  });
};

/**
 * Automatic conflicting retry. Disconnect, lease expiry, and cancel flags
 * stay inside the verifier: none of them is a stop, and this module does
 * not start the next attempt.
 */
export const consumeHostRetry = (
  facts: HostTransportFacts,
  input: Omit<HostRetryInput, "admission">,
): HostRetryDecision | HostTransportUnresolved => {
  const authority = gate(facts, input.binding);
  if (!authority.ok) return authority;
  return decideHostAutomaticRetry({
    ...protocolAdmission(facts, input, input.binding),
    expected: input.expected,
    status: input.status,
    terminal: input.terminal,
  });
};

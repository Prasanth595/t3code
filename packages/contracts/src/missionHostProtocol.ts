import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt } from "./baseSchemas.ts";
import { Sha256Hex } from "./missionRetro.ts";

/**
 * Leaf wire schemas for the two-host readiness / claim / artifact ACK
 * evidence that the server's pure verifier (`MissionHostProtocol.ts`) checks.
 * No transport, storage, or runtime logic lives here, and no transport API is
 * invented: the receiver's messages arrive over whatever authenticated
 * channel a future adapter owns, and the adapter supplies the trusted
 * `HostTransportBinding` out of band. Nothing here carries credentials,
 * addresses, profiles, sessions, or filesystem paths.
 *
 * Trust model. Receiver messages (`HostReadinessReport`, `HostClaimAck`,
 * `HostTerminalReport`, `HostArtifactReceipt`) are untrusted claims. Every
 * other schema is a fact the *source* side established separately (its own
 * admission receipt, manifest, transport authentication, shared ledger). A
 * bridge event being saved or queued is none of these: it is not a message
 * the receiver authored.
 *
 * Identifiers are bounded opaque strings compared byte-for-byte. They are not
 * trimmed, normalized, or decoded through branded T3 ID schemas, so a padded
 * or aliased identifier can never silently become an equal one.
 */

export const HOST_PROTOCOL_VERSION = 1;

/** Longest accepted opaque identifier or build/commit reference. */
export const MAX_HOST_PROTOCOL_ID_LENGTH = 512;

/** Most prior durable artifact ACK records one verification may consult. */
export const MAX_HOST_PROTOCOL_PRIOR_ACKS = 64;

/** The only company this protocol serves. CATCHES and any other company are denied. */
export const HOST_PROTOCOL_COMPANY = "No Fun";

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

/** Bounded opaque identifier: 1..512 chars, no control characters, no edge whitespace. */
export const HostProtocolId = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.length >= 1 &&
      value.length <= MAX_HOST_PROTOCOL_ID_LENGTH &&
      value === value.trim() &&
      !hasControlCharacter(value),
    { expected: "a bounded opaque identifier without control characters or edge whitespace" },
  ),
);
export type HostProtocolId = typeof HostProtocolId.Type;

/**
 * Host-local opaque reference (for example a worktree handle). Host-local
 * paths are never shared across hosts, so a path-shaped value is rejected.
 */
export const HostLocalRef = HostProtocolId.check(
  Schema.makeFilter(
    (value) => !/[\\/]/.test(value) && !value.startsWith("~") && value !== "." && value !== "..",
    {
      expected: "a host-local reference that is not a filesystem path",
    },
  ),
);
export type HostLocalRef = typeof HostLocalRef.Type;

/** Lowercase hex git object name (SHA-1 or SHA-256 repository). */
export const HostProtocolCommit = Schema.String.check(
  Schema.makeFilter((value) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value), {
    expected: "a lowercase 40 or 64 hex git commit",
  }),
);
export type HostProtocolCommit = typeof HostProtocolCommit.Type;

/** Finite bounded reasons a verification may return. Severity is server policy. */
export const HostProtocolReasonCode = Schema.Literals([
  // Inputs and trust
  "clock_invalid",
  "admission_malformed",
  "binding_malformed",
  "expectation_malformed",
  "capacity_malformed",
  "status_malformed",
  "message_malformed",
  "prior_malformed",
  "transport_unauthenticated",
  "binding_stale",
  "evidence_from_future",
  "verifier_fault",
  // Identity, company, and receiver stamp
  "company_denied",
  "team_mismatch",
  "environment_mismatch",
  "mission_mismatch",
  "task_mismatch",
  "attempt_mismatch",
  "admission_mismatch",
  "command_mismatch",
  "run_mismatch",
  "source_host_mismatch",
  "receiver_host_mismatch",
  "admitted_host_mismatch",
  "receiver_boot_mismatch",
  "epoch_mismatch",
  "repository_mismatch",
  "worktree_mismatch",
  "commit_mismatch",
  "runtime_build_mismatch",
  "capability_mismatch",
  // Evidence stage and freshness
  "receiver_ack_missing",
  "queued_only",
  "observed_not_claimed",
  "received_not_durable",
  "ack_stale",
  "evidence_stale",
  "evidence_predates_admission",
  "durable_ack_unsupported",
  "durable_ack_unknown",
  // Readiness and shared budget
  "build_not_ok",
  "toolchain_not_ok",
  "pressure_unacceptable",
  "pressure_unknown",
  "no_heavy_build_slot",
  "account_mismatch",
  "account_budget_not_global",
  "account_reservation_missing",
  "account_headroom_low",
  "account_headroom_exhausted",
  "account_headroom_unknown",
  // Artifact content
  "artifact_id_mismatch",
  "artifact_hash_mismatch",
  "artifact_size_mismatch",
  "artifact_alias_conflict",
  // Disconnect, cancel, retry fencing
  "disconnected_not_stopped",
  "connection_unknown",
  "lease_expired_not_stopped",
  "lease_unknown",
  "cancel_requested_not_stopped",
  "cancel_acknowledged_not_terminal",
  "cancel_unknown",
  "terminal_missing",
  "terminal_outcome_uncertain",
  "attempt_completed",
  "cleanup_unproven",
  "fencing_unsupported",
  "fencing_unknown",
  "fence_generation_behind",
]);
export type HostProtocolReasonCode = typeof HostProtocolReasonCode.Type;

const Kind = <const K extends string>(kind: K) => Schema.Literal(kind);
const Version = Schema.Literal(HOST_PROTOCOL_VERSION);

/** Identity fields shared by every post-claim receiver message. */
const TaskIdentityFields = {
  teamId: HostProtocolId,
  environmentId: HostProtocolId,
  company: HostProtocolId,
  missionId: HostProtocolId,
  taskId: HostProtocolId,
  attemptNumber: PositiveInt,
  /** The admission receipt's request digest. */
  admissionDigest: Sha256Hex,
  commandId: HostProtocolId,
  runId: HostProtocolId,
  /** Host that dispatched the work or produced the artifact. */
  sourceHostId: HostProtocolId,
  /** Host that acknowledges: the executing host for claims, the consumer for artifacts. */
  receiverHostId: HostProtocolId,
  /** Delivery-manager epoch the work was admitted under (the admission's hostEpoch). */
  controllerEpoch: NonNegativeInt,
  projectId: HostProtocolId,
  /** Opaque ref of the attempt's worktree on the executing host; never a path. */
  worktreeRef: HostLocalRef,
  sourceCommit: HostProtocolCommit,
} as const;

/** What the receiver says about itself. Compared with the trusted transport binding. */
const ReceiverStampFields = {
  receiverBootId: HostProtocolId,
  runtimeBuildId: HostProtocolId,
  capabilityHash: Sha256Hex,
} as const;

// ---------------------------------------------------------------------------
// Untrusted receiver messages
// ---------------------------------------------------------------------------

/** Pre-dispatch readiness the candidate executing host reports about itself. */
export const HostReadinessReport = Schema.Struct({
  version: Version,
  kind: Kind("host_readiness"),
  teamId: HostProtocolId,
  environmentId: HostProtocolId,
  company: HostProtocolId,
  controllerEpoch: NonNegativeInt,
  receiverHostId: HostProtocolId,
  ...ReceiverStampFields,
  projectId: HostProtocolId,
  sourceCommit: HostProtocolCommit,
  buildOk: Schema.Boolean,
  toolchainOk: Schema.Boolean,
  pressure: Schema.Literals(["acceptable", "elevated", "critical", "unknown"]),
  /** Host-local heavy-build slots only; never an account or fleet total. */
  heavyBuildSlotsFree: NonNegativeInt,
  observedAtMs: NonNegativeInt,
});
export type HostReadinessReport = typeof HostReadinessReport.Type;

/** `queued` and `observed` are progress reports; only `claimed` is a claim. */
export const HostClaimStage = Schema.Literals(["queued", "observed", "claimed"]);
export type HostClaimStage = typeof HostClaimStage.Type;

export const HostClaimAck = Schema.Struct({
  version: Version,
  kind: Kind("host_claim_ack"),
  ...TaskIdentityFields,
  ...ReceiverStampFields,
  stage: HostClaimStage,
  issuedAtMs: NonNegativeInt,
});
export type HostClaimAck = typeof HostClaimAck.Type;

export const HostTerminalOutcome = Schema.Literals([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "uncertain",
]);
export type HostTerminalOutcome = typeof HostTerminalOutcome.Type;

/** Receiver-authored terminal, cleanup, and fence evidence for one attempt. */
export const HostTerminalReport = Schema.Struct({
  version: Version,
  kind: Kind("host_terminal_report"),
  ...TaskIdentityFields,
  ...ReceiverStampFields,
  outcome: HostTerminalOutcome,
  cleanup: Schema.Literals(["verified", "pending", "unknown"]),
  /** Receiver rejects actions from attempts up to and including this number. */
  fencedThroughAttempt: NonNegativeInt,
  issuedAtMs: NonNegativeInt,
});
export type HostTerminalReport = typeof HostTerminalReport.Type;

/** `queued` and `received` are not durable; only `verified_durable` is an ACK. */
export const HostArtifactStage = Schema.Literals(["queued", "received", "verified_durable"]);
export type HostArtifactStage = typeof HostArtifactStage.Type;

/** Receiver's own measurement of the exact bytes it holds. */
export const HostArtifactReceipt = Schema.Struct({
  version: Version,
  kind: Kind("host_artifact_receipt"),
  ...TaskIdentityFields,
  ...ReceiverStampFields,
  artifactId: HostProtocolId,
  sha256: Sha256Hex,
  byteCount: NonNegativeInt,
  stage: HostArtifactStage,
  issuedAtMs: NonNegativeInt,
});
export type HostArtifactReceipt = typeof HostArtifactReceipt.Type;

// ---------------------------------------------------------------------------
// Separately trusted source-side facts
// ---------------------------------------------------------------------------

/**
 * The subset of the persisted `MissionExecutionAdmission` this protocol binds.
 * A full persisted admission decodes into it because extra keys are ignored
 * here only; everything else in this module is exact-key.
 */
export const HostProtocolAdmissionBinding = Schema.Struct({
  teamId: HostProtocolId,
  environmentId: HostProtocolId,
  missionId: HostProtocolId,
  taskId: HostProtocolId,
  attemptNumber: PositiveInt,
  requestDigest: Sha256Hex,
  hostId: HostProtocolId,
  bootId: HostProtocolId,
  hostEpoch: NonNegativeInt,
  accountId: HostProtocolId,
  billingMode: HostProtocolId,
  admittedAtMs: NonNegativeInt,
});
export type HostProtocolAdmissionBinding = typeof HostProtocolAdmissionBinding.Type;

/**
 * Receiver binding and capabilities the source established through its own
 * authenticated transport, independent of any message body.
 * `receiverHostId` is the host the transport authenticated as the author of
 * the messages under verification.
 */
export const HostTransportBinding = Schema.Struct({
  version: Version,
  kind: Kind("host_transport_binding"),
  authentication: Schema.Literals(["authenticated", "unauthenticated", "unknown"]),
  teamId: HostProtocolId,
  environmentId: HostProtocolId,
  company: HostProtocolId,
  sourceHostId: HostProtocolId,
  receiverHostId: HostProtocolId,
  ...ReceiverStampFields,
  /** Whether the transport can reject actions from a superseded attempt. */
  fencing: Schema.Literals(["enforced", "unsupported", "unknown"]),
  /** Whether the transport can durably acknowledge exact artifact identity. */
  durableAck: Schema.Literals(["durable", "volatile", "unknown"]),
  observedAtMs: NonNegativeInt,
});
export type HostTransportBinding = typeof HostTransportBinding.Type;

/** Source-known repository pin and hosts for a readiness check, before dispatch. */
export const HostReadinessExpectation = Schema.Struct({
  version: Version,
  kind: Kind("host_readiness_expectation"),
  sourceHostId: HostProtocolId,
  receiverHostId: HostProtocolId,
  projectId: HostProtocolId,
  sourceCommit: HostProtocolCommit,
});
export type HostReadinessExpectation = typeof HostReadinessExpectation.Type;

/** Source-known run binding for a dispatched attempt. */
export const HostTaskExpectation = Schema.Struct({
  version: Version,
  kind: Kind("host_task_expectation"),
  sourceHostId: HostProtocolId,
  receiverHostId: HostProtocolId,
  projectId: HostProtocolId,
  sourceCommit: HostProtocolCommit,
  commandId: HostProtocolId,
  runId: HostProtocolId,
  worktreeRef: HostLocalRef,
});
export type HostTaskExpectation = typeof HostTaskExpectation.Type;

/** Expected artifact the producing run committed to, before any transfer. */
export const HostArtifactManifest = Schema.Struct({
  version: Version,
  kind: Kind("host_artifact_manifest"),
  expectation: HostTaskExpectation,
  artifactId: HostProtocolId,
  sha256: Sha256Hex,
  byteCount: NonNegativeInt,
});
export type HostArtifactManifest = typeof HostArtifactManifest.Type;

/**
 * Shared account budget as the global ledger saw it. Account headroom is a
 * global fact: a host-scoped or unknown budget never counts, and unknown
 * headroom is never assumed healthy. Headroom values mirror `UsageHeadroom`.
 */
export const HostCapacityFacts = Schema.Struct({
  version: Version,
  kind: Kind("host_capacity"),
  accountId: HostProtocolId,
  billingMode: HostProtocolId,
  scope: Schema.Literals(["global", "host", "unknown"]),
  headroom: Schema.Literals(["ok", "low", "exhausted", "unknown"]),
  reservationId: Schema.NullOr(HostProtocolId),
  observedAtMs: NonNegativeInt,
});
export type HostCapacityFacts = typeof HostCapacityFacts.Type;

/** Source-observed liveness of the prior attempt. None of it proves a stop. */
export const HostAttemptStatus = Schema.Struct({
  version: Version,
  kind: Kind("host_attempt_status"),
  connection: Schema.Literals(["connected", "disconnected", "unknown"]),
  lease: Schema.Literals(["live", "expired", "unknown"]),
  cancel: Schema.Literals(["none", "requested", "acknowledged", "unknown"]),
  observedAtMs: NonNegativeInt,
});
export type HostAttemptStatus = typeof HostAttemptStatus.Type;

/** A previously stored durable artifact ACK, consulted for alias detection. */
export const HostArtifactAckRecord = Schema.Struct({
  artifactId: HostProtocolId,
  sha256: Sha256Hex,
  byteCount: NonNegativeInt,
  evidenceDigest: Sha256Hex,
});
export type HostArtifactAckRecord = typeof HostArtifactAckRecord.Type;

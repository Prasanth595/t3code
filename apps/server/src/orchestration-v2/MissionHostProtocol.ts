// @effect-diagnostics nodeBuiltinImport:off -- SHA-256 binds the exact verified ACK evidence identity.
import * as NodeCrypto from "node:crypto";

import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { MissionExecutionAdmission } from "../../../../packages/contracts/src/missionExecution.ts";
import {
  HOST_PROTOCOL_COMPANY,
  HostArtifactAckRecord,
  HostArtifactManifest,
  HostArtifactReceipt,
  HostAttemptStatus,
  HostCapacityFacts,
  HostClaimAck,
  HostProtocolAdmissionBinding,
  HostReadinessExpectation,
  HostReadinessReport,
  HostTaskExpectation,
  HostTerminalReport,
  HostTransportBinding,
  MAX_HOST_PROTOCOL_PRIOR_ACKS,
  type HostProtocolReasonCode,
} from "../../../../packages/contracts/src/missionHostProtocol.ts";

/**
 * Pure verifier for the two-host readiness / claim / artifact ACK evidence
 * (P4 source slice). It is dormant: future dispatch adapters call it; it
 * activates nothing, stores nothing, reads no clock, and touches no network
 * or filesystem. It invents no transport API.
 *
 * Trust boundary. Receiver messages are claims. They are checked against
 * facts the source established separately and injects here: the persisted
 * admission receipt, the expected manifest/expectation, and the
 * `HostTransportBinding` (what the source's own authenticated transport says
 * about the receiver). A string in a message that names a host, build, or
 * capability is never trusted on its own. A bridge event that was only saved
 * or queued is not a receiver observation, and a receiver observation is not
 * a claim: only a receiver-authored `claimed` / `verified_durable` message
 * that matches every bound fact is accepted. Missing or unknown facts yield a
 * hold, never readiness.
 *
 * Every public function takes `unknown` data, decodes it into fresh detached
 * objects with exact keys, returns a deeply frozen decision, and never
 * throws. Reasons are a finite code set returned in a fixed order.
 */

/** Longest evidence age accepted; a caller may only tighten it. */
export const HOST_PROTOCOL_MAX_EVIDENCE_AGE_MS = 5 * 60_000;
/** Largest forward clock skew tolerated between the receiver's clock and ours. */
export const HOST_PROTOCOL_MAX_CLOCK_SKEW_MS = 30_000;

type Severity = "hold" | "quarantine" | "denied";

/**
 * Severity per reason, and (by key order) the stable order reasons are
 * reported in. `quarantine` reasons only quarantine artifact receipts; every
 * other verification reports them as a hold.
 */
const REASON_SEVERITY: Readonly<Record<HostProtocolReasonCode, Severity>> = {
  clock_invalid: "hold",
  admission_malformed: "hold",
  binding_malformed: "hold",
  expectation_malformed: "hold",
  capacity_malformed: "hold",
  status_malformed: "hold",
  message_malformed: "hold",
  prior_malformed: "hold",
  transport_unauthenticated: "hold",
  binding_stale: "hold",
  evidence_from_future: "hold",
  verifier_fault: "hold",
  company_denied: "denied",
  team_mismatch: "denied",
  environment_mismatch: "denied",
  mission_mismatch: "quarantine",
  task_mismatch: "quarantine",
  attempt_mismatch: "quarantine",
  admission_mismatch: "quarantine",
  command_mismatch: "quarantine",
  run_mismatch: "quarantine",
  source_host_mismatch: "quarantine",
  receiver_host_mismatch: "quarantine",
  admitted_host_mismatch: "hold",
  receiver_boot_mismatch: "hold",
  epoch_mismatch: "hold",
  repository_mismatch: "quarantine",
  worktree_mismatch: "quarantine",
  commit_mismatch: "quarantine",
  runtime_build_mismatch: "hold",
  capability_mismatch: "hold",
  receiver_ack_missing: "hold",
  queued_only: "hold",
  observed_not_claimed: "hold",
  received_not_durable: "hold",
  ack_stale: "hold",
  evidence_stale: "hold",
  evidence_predates_admission: "hold",
  durable_ack_unsupported: "hold",
  durable_ack_unknown: "hold",
  build_not_ok: "hold",
  toolchain_not_ok: "hold",
  pressure_unacceptable: "hold",
  pressure_unknown: "hold",
  no_heavy_build_slot: "hold",
  account_mismatch: "hold",
  account_budget_not_global: "hold",
  account_reservation_missing: "hold",
  account_headroom_low: "hold",
  account_headroom_exhausted: "hold",
  account_headroom_unknown: "hold",
  artifact_id_mismatch: "quarantine",
  artifact_hash_mismatch: "quarantine",
  artifact_size_mismatch: "quarantine",
  artifact_alias_conflict: "denied",
  disconnected_not_stopped: "hold",
  connection_unknown: "hold",
  lease_expired_not_stopped: "hold",
  lease_unknown: "hold",
  cancel_requested_not_stopped: "hold",
  cancel_acknowledged_not_terminal: "hold",
  cancel_unknown: "hold",
  terminal_missing: "hold",
  terminal_outcome_uncertain: "hold",
  attempt_completed: "hold",
  cleanup_unproven: "hold",
  fencing_unsupported: "hold",
  fencing_unknown: "hold",
  fence_generation_behind: "hold",
};

const REASON_ORDER: ReadonlyMap<HostProtocolReasonCode, number> = new Map(
  (Object.keys(REASON_SEVERITY) as HostProtocolReasonCode[]).map((code, index) => [code, index]),
);

type Reasons = Set<HostProtocolReasonCode>;
type NonEmptyReasons = readonly [HostProtocolReasonCode, ...HostProtocolReasonCode[]];

interface Accepted<S extends string, D extends string> {
  readonly subject: S;
  readonly decision: D;
  readonly reasons: readonly [];
  /** SHA-256 over the verified identity; time-independent so duplicates match. */
  readonly evidenceDigest: string;
}
interface Rejected<S extends string, D extends string> {
  readonly subject: S;
  readonly decision: D;
  readonly reasons: NonEmptyReasons;
  readonly evidenceDigest: null;
}

export type HostReadinessDecision =
  | Accepted<"host_readiness", "ready">
  | Rejected<"host_readiness", "hold" | "denied">;
export type HostClaimDecision =
  | Accepted<"host_claim_ack", "claim_acknowledged">
  | Rejected<"host_claim_ack", "hold" | "denied">;
export type HostArtifactDecision =
  | Accepted<"host_artifact_receipt", "delivery_acknowledged">
  | Rejected<"host_artifact_receipt", "hold" | "quarantine" | "denied">;
export type HostRetryDecision =
  | Accepted<"host_retry_gate", "automatic_retry_permitted">
  | Rejected<"host_retry_gate", "hold" | "denied">;

interface Common {
  /** Persisted admission receipt (extra keys ignored; see `hostProtocolAdmissionBinding`). */
  readonly admission: unknown;
  /** Separately trusted authenticated transport binding and receiver capabilities. */
  readonly binding: unknown;
  /** Caller-supplied clock. The verifier never reads one. */
  readonly nowMs: number;
  /** Optional tighter evidence age; never looser than the module maximum. */
  readonly maxAgeMs?: number | undefined;
}
export interface HostReadinessInput extends Common {
  readonly expected: unknown;
  /** Shared account ledger fact for this admission's account. */
  readonly capacity: unknown;
  readonly report: unknown;
}
export interface HostClaimInput extends Common {
  readonly expected: unknown;
  readonly ack: unknown;
}
export interface HostArtifactInput extends Common {
  readonly manifest: unknown;
  readonly receipt: unknown;
  /** Previously stored durable ACK records; defaults to none. */
  readonly priorAcks?: unknown;
}
export interface HostRetryInput extends Common {
  readonly expected: unknown;
  readonly status: unknown;
  readonly terminal: unknown;
}

/** Picks the protocol-bound fields from a persisted admission receipt. */
export const hostProtocolAdmissionBinding = (
  admission: MissionExecutionAdmission,
): HostProtocolAdmissionBinding => ({
  teamId: admission.teamId,
  environmentId: admission.environmentId,
  missionId: admission.missionId,
  taskId: admission.taskId,
  attemptNumber: admission.attemptNumber,
  requestDigest: admission.requestDigest,
  hostId: admission.hostId,
  bootId: admission.bootId,
  hostEpoch: admission.hostEpoch,
  accountId: admission.accountId,
  billingMode: admission.billingMode,
  admittedAtMs: admission.admittedAtMs,
});

// ---------------------------------------------------------------------------
// Decoding, clock, and decision plumbing
// ---------------------------------------------------------------------------

type DecoderSchema = Parameters<typeof Schema.decodeUnknownOption>[0];

/** Decodes into a fresh detached value; undefined on any failure, never throws. */
const decoder = <S extends DecoderSchema>(
  schema: S,
  onExcessProperty: "error" | "ignore" = "error",
) => {
  const decode = Schema.decodeUnknownOption(schema, { onExcessProperty });
  return (input: unknown): S["Type"] | undefined => {
    try {
      const result = decode(input);
      return Option.isSome(result) ? result.value : undefined;
    } catch {
      return undefined;
    }
  };
};

const decodeAdmission = decoder(HostProtocolAdmissionBinding, "ignore");
const decodeBinding = decoder(HostTransportBinding);
const decodeReadinessExpectation = decoder(HostReadinessExpectation);
const decodeTaskExpectation = decoder(HostTaskExpectation);
const decodeManifest = decoder(HostArtifactManifest);
const decodeCapacity = decoder(HostCapacityFacts);
const decodeStatus = decoder(HostAttemptStatus);
const decodeReport = decoder(HostReadinessReport);
const decodeClaimAck = decoder(HostClaimAck);
const decodeTerminal = decoder(HostTerminalReport);
const decodeReceipt = decoder(HostArtifactReceipt);
const decodePriorAck = decoder(HostArtifactAckRecord);

interface Clock {
  readonly nowMs: number;
  readonly maxAgeMs: number;
}

const readClock = (nowMs: unknown, maxAgeMs: unknown): Clock | undefined => {
  if (typeof nowMs !== "number" || !Number.isSafeInteger(nowMs) || nowMs < 0) return undefined;
  if (maxAgeMs === undefined) return { nowMs, maxAgeMs: HOST_PROTOCOL_MAX_EVIDENCE_AGE_MS };
  if (typeof maxAgeMs !== "number" || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    return undefined;
  }
  return { nowMs, maxAgeMs: Math.min(maxAgeMs, HOST_PROTOCOL_MAX_EVIDENCE_AGE_MS) };
};

const checkFreshness = (
  reasons: Reasons,
  clock: Clock,
  observedAtMs: number,
  staleCode: "binding_stale" | "evidence_stale" | "ack_stale",
): void => {
  if (observedAtMs > clock.nowMs + HOST_PROTOCOL_MAX_CLOCK_SKEW_MS) {
    reasons.add("evidence_from_future");
  } else if (clock.nowMs - observedAtMs > clock.maxAgeMs) {
    reasons.add(staleCode);
  }
};

const isPresent = (value: unknown): boolean => value !== undefined && value !== null;

const sortedReasons = (reasons: ReadonlySet<HostProtocolReasonCode>): NonEmptyReasons => {
  const ordered = [...reasons].sort(
    (left, right) => (REASON_ORDER.get(left) ?? 0) - (REASON_ORDER.get(right) ?? 0),
  );
  const [first, ...rest] = ordered;
  return first === undefined ? ["verifier_fault"] : [first, ...rest];
};

const severityOf = (reasons: NonEmptyReasons, quarantineAllowed: boolean): Severity => {
  let result: Severity = "hold";
  for (const reason of reasons) {
    const severity = REASON_SEVERITY[reason];
    if (severity === "denied") return "denied";
    if (severity === "quarantine" && quarantineAllowed) result = "quarantine";
  }
  return result;
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
};

const digestOf = (preimage: unknown): string =>
  NodeCrypto.createHash("sha256").update(stableStringify(preimage)).digest("hex");

const rejected = <S extends string, D extends string>(
  subject: S,
  reasons: ReadonlySet<HostProtocolReasonCode>,
  quarantineAllowed: boolean,
): Rejected<S, D> => {
  const ordered = sortedReasons(reasons);
  return deepFreeze({
    subject,
    decision: severityOf(ordered, quarantineAllowed) as D,
    reasons: ordered,
    evidenceDigest: null,
  });
};

const accepted = <S extends string, D extends string>(
  subject: S,
  decision: D,
  preimage: unknown,
): Accepted<S, D> =>
  deepFreeze({ subject, decision, reasons: [] as const, evidenceDigest: digestOf(preimage) });

const faulted = <S extends string, D extends string>(subject: S): Rejected<S, D> =>
  deepFreeze({
    subject,
    decision: "hold" as D,
    reasons: ["verifier_fault"] as const,
    evidenceDigest: null,
  });

// ---------------------------------------------------------------------------
// Shared trust and identity checks
// ---------------------------------------------------------------------------

interface Trust {
  readonly clock: Clock;
  readonly admission: HostProtocolAdmissionBinding;
  readonly binding: HostTransportBinding;
}

/**
 * Establishes the injected trust. Authentication, company, and tenancy are
 * checked against the binding here; a binding that is not currently
 * `authenticated` and fresh can never support an acknowledgment.
 */
const establishTrust = (input: Common, reasons: Reasons): Trust | undefined => {
  const clock = readClock(input.nowMs, input.maxAgeMs);
  if (clock === undefined) reasons.add("clock_invalid");
  const admission = decodeAdmission(input.admission);
  if (admission === undefined) reasons.add("admission_malformed");
  const binding = decodeBinding(input.binding);
  if (binding === undefined) reasons.add("binding_malformed");
  if (clock === undefined || admission === undefined || binding === undefined) return undefined;

  if (binding.authentication !== "authenticated") reasons.add("transport_unauthenticated");
  if (binding.company !== HOST_PROTOCOL_COMPANY) reasons.add("company_denied");
  if (binding.teamId !== admission.teamId) reasons.add("team_mismatch");
  if (binding.environmentId !== admission.environmentId) reasons.add("environment_mismatch");
  checkFreshness(reasons, clock, binding.observedAtMs, "binding_stale");
  return { clock, admission, binding };
};

interface Hosts {
  readonly sourceHostId: string;
  readonly receiverHostId: string;
}

/**
 * The expected hosts must agree with the authenticated binding, and the host
 * the admission chose must be the executing side. For claims, readiness, and
 * terminal evidence the receiver executes; for artifacts the source produced.
 */
const checkHosts = (
  reasons: Reasons,
  trust: Trust,
  expected: Hosts,
  executing: "receiver" | "source",
): void => {
  const { admission, binding } = trust;
  if (binding.sourceHostId !== expected.sourceHostId) reasons.add("source_host_mismatch");
  if (binding.receiverHostId !== expected.receiverHostId) reasons.add("receiver_host_mismatch");
  const executingHostId =
    executing === "receiver" ? expected.receiverHostId : expected.sourceHostId;
  if (admission.hostId !== executingHostId) reasons.add("admitted_host_mismatch");
  if (executing === "receiver" && binding.receiverBootId !== admission.bootId) {
    reasons.add("receiver_boot_mismatch");
  }
};

type PostClaimMessage = HostClaimAck | HostTerminalReport | HostArtifactReceipt;

/** Compares a decoded receiver message with every independently trusted fact. */
const checkMessageIdentity = (
  reasons: Reasons,
  trust: Trust,
  expected: HostTaskExpectation,
  message: PostClaimMessage,
): void => {
  const { admission, binding } = trust;
  if (message.teamId !== admission.teamId) reasons.add("team_mismatch");
  if (message.environmentId !== admission.environmentId) reasons.add("environment_mismatch");
  if (message.company !== HOST_PROTOCOL_COMPANY) reasons.add("company_denied");
  if (message.missionId !== admission.missionId) reasons.add("mission_mismatch");
  if (message.taskId !== admission.taskId) reasons.add("task_mismatch");
  if (message.attemptNumber !== admission.attemptNumber) reasons.add("attempt_mismatch");
  if (message.admissionDigest !== admission.requestDigest) reasons.add("admission_mismatch");
  if (message.commandId !== expected.commandId) reasons.add("command_mismatch");
  if (message.runId !== expected.runId) reasons.add("run_mismatch");
  if (message.sourceHostId !== expected.sourceHostId) reasons.add("source_host_mismatch");
  if (message.receiverHostId !== expected.receiverHostId) reasons.add("receiver_host_mismatch");
  if (message.controllerEpoch !== admission.hostEpoch) reasons.add("epoch_mismatch");
  if (message.projectId !== expected.projectId) reasons.add("repository_mismatch");
  if (message.worktreeRef !== expected.worktreeRef) reasons.add("worktree_mismatch");
  if (message.sourceCommit !== expected.sourceCommit) reasons.add("commit_mismatch");
  if (message.receiverBootId !== binding.receiverBootId) reasons.add("receiver_boot_mismatch");
  if (message.runtimeBuildId !== binding.runtimeBuildId) reasons.add("runtime_build_mismatch");
  if (message.capabilityHash !== binding.capabilityHash) reasons.add("capability_mismatch");
};

/** Freshness of an issued message, and whether it could even answer this admission. */
const checkMessageTime = (
  reasons: Reasons,
  trust: Trust,
  issuedAtMs: number,
  staleCode: "ack_stale" | null,
): void => {
  if (staleCode !== null) checkFreshness(reasons, trust.clock, issuedAtMs, staleCode);
  else if (issuedAtMs > trust.clock.nowMs + HOST_PROTOCOL_MAX_CLOCK_SKEW_MS) {
    reasons.add("evidence_from_future");
  }
  if (issuedAtMs + HOST_PROTOCOL_MAX_CLOCK_SKEW_MS < trust.admission.admittedAtMs) {
    reasons.add("evidence_predates_admission");
  }
};

/** Time-independent identity preimage shared by every accepted digest. */
const identityPreimage = (
  trust: Trust,
  expected: HostTaskExpectation | HostReadinessExpectation,
) => ({
  admissionDigest: trust.admission.requestDigest,
  attemptNumber: trust.admission.attemptNumber,
  capabilityHash: trust.binding.capabilityHash,
  company: trust.binding.company,
  controllerEpoch: trust.admission.hostEpoch,
  environmentId: trust.admission.environmentId,
  missionId: trust.admission.missionId,
  projectId: expected.projectId,
  receiverBootId: trust.binding.receiverBootId,
  receiverHostId: expected.receiverHostId,
  runtimeBuildId: trust.binding.runtimeBuildId,
  sourceCommit: expected.sourceCommit,
  sourceHostId: expected.sourceHostId,
  taskId: trust.admission.taskId,
  teamId: trust.admission.teamId,
});

// ---------------------------------------------------------------------------
// Host readiness (before dispatch)
// ---------------------------------------------------------------------------

/**
 * Is the candidate executing host ready for this admission? Host readiness
 * signals and local build slots come from the authenticated receiver; the
 * account budget comes from the global ledger. Unknown telemetry, unknown
 * headroom, and an unreserved or host-scoped budget are holds, never ready.
 */
export const verifyHostReadiness = (input: HostReadinessInput): HostReadinessDecision => {
  try {
    const reasons: Reasons = new Set();
    const trust = establishTrust(input, reasons);
    const expected = decodeReadinessExpectation(input.expected);
    if (expected === undefined) reasons.add("expectation_malformed");
    const capacity = decodeCapacity(input.capacity);
    if (capacity === undefined) reasons.add("capacity_malformed");
    const report = decodeReport(input.report);
    if (report === undefined) {
      reasons.add(isPresent(input.report) ? "message_malformed" : "receiver_ack_missing");
    }

    if (
      trust !== undefined &&
      expected !== undefined &&
      capacity !== undefined &&
      report !== undefined
    ) {
      const { admission, binding, clock } = trust;
      checkHosts(reasons, trust, expected, "receiver");
      if (report.teamId !== admission.teamId) reasons.add("team_mismatch");
      if (report.environmentId !== admission.environmentId) reasons.add("environment_mismatch");
      if (report.company !== HOST_PROTOCOL_COMPANY) reasons.add("company_denied");
      if (report.controllerEpoch !== admission.hostEpoch) reasons.add("epoch_mismatch");
      if (report.receiverHostId !== expected.receiverHostId) reasons.add("receiver_host_mismatch");
      if (report.receiverBootId !== binding.receiverBootId) reasons.add("receiver_boot_mismatch");
      if (report.runtimeBuildId !== binding.runtimeBuildId) reasons.add("runtime_build_mismatch");
      if (report.capabilityHash !== binding.capabilityHash) reasons.add("capability_mismatch");
      if (report.projectId !== expected.projectId) reasons.add("repository_mismatch");
      if (report.sourceCommit !== expected.sourceCommit) reasons.add("commit_mismatch");
      checkFreshness(reasons, clock, report.observedAtMs, "evidence_stale");

      if (!report.buildOk) reasons.add("build_not_ok");
      if (!report.toolchainOk) reasons.add("toolchain_not_ok");
      if (report.pressure === "unknown") reasons.add("pressure_unknown");
      else if (report.pressure !== "acceptable") reasons.add("pressure_unacceptable");
      if (report.heavyBuildSlotsFree < 1) reasons.add("no_heavy_build_slot");

      if (
        capacity.accountId !== admission.accountId ||
        capacity.billingMode !== admission.billingMode
      ) {
        reasons.add("account_mismatch");
      }
      if (capacity.scope !== "global") reasons.add("account_budget_not_global");
      if (capacity.reservationId === null) reasons.add("account_reservation_missing");
      if (capacity.headroom === "low") reasons.add("account_headroom_low");
      else if (capacity.headroom === "exhausted") reasons.add("account_headroom_exhausted");
      else if (capacity.headroom === "unknown") reasons.add("account_headroom_unknown");
      checkFreshness(reasons, clock, capacity.observedAtMs, "evidence_stale");
    }

    if (
      reasons.size === 0 &&
      trust !== undefined &&
      expected !== undefined &&
      capacity !== undefined
    ) {
      return accepted("host_readiness", "ready", {
        ...identityPreimage(trust, expected),
        accountId: capacity.accountId,
        reservationId: capacity.reservationId,
        subject: "host_readiness",
      });
    }
    return rejected<"host_readiness", "hold" | "denied">("host_readiness", reasons, false);
  } catch {
    return faulted<"host_readiness", "hold">("host_readiness");
  }
};

// ---------------------------------------------------------------------------
// Claim ACK
// ---------------------------------------------------------------------------

/**
 * Did the authenticated receiver claim exactly this admitted attempt? A queued
 * or merely observed report, a missing report, a stale one, or any identity,
 * epoch, build, or capability difference holds. Only a matching `claimed`
 * report is acknowledged.
 */
export const verifyHostClaimAck = (input: HostClaimInput): HostClaimDecision => {
  try {
    const reasons: Reasons = new Set();
    const trust = establishTrust(input, reasons);
    const expected = decodeTaskExpectation(input.expected);
    if (expected === undefined) reasons.add("expectation_malformed");
    const ack = decodeClaimAck(input.ack);
    if (ack === undefined) {
      reasons.add(isPresent(input.ack) ? "message_malformed" : "receiver_ack_missing");
    }

    if (trust !== undefined && expected !== undefined) {
      checkHosts(reasons, trust, expected, "receiver");
      if (ack !== undefined) {
        checkMessageIdentity(reasons, trust, expected, ack);
        checkMessageTime(reasons, trust, ack.issuedAtMs, "ack_stale");
        if (ack.stage === "queued") reasons.add("queued_only");
        else if (ack.stage === "observed") reasons.add("observed_not_claimed");
      }
    }

    if (reasons.size === 0 && trust !== undefined && expected !== undefined) {
      return accepted("host_claim_ack", "claim_acknowledged", {
        ...identityPreimage(trust, expected),
        commandId: expected.commandId,
        runId: expected.runId,
        subject: "host_claim_ack",
        worktreeRef: expected.worktreeRef,
      });
    }
    return rejected<"host_claim_ack", "hold" | "denied">("host_claim_ack", reasons, false);
  } catch {
    return faulted<"host_claim_ack", "hold">("host_claim_ack");
  }
};

// ---------------------------------------------------------------------------
// Artifact receipt
// ---------------------------------------------------------------------------

/**
 * Compares the receiver's own measurement of the bytes it holds against the
 * producing run's manifest. Wrong hash, size, id, or any bound identity is
 * quarantined; the wrong company or a different-bytes alias of an already
 * acknowledged id is denied; a non-durable stage or non-durable transport
 * holds. Only an exact `verified_durable` receipt over a durable-capable
 * authenticated transport is acknowledged, and an exact duplicate yields the
 * identical decision.
 */
export const verifyHostArtifactReceipt = (input: HostArtifactInput): HostArtifactDecision => {
  try {
    const reasons: Reasons = new Set();
    const trust = establishTrust(input, reasons);
    const manifest = decodeManifest(input.manifest);
    if (manifest === undefined) reasons.add("expectation_malformed");
    const receipt = decodeReceipt(input.receipt);
    if (receipt === undefined) {
      reasons.add(isPresent(input.receipt) ? "message_malformed" : "receiver_ack_missing");
    }

    const rawPriors = input.priorAcks ?? [];
    const priorAcks =
      Array.isArray(rawPriors) && rawPriors.length <= MAX_HOST_PROTOCOL_PRIOR_ACKS
        ? rawPriors.map((entry) => decodePriorAck(entry))
        : undefined;
    if (priorAcks === undefined || priorAcks.some((entry) => entry === undefined)) {
      reasons.add("prior_malformed");
    }

    if (trust !== undefined && manifest !== undefined) {
      const { expectation } = manifest;
      checkHosts(reasons, trust, expectation, "source");
      if (trust.binding.durableAck === "volatile") reasons.add("durable_ack_unsupported");
      else if (trust.binding.durableAck === "unknown") reasons.add("durable_ack_unknown");

      for (const prior of priorAcks ?? []) {
        if (
          prior !== undefined &&
          prior.artifactId === manifest.artifactId &&
          (prior.sha256 !== manifest.sha256 || prior.byteCount !== manifest.byteCount)
        ) {
          reasons.add("artifact_alias_conflict");
        }
      }

      if (receipt !== undefined) {
        checkMessageIdentity(reasons, trust, expectation, receipt);
        checkMessageTime(reasons, trust, receipt.issuedAtMs, "ack_stale");
        if (receipt.artifactId !== manifest.artifactId) reasons.add("artifact_id_mismatch");
        if (receipt.sha256 !== manifest.sha256) reasons.add("artifact_hash_mismatch");
        if (receipt.byteCount !== manifest.byteCount) reasons.add("artifact_size_mismatch");
        if (receipt.stage === "queued") reasons.add("queued_only");
        else if (receipt.stage === "received") reasons.add("received_not_durable");
      }
    }

    if (reasons.size === 0 && trust !== undefined && manifest !== undefined) {
      const decision = accepted("host_artifact_receipt", "delivery_acknowledged", {
        ...identityPreimage(trust, manifest.expectation),
        artifactId: manifest.artifactId,
        byteCount: manifest.byteCount,
        commandId: manifest.expectation.commandId,
        runId: manifest.expectation.runId,
        sha256: manifest.sha256,
        subject: "host_artifact_receipt",
        worktreeRef: manifest.expectation.worktreeRef,
      });
      // Artifact identity is bound to the entire producing run and receiver,
      // not just its bytes. A prior ACK cannot be retargeted to another run.
      if (
        priorAcks?.some(
          (prior) =>
            prior !== undefined &&
            prior.artifactId === manifest.artifactId &&
            prior.evidenceDigest !== decision.evidenceDigest,
        )
      ) {
        reasons.add("artifact_alias_conflict");
        return rejected<"host_artifact_receipt", "denied">("host_artifact_receipt", reasons, true);
      }
      return decision;
    }
    return rejected<"host_artifact_receipt", "hold" | "quarantine" | "denied">(
      "host_artifact_receipt",
      reasons,
      true,
    );
  } catch {
    return faulted<"host_artifact_receipt", "hold">("host_artifact_receipt");
  }
};

// ---------------------------------------------------------------------------
// Automatic conflicting retry
// ---------------------------------------------------------------------------

/**
 * May a conflicting retry start automatically? Disconnect, lease expiry, and
 * cancellation requests or acknowledgments do not prove the old attempt
 * stopped, so none of them permits it. Only authenticated receiver terminal
 * evidence that exactly matches the attempt, with verified cleanup, over a
 * transport that enforces fencing through that attempt, permits it. Unknown
 * or unsupported fencing blocks it.
 */
export const decideHostAutomaticRetry = (input: HostRetryInput): HostRetryDecision => {
  try {
    const reasons: Reasons = new Set();
    const trust = establishTrust(input, reasons);
    const expected = decodeTaskExpectation(input.expected);
    if (expected === undefined) reasons.add("expectation_malformed");
    const status = decodeStatus(input.status);
    if (status === undefined) reasons.add("status_malformed");
    const terminal = decodeTerminal(input.terminal);
    const stopped: Reasons = new Set();
    if (terminal === undefined) {
      stopped.add(isPresent(input.terminal) ? "message_malformed" : "terminal_missing");
    }

    if (trust !== undefined && expected !== undefined) {
      checkHosts(reasons, trust, expected, "receiver");
      if (status !== undefined)
        checkFreshness(reasons, trust.clock, status.observedAtMs, "evidence_stale");

      if (terminal !== undefined) {
        checkMessageIdentity(stopped, trust, expected, terminal);
        checkMessageTime(stopped, trust, terminal.issuedAtMs, null);
        if (terminal.outcome === "uncertain") stopped.add("terminal_outcome_uncertain");
        else if (terminal.outcome === "completed") stopped.add("attempt_completed");
        if (terminal.cleanup !== "verified") stopped.add("cleanup_unproven");
        if (trust.binding.fencing === "unsupported") stopped.add("fencing_unsupported");
        else if (trust.binding.fencing === "unknown") stopped.add("fencing_unknown");
        else if (terminal.fencedThroughAttempt < trust.admission.attemptNumber) {
          stopped.add("fence_generation_behind");
        }
      }
    }

    if (
      reasons.size === 0 &&
      stopped.size === 0 &&
      trust !== undefined &&
      expected !== undefined &&
      terminal !== undefined
    ) {
      return accepted("host_retry_gate", "automatic_retry_permitted", {
        ...identityPreimage(trust, expected),
        cleanup: terminal.cleanup,
        commandId: expected.commandId,
        fencedThroughAttempt: terminal.fencedThroughAttempt,
        outcome: terminal.outcome,
        runId: expected.runId,
        subject: "host_retry_gate",
        worktreeRef: expected.worktreeRef,
      });
    }

    // Liveness explains the hold; it never contributes to a permission.
    const holding: Reasons = new Set([...reasons, ...stopped]);
    if (status !== undefined) {
      if (status.connection === "disconnected") holding.add("disconnected_not_stopped");
      else if (status.connection === "unknown") holding.add("connection_unknown");
      if (status.lease === "expired") holding.add("lease_expired_not_stopped");
      else if (status.lease === "unknown") holding.add("lease_unknown");
      if (status.cancel === "requested") holding.add("cancel_requested_not_stopped");
      else if (status.cancel === "acknowledged") holding.add("cancel_acknowledged_not_terminal");
      else if (status.cancel === "unknown") holding.add("cancel_unknown");
    }
    return rejected<"host_retry_gate", "hold" | "denied">("host_retry_gate", holding, false);
  } catch {
    return faulted<"host_retry_gate", "hold">("host_retry_gate");
  }
};

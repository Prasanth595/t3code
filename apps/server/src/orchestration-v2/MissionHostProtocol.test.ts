// @effect-diagnostics nodeBuiltinImport:off -- real SHA-256 bytes make the artifact fixture honest.
import * as NodeCrypto from "node:crypto";

import { describe, expect, it, vi } from "@effect/vitest";
import * as Schema from "effect/Schema";

import type { MissionExecutionAdmission } from "../../../../packages/contracts/src/missionExecution.ts";
import {
  HostProtocolReasonCode,
  MAX_HOST_PROTOCOL_ID_LENGTH,
  MAX_HOST_PROTOCOL_PRIOR_ACKS,
} from "../../../../packages/contracts/src/missionHostProtocol.ts";
import {
  decideHostAutomaticRetry,
  HOST_PROTOCOL_MAX_CLOCK_SKEW_MS,
  HOST_PROTOCOL_MAX_EVIDENCE_AGE_MS,
  hostProtocolAdmissionBinding,
  verifyHostArtifactReceipt,
  verifyHostClaimAck,
  verifyHostReadiness,
} from "./MissionHostProtocol.ts";

/**
 * TRUST BOUNDARY OF THESE FIXTURES. Every `binding` below is an injected,
 * hand-built stand-in for what a future dispatch adapter would establish from
 * its own authenticated transport. Nothing here talks to a bridge, relay, or
 * second host, so a passing positive case proves only that the pure verifier
 * accepts a fully matching set of trusted facts. It is NOT evidence of live
 * M1 or two-host transport, authentication, fencing, or durable ACK.
 */

const NOW = 1_800_000_000_000;
const COMMIT = "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d";
const OTHER_COMMIT = "9ea47e981ba21be719e4f54fcf4ab3530df421a2";
const hex = (char: string): string => char.repeat(64);
const sha256 = (text: string): string => NodeCrypto.createHash("sha256").update(text).digest("hex");

const ARTIFACT_BYTES = "build output bytes, exactly these";
const ARTIFACT_SHA = sha256(ARTIFACT_BYTES);
const ARTIFACT_SIZE = Buffer.byteLength(ARTIFACT_BYTES);

type Json = Record<string, unknown>;
const merge = (base: Json, patch: Json): Json => ({ ...base, ...patch });

/** Persisted admission (extra keys included): the executing host is host-m1. */
const persistedAdmission = (patch: Json = {}): Json =>
  merge(
    {
      dispatchKey:
        '["mission-admission","team-nofun","env-authority","mission-1","task-a",2,"write"]',
      teamId: "team-nofun",
      environmentId: "env-authority",
      missionId: "mission-1",
      taskId: "task-a",
      attemptNumber: 2,
      operation: "write",
      requestDigest: hex("1"),
      admittedAtMs: NOW - 3_600_000,
      chosenRoute: { providerInstanceId: "muse-personal", modelId: "spark", profile: "writer" },
      rejectedRoutes: [],
      accountVerifiedAtMs: NOW - 61_000,
      hostObservedAtMs: NOW - 61_000,
      repositoryObservedAtMs: NOW - 61_000,
      accountId: "acct-muse-1",
      billingMode: "subscription",
      hostId: "host-m1",
      bootId: "boot-m1-7",
      hostThreadId: "thread-delivery",
      hostEpoch: 4,
      unknownUsageException: false,
      unknownUsageExceptionId: null,
      exceptionConsumptionRef: null,
    },
    patch,
  );

const baseBinding = (patch: Json = {}): Json =>
  merge(
    {
      version: 1,
      kind: "host_transport_binding",
      authentication: "authenticated",
      teamId: "team-nofun",
      environmentId: "env-authority",
      company: "No Fun",
      sourceHostId: "host-m5",
      receiverHostId: "host-m1",
      receiverBootId: "boot-m1-7",
      runtimeBuildId: "build-2026.10.14+abc",
      capabilityHash: hex("c"),
      fencing: "enforced",
      durableAck: "durable",
      observedAtMs: NOW - 10_000,
    },
    patch,
  );

const readinessExpectation = (patch: Json = {}): Json =>
  merge(
    {
      version: 1,
      kind: "host_readiness_expectation",
      sourceHostId: "host-m5",
      receiverHostId: "host-m1",
      projectId: "project-1",
      sourceCommit: COMMIT,
    },
    patch,
  );

const taskExpectation = (patch: Json = {}): Json =>
  merge(
    {
      version: 1,
      kind: "host_task_expectation",
      sourceHostId: "host-m5",
      receiverHostId: "host-m1",
      projectId: "project-1",
      sourceCommit: COMMIT,
      commandId: "command-9",
      runId: "run-3",
      worktreeRef: "worktree-handle-12",
    },
    patch,
  );

const capacity = (patch: Json = {}): Json =>
  merge(
    {
      version: 1,
      kind: "host_capacity",
      accountId: "acct-muse-1",
      billingMode: "subscription",
      scope: "global",
      headroom: "ok",
      reservationId: "reservation-1",
      observedAtMs: NOW - 5_000,
    },
    patch,
  );

const readinessReport = (patch: Json = {}): Json =>
  merge(
    {
      version: 1,
      kind: "host_readiness",
      teamId: "team-nofun",
      environmentId: "env-authority",
      company: "No Fun",
      controllerEpoch: 4,
      receiverHostId: "host-m1",
      receiverBootId: "boot-m1-7",
      runtimeBuildId: "build-2026.10.14+abc",
      capabilityHash: hex("c"),
      projectId: "project-1",
      sourceCommit: COMMIT,
      buildOk: true,
      toolchainOk: true,
      pressure: "acceptable",
      heavyBuildSlotsFree: 1,
      observedAtMs: NOW - 5_000,
    },
    patch,
  );

const identityFields = (patch: Json = {}): Json =>
  merge(
    {
      version: 1,
      teamId: "team-nofun",
      environmentId: "env-authority",
      company: "No Fun",
      missionId: "mission-1",
      taskId: "task-a",
      attemptNumber: 2,
      admissionDigest: hex("1"),
      commandId: "command-9",
      runId: "run-3",
      sourceHostId: "host-m5",
      receiverHostId: "host-m1",
      controllerEpoch: 4,
      projectId: "project-1",
      worktreeRef: "worktree-handle-12",
      sourceCommit: COMMIT,
      receiverBootId: "boot-m1-7",
      runtimeBuildId: "build-2026.10.14+abc",
      capabilityHash: hex("c"),
    },
    patch,
  );

const claimAck = (patch: Json = {}): Json =>
  merge(
    { kind: "host_claim_ack", stage: "claimed", issuedAtMs: NOW - 4_000 },
    merge(identityFields(), patch),
  );

const claimInput = (patch: Json = {}) => ({
  admission: persistedAdmission(),
  binding: baseBinding(),
  expected: taskExpectation(),
  ack: claimAck(),
  nowMs: NOW,
  ...patch,
});

const readinessInput = (patch: Json = {}) => ({
  admission: persistedAdmission(),
  binding: baseBinding(),
  expected: readinessExpectation(),
  capacity: capacity(),
  report: readinessReport(),
  nowMs: NOW,
  ...patch,
});

/**
 * Artifact flow: host-m1 (admitted executor) produced the bytes and host-m5
 * is the consumer, so the binding authenticates host-m5 and its own boot.
 */
const artifactExpectation = (patch: Json = {}): Json =>
  taskExpectation({ sourceHostId: "host-m1", receiverHostId: "host-m5", ...patch });

const manifest = (patch: Json = {}, expectationPatch: Json = {}): Json =>
  merge(
    {
      version: 1,
      kind: "host_artifact_manifest",
      expectation: artifactExpectation(expectationPatch),
      artifactId: "artifact-77",
      sha256: ARTIFACT_SHA,
      byteCount: ARTIFACT_SIZE,
    },
    patch,
  );

const artifactBinding = (patch: Json = {}): Json =>
  baseBinding({
    sourceHostId: "host-m1",
    receiverHostId: "host-m5",
    receiverBootId: "boot-m5-3",
    runtimeBuildId: "build-m5-2026.10.14",
    capabilityHash: hex("d"),
    ...patch,
  });

const artifactReceipt = (patch: Json = {}): Json =>
  merge(
    {
      kind: "host_artifact_receipt",
      artifactId: "artifact-77",
      sha256: ARTIFACT_SHA,
      byteCount: ARTIFACT_SIZE,
      stage: "verified_durable",
      issuedAtMs: NOW - 4_000,
    },
    merge(
      identityFields({
        sourceHostId: "host-m1",
        receiverHostId: "host-m5",
        receiverBootId: "boot-m5-3",
        runtimeBuildId: "build-m5-2026.10.14",
        capabilityHash: hex("d"),
      }),
      patch,
    ),
  );

const artifactInput = (patch: Json = {}) => ({
  admission: persistedAdmission(),
  binding: artifactBinding(),
  manifest: manifest(),
  receipt: artifactReceipt(),
  nowMs: NOW,
  ...patch,
});

const terminalReport = (patch: Json = {}): Json =>
  merge(
    {
      kind: "host_terminal_report",
      outcome: "interrupted",
      cleanup: "verified",
      fencedThroughAttempt: 2,
      issuedAtMs: NOW - 4_000,
    },
    merge(identityFields(), patch),
  );

const attemptStatus = (patch: Json = {}): Json =>
  merge(
    {
      version: 1,
      kind: "host_attempt_status",
      connection: "disconnected",
      lease: "expired",
      cancel: "requested",
      observedAtMs: NOW - 2_000,
    },
    patch,
  );

/** Liveness that explains nothing, so a hold's reasons isolate the evidence under test. */
const quietStatus = (patch: Json = {}): Json =>
  attemptStatus({ connection: "connected", lease: "live", cancel: "none", ...patch });

const retryInput = (patch: Json = {}) => ({
  admission: persistedAdmission(),
  binding: baseBinding(),
  expected: taskExpectation(),
  status: attemptStatus(),
  terminal: terminalReport(),
  nowMs: NOW,
  ...patch,
});

describe("MissionHostProtocol readiness", () => {
  it("accepts a fully matching set of injected trusted facts", () => {
    const decision = verifyHostReadiness(readinessInput());
    expect(decision.decision).toBe("ready");
    expect(decision.reasons).toEqual([]);
    expect(decision.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds a persisted admission through the typed helper too", () => {
    const admission = persistedAdmission() as unknown as MissionExecutionAdmission;
    const bound = hostProtocolAdmissionBinding(admission);
    expect(Object.keys(bound).toSorted()).toEqual(
      [
        "accountId",
        "admittedAtMs",
        "attemptNumber",
        "billingMode",
        "bootId",
        "environmentId",
        "hostEpoch",
        "hostId",
        "missionId",
        "requestDigest",
        "taskId",
        "teamId",
      ].toSorted(),
    );
    expect(verifyHostReadiness(readinessInput({ admission: bound })).decision).toBe("ready");
  });

  it.each([
    ["receiver host", { receiverHostId: "host-m9" }, "receiver_host_mismatch", "hold"],
    ["team", { teamId: "team-other" }, "team_mismatch", "denied"],
    ["environment", { environmentId: "env-other" }, "environment_mismatch", "denied"],
    ["company", { company: "CATCHES" }, "company_denied", "denied"],
    ["epoch", { controllerEpoch: 3 }, "epoch_mismatch", "hold"],
    ["runtime build", { runtimeBuildId: "build-old" }, "runtime_build_mismatch", "hold"],
    ["capability hash", { capabilityHash: hex("e") }, "capability_mismatch", "hold"],
    ["boot", { receiverBootId: "boot-m1-6" }, "receiver_boot_mismatch", "hold"],
    ["repository", { projectId: "project-2" }, "repository_mismatch", "hold"],
    ["repo pin commit", { sourceCommit: OTHER_COMMIT }, "commit_mismatch", "hold"],
  ])("holds a swapped %s in the receiver report", (_name, patch, reason, decision) => {
    const result = verifyHostReadiness(readinessInput({ report: readinessReport(patch) }));
    expect(result.decision).toBe(decision);
    expect(result.reasons).toContain(reason);
    expect(result.evidenceDigest).toBeNull();
  });

  it("never treats a self-asserted string claim as trust", () => {
    const forged = readinessReport({ authentication: "authenticated", trusted: true, ready: true });
    const result = verifyHostReadiness(readinessInput({ report: forged }));
    expect(result.decision).toBe("hold");
    expect(result.reasons).toEqual(["message_malformed"]);
  });

  it.each(["unauthenticated", "unknown"])(
    "holds on %s transport authentication",
    (authentication) => {
      const result = verifyHostReadiness(
        readinessInput({ binding: baseBinding({ authentication }) }),
      );
      expect(result.decision).toBe("hold");
      expect(result.reasons).toContain("transport_unauthenticated");
    },
  );

  it("holds when the binding describes a different build than the report claims", () => {
    const result = verifyHostReadiness(
      readinessInput({ binding: baseBinding({ runtimeBuildId: "build-other" }) }),
    );
    expect(result.reasons).toContain("runtime_build_mismatch");
  });

  it("holds when the binding disagrees with the admitted host or boot", () => {
    const wrongHost = verifyHostReadiness(
      readinessInput({ admission: persistedAdmission({ hostId: "host-m9" }) }),
    );
    expect(wrongHost.reasons).toContain("admitted_host_mismatch");
    const rebooted = verifyHostReadiness(
      readinessInput({ admission: persistedAdmission({ bootId: "boot-m1-6" }) }),
    );
    expect(rebooted.reasons).toContain("receiver_boot_mismatch");
  });

  it("holds stale receiver readiness, stale binding, and stale account facts", () => {
    const old = NOW - HOST_PROTOCOL_MAX_EVIDENCE_AGE_MS - 1;
    expect(
      verifyHostReadiness(readinessInput({ report: readinessReport({ observedAtMs: old }) }))
        .reasons,
    ).toEqual(["evidence_stale"]);
    expect(
      verifyHostReadiness(readinessInput({ binding: baseBinding({ observedAtMs: old }) })).reasons,
    ).toEqual(["binding_stale"]);
    expect(
      verifyHostReadiness(readinessInput({ capacity: capacity({ observedAtMs: old }) })).reasons,
    ).toEqual(["evidence_stale"]);
  });

  it("holds local build, toolchain, pressure, and slot problems; unknown telemetry is not clean", () => {
    const cases: Array<[Json, string]> = [
      [{ buildOk: false }, "build_not_ok"],
      [{ toolchainOk: false }, "toolchain_not_ok"],
      [{ pressure: "unknown" }, "pressure_unknown"],
      [{ pressure: "elevated" }, "pressure_unacceptable"],
      [{ pressure: "critical" }, "pressure_unacceptable"],
      [{ heavyBuildSlotsFree: 0 }, "no_heavy_build_slot"],
    ];
    for (const [patch, reason] of cases) {
      const result = verifyHostReadiness(readinessInput({ report: readinessReport(patch) }));
      expect(result.decision).toBe("hold");
      expect(result.reasons).toEqual([reason]);
    }
  });

  it("treats the account budget as global: unknown headroom is never assumed healthy", () => {
    const cases: Array<[Json, string]> = [
      [{ headroom: "unknown" }, "account_headroom_unknown"],
      [{ headroom: "low" }, "account_headroom_low"],
      [{ headroom: "exhausted" }, "account_headroom_exhausted"],
      [{ scope: "host" }, "account_budget_not_global"],
      [{ scope: "unknown" }, "account_budget_not_global"],
      [{ reservationId: null }, "account_reservation_missing"],
      [{ accountId: "acct-other" }, "account_mismatch"],
      [{ billingMode: "api" }, "account_mismatch"],
    ];
    for (const [patch, reason] of cases) {
      const result = verifyHostReadiness(readinessInput({ capacity: capacity(patch) }));
      expect(result.decision).toBe("hold");
      expect(result.reasons).toEqual([reason]);
    }
    // A free host-local slot does not stand in for a missing shared reservation.
    const hostScoped = verifyHostReadiness(
      readinessInput({
        report: readinessReport({ heavyBuildSlotsFree: 1 }),
        capacity: capacity({ scope: "host", reservationId: null }),
      }),
    );
    expect(hostScoped.reasons).toEqual([
      "account_budget_not_global",
      "account_reservation_missing",
    ]);
  });

  it("holds a missing report as queued-only, not as readiness", () => {
    for (const report of [undefined, null]) {
      const result = verifyHostReadiness(readinessInput({ report }));
      expect(result.decision).toBe("hold");
      expect(result.reasons).toEqual(["receiver_ack_missing"]);
    }
  });
});

describe("MissionHostProtocol claim ACK", () => {
  it("acknowledges a claim that matches every trusted fact", () => {
    const decision = verifyHostClaimAck(claimInput());
    expect(decision).toMatchObject({
      subject: "host_claim_ack",
      decision: "claim_acknowledged",
      reasons: [],
    });
    expect(decision.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not take a bridge-queued event for a receiver observation or a claim", () => {
    const missing = verifyHostClaimAck(claimInput({ ack: undefined }));
    expect(missing.decision).toBe("hold");
    expect(missing.reasons).toEqual(["receiver_ack_missing"]);

    const queued = verifyHostClaimAck(claimInput({ ack: claimAck({ stage: "queued" }) }));
    expect(queued.reasons).toEqual(["queued_only"]);

    const observed = verifyHostClaimAck(claimInput({ ack: claimAck({ stage: "observed" }) }));
    expect(observed.reasons).toEqual(["observed_not_claimed"]);
  });

  it.each([
    ["team", { teamId: "team-other" }, "team_mismatch", "denied"],
    ["environment", { environmentId: "env-other" }, "environment_mismatch", "denied"],
    ["company", { company: "CATCHES" }, "company_denied", "denied"],
    ["mission", { missionId: "mission-2" }, "mission_mismatch", "hold"],
    ["task", { taskId: "task-b" }, "task_mismatch", "hold"],
    ["attempt", { attemptNumber: 1 }, "attempt_mismatch", "hold"],
    ["admission digest", { admissionDigest: hex("2") }, "admission_mismatch", "hold"],
    ["command", { commandId: "command-1" }, "command_mismatch", "hold"],
    ["run", { runId: "run-2" }, "run_mismatch", "hold"],
    ["source host", { sourceHostId: "host-m9" }, "source_host_mismatch", "hold"],
    ["receiver host", { receiverHostId: "host-m9" }, "receiver_host_mismatch", "hold"],
    ["epoch", { controllerEpoch: 3 }, "epoch_mismatch", "hold"],
    ["repository", { projectId: "project-2" }, "repository_mismatch", "hold"],
    ["worktree", { worktreeRef: "worktree-handle-13" }, "worktree_mismatch", "hold"],
    ["source commit", { sourceCommit: OTHER_COMMIT }, "commit_mismatch", "hold"],
    ["boot", { receiverBootId: "boot-m1-6" }, "receiver_boot_mismatch", "hold"],
    ["runtime build", { runtimeBuildId: "build-old" }, "runtime_build_mismatch", "hold"],
    ["capability hash", { capabilityHash: hex("e") }, "capability_mismatch", "hold"],
  ])("never acknowledges a swapped %s", (_name, patch, reason, decision) => {
    const result = verifyHostClaimAck(claimInput({ ack: claimAck(patch) }));
    expect(result.decision).toBe(decision);
    expect(result.reasons).toContain(reason);
    expect(result.evidenceDigest).toBeNull();
  });

  it("holds an ACK from an older epoch after the manager rotated", () => {
    const result = verifyHostClaimAck(
      claimInput({ admission: persistedAdmission({ hostEpoch: 5 }) }),
    );
    expect(result.decision).toBe("hold");
    expect(result.reasons).toEqual(["epoch_mismatch"]);
  });

  it("holds a stale ACK, one from the future, and one that predates the admission", () => {
    const stale = verifyHostClaimAck(
      claimInput({ ack: claimAck({ issuedAtMs: NOW - HOST_PROTOCOL_MAX_EVIDENCE_AGE_MS - 1 }) }),
    );
    expect(stale.reasons).toEqual(["ack_stale"]);

    const future = verifyHostClaimAck(
      claimInput({ ack: claimAck({ issuedAtMs: NOW + HOST_PROTOCOL_MAX_CLOCK_SKEW_MS + 1 }) }),
    );
    expect(future.reasons).toEqual(["evidence_from_future"]);

    const skewed = verifyHostClaimAck(
      claimInput({ ack: claimAck({ issuedAtMs: NOW + HOST_PROTOCOL_MAX_CLOCK_SKEW_MS }) }),
    );
    expect(skewed.decision).toBe("claim_acknowledged");

    const early = verifyHostClaimAck(
      claimInput({
        admission: persistedAdmission({ admittedAtMs: NOW - 1_000 }),
        ack: claimAck({ issuedAtMs: NOW - 1_000 - HOST_PROTOCOL_MAX_CLOCK_SKEW_MS - 1 }),
      }),
    );
    expect(early.reasons).toEqual(["evidence_predates_admission"]);
  });

  it("lets a caller only tighten the evidence age", () => {
    const ack = claimAck({ issuedAtMs: NOW - 2_000 });
    const binding = baseBinding({ observedAtMs: NOW - 100 });
    expect(verifyHostClaimAck(claimInput({ ack, binding, maxAgeMs: 1_000 })).reasons).toEqual([
      "ack_stale",
    ]);
    expect(verifyHostClaimAck(claimInput({ ack, binding, maxAgeMs: 3_000 })).decision).toBe(
      "claim_acknowledged",
    );
    const loosened = claimAck({ issuedAtMs: NOW - HOST_PROTOCOL_MAX_EVIDENCE_AGE_MS - 1 });
    expect(
      verifyHostClaimAck(
        claimInput({
          ack: loosened,
          maxAgeMs: HOST_PROTOCOL_MAX_EVIDENCE_AGE_MS * 10,
          binding: baseBinding({ observedAtMs: NOW }),
        }),
      ).reasons,
    ).toEqual(["ack_stale"]);
  });

  it("requires an authenticated, current, No Fun binding regardless of the message", () => {
    const unauthenticated = verifyHostClaimAck(
      claimInput({ binding: baseBinding({ authentication: "unauthenticated" }) }),
    );
    expect(unauthenticated.reasons).toEqual(["transport_unauthenticated"]);

    const catches = verifyHostClaimAck(
      claimInput({
        binding: baseBinding({ company: "CATCHES" }),
        ack: claimAck({ company: "CATCHES" }),
      }),
    );
    expect(catches.decision).toBe("denied");
    expect(catches.reasons).toContain("company_denied");

    // A message that claims No Fun cannot launder a binding for another company or tenancy.
    for (const [patch, reason] of [
      [{ company: "CATCHES" }, "company_denied"],
      [{ teamId: "team-other" }, "team_mismatch"],
      [{ environmentId: "env-other" }, "environment_mismatch"],
    ] as const) {
      const result = verifyHostClaimAck(claimInput({ binding: baseBinding(patch) }));
      expect(result.decision).toBe("denied");
      expect(result.reasons).toEqual([reason]);
    }

    const staleBinding = verifyHostClaimAck(
      claimInput({
        binding: baseBinding({ observedAtMs: NOW - HOST_PROTOCOL_MAX_EVIDENCE_AGE_MS - 1 }),
      }),
    );
    expect(staleBinding.reasons).toEqual(["binding_stale"]);
  });

  it("holds when expected hosts disagree with the authenticated binding or the admission", () => {
    const sender = verifyHostClaimAck(
      claimInput({ binding: baseBinding({ receiverHostId: "host-m9" }) }),
    );
    expect(sender.reasons).toEqual(expect.arrayContaining(["receiver_host_mismatch"]));
    const source = verifyHostClaimAck(
      claimInput({ binding: baseBinding({ sourceHostId: "host-m9" }) }),
    );
    expect(source.reasons).toContain("source_host_mismatch");
    const admitted = verifyHostClaimAck(
      claimInput({ admission: persistedAdmission({ hostId: "host-m9" }) }),
    );
    expect(admitted.reasons).toContain("admitted_host_mismatch");
  });
});

describe("MissionHostProtocol artifact receipt", () => {
  it("acknowledges an exact verified-durable receipt", () => {
    const decision = verifyHostArtifactReceipt(artifactInput());
    expect(decision.decision).toBe("delivery_acknowledged");
    expect(decision.reasons).toEqual([]);
  });

  it("returns the identical decision for an exact duplicate and for a stored prior ACK", () => {
    const first = verifyHostArtifactReceipt(artifactInput());
    if (first.decision !== "delivery_acknowledged") throw new Error("expected acknowledgment");
    const again = verifyHostArtifactReceipt(artifactInput());
    expect(again).toEqual(first);

    const withPrior = verifyHostArtifactReceipt(
      artifactInput({
        priorAcks: [
          {
            artifactId: "artifact-77",
            sha256: ARTIFACT_SHA,
            byteCount: ARTIFACT_SIZE,
            evidenceDigest: first.evidenceDigest,
          },
        ],
      }),
    );
    expect(withPrior).toEqual(first);
    // Resending later with a different issuance time is the same fact.
    const resent = verifyHostArtifactReceipt(
      artifactInput({ receipt: artifactReceipt({ issuedAtMs: NOW - 1_000 }) }),
    );
    expect(resent).toEqual(first);
  });

  it("denies an alias that reuses an acknowledged id for different bytes", () => {
    const priorOtherBytes = {
      artifactId: "artifact-77",
      sha256: sha256("other bytes"),
      byteCount: ARTIFACT_SIZE,
      evidenceDigest: hex("9"),
    };
    const hash = verifyHostArtifactReceipt(artifactInput({ priorAcks: [priorOtherBytes] }));
    expect(hash.decision).toBe("denied");
    expect(hash.reasons).toEqual(["artifact_alias_conflict"]);

    const size = verifyHostArtifactReceipt(
      artifactInput({ priorAcks: [{ ...priorOtherBytes, sha256: ARTIFACT_SHA, byteCount: 1 }] }),
    );
    expect(size.decision).toBe("denied");

    const unrelated = verifyHostArtifactReceipt(
      artifactInput({ priorAcks: [{ ...priorOtherBytes, artifactId: "artifact-1" }] }),
    );
    expect(unrelated.decision).toBe("delivery_acknowledged");
  });

  it("quarantines a wrong hash, a wrong size, or both, and issues no ACK", () => {
    const hash = verifyHostArtifactReceipt(
      artifactInput({ receipt: artifactReceipt({ sha256: sha256("tampered") }) }),
    );
    expect(hash).toMatchObject({
      decision: "quarantine",
      reasons: ["artifact_hash_mismatch"],
      evidenceDigest: null,
    });

    const size = verifyHostArtifactReceipt(
      artifactInput({ receipt: artifactReceipt({ byteCount: ARTIFACT_SIZE + 1 }) }),
    );
    expect(size).toMatchObject({ decision: "quarantine", reasons: ["artifact_size_mismatch"] });

    const both = verifyHostArtifactReceipt(
      artifactInput({
        receipt: artifactReceipt({ sha256: sha256("tampered"), byteCount: 3 }),
      }),
    );
    expect(both.reasons).toEqual(["artifact_hash_mismatch", "artifact_size_mismatch"]);
  });

  it.each([
    ["artifact id", { artifactId: "artifact-78" }, "artifact_id_mismatch"],
    ["task", { taskId: "task-b" }, "task_mismatch"],
    ["run", { runId: "run-2" }, "run_mismatch"],
    ["attempt", { attemptNumber: 1 }, "attempt_mismatch"],
    ["source commit", { sourceCommit: OTHER_COMMIT }, "commit_mismatch"],
    ["receiver host", { receiverHostId: "host-m9" }, "receiver_host_mismatch"],
    ["source host", { sourceHostId: "host-m9" }, "source_host_mismatch"],
    ["repository", { projectId: "project-2" }, "repository_mismatch"],
    ["worktree", { worktreeRef: "worktree-handle-13" }, "worktree_mismatch"],
  ])("quarantines a receipt whose %s differs from the manifest", (_name, patch, reason) => {
    const result = verifyHostArtifactReceipt(artifactInput({ receipt: artifactReceipt(patch) }));
    expect(result.decision).toBe("quarantine");
    expect(result.reasons).toContain(reason);
    expect(result.evidenceDigest).toBeNull();
  });

  it("denies a receipt for another company and holds a swapped epoch, build, or capability", () => {
    const company = verifyHostArtifactReceipt(
      artifactInput({ receipt: artifactReceipt({ company: "CATCHES" }) }),
    );
    expect(company.decision).toBe("denied");
    expect(company.reasons).toContain("company_denied");

    const cases: Array<[Json, string]> = [
      [{ controllerEpoch: 3 }, "epoch_mismatch"],
      [{ runtimeBuildId: "build-old" }, "runtime_build_mismatch"],
      [{ capabilityHash: hex("e") }, "capability_mismatch"],
      [{ receiverBootId: "boot-m5-2" }, "receiver_boot_mismatch"],
    ];
    for (const [patch, reason] of cases) {
      const result = verifyHostArtifactReceipt(artifactInput({ receipt: artifactReceipt(patch) }));
      expect(result.decision).toBe("hold");
      expect(result.reasons).toEqual([reason]);
    }
  });

  it("does not take a queued or received-only artifact message for a delivery ACK", () => {
    const queued = verifyHostArtifactReceipt(
      artifactInput({ receipt: artifactReceipt({ stage: "queued" }) }),
    );
    expect(queued).toMatchObject({ decision: "hold", reasons: ["queued_only"] });
    const received = verifyHostArtifactReceipt(
      artifactInput({ receipt: artifactReceipt({ stage: "received" }) }),
    );
    expect(received).toMatchObject({ decision: "hold", reasons: ["received_not_durable"] });
    const none = verifyHostArtifactReceipt(artifactInput({ receipt: undefined }));
    expect(none).toMatchObject({ decision: "hold", reasons: ["receiver_ack_missing"] });
  });

  it("holds when the authenticated transport cannot durably acknowledge", () => {
    const volatile = verifyHostArtifactReceipt(
      artifactInput({ binding: artifactBinding({ durableAck: "volatile" }) }),
    );
    expect(volatile).toMatchObject({ decision: "hold", reasons: ["durable_ack_unsupported"] });
    const unknown = verifyHostArtifactReceipt(
      artifactInput({ binding: artifactBinding({ durableAck: "unknown" }) }),
    );
    expect(unknown).toMatchObject({ decision: "hold", reasons: ["durable_ack_unknown"] });
  });

  it("holds a stale receipt and unauthenticated transport", () => {
    const stale = verifyHostArtifactReceipt(
      artifactInput({
        receipt: artifactReceipt({ issuedAtMs: NOW - HOST_PROTOCOL_MAX_EVIDENCE_AGE_MS - 1 }),
      }),
    );
    expect(stale.reasons).toEqual(["ack_stale"]);
    const unauthenticated = verifyHostArtifactReceipt(
      artifactInput({ binding: artifactBinding({ authentication: "unauthenticated" }) }),
    );
    expect(unauthenticated.reasons).toEqual(["transport_unauthenticated"]);
  });

  it("holds when the manifest does not line up with the binding or admitted producer", () => {
    const hosts = verifyHostArtifactReceipt(
      artifactInput({ manifest: manifest({}, { receiverHostId: "host-m9" }) }),
    );
    expect(hosts.reasons).toContain("receiver_host_mismatch");
    const producer = verifyHostArtifactReceipt(
      artifactInput({ admission: persistedAdmission({ hostId: "host-m9" }) }),
    );
    expect(producer.reasons).toContain("admitted_host_mismatch");
  });

  it("bounds prior ACK input", () => {
    const record = {
      artifactId: "artifact-1",
      sha256: ARTIFACT_SHA,
      byteCount: ARTIFACT_SIZE,
      evidenceDigest: verifyHostArtifactReceipt(artifactInput()).evidenceDigest,
    };
    const atLimit = Array.from({ length: MAX_HOST_PROTOCOL_PRIOR_ACKS }, () => record);
    expect(verifyHostArtifactReceipt(artifactInput({ priorAcks: atLimit })).decision).toBe(
      "delivery_acknowledged",
    );
    const over = Array.from({ length: MAX_HOST_PROTOCOL_PRIOR_ACKS + 1 }, () => record);
    for (const priorAcks of [over, "not-an-array", { length: 0 }, [{ ...record, extra: 1 }]]) {
      const result = verifyHostArtifactReceipt(artifactInput({ priorAcks }));
      expect(result.decision).toBe("hold");
      expect(result.reasons).toEqual(["prior_malformed"]);
    }
  });
});

describe("MissionHostProtocol automatic retry", () => {
  it("permits retry only on exact trusted terminal, cleanup, and enforced fence evidence", () => {
    const decision = decideHostAutomaticRetry(retryInput());
    expect(decision.decision).toBe("automatic_retry_permitted");
    expect(decision.reasons).toEqual([]);
    expect(decision.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
    for (const outcome of ["failed", "cancelled", "interrupted"]) {
      expect(
        decideHostAutomaticRetry(retryInput({ terminal: terminalReport({ outcome }) })).decision,
      ).toBe("automatic_retry_permitted");
    }
  });

  it("does not take disconnect, lease expiry, or a cancel request for a stop", () => {
    const cases: Array<[Json, string[]]> = [
      [{ connection: "disconnected", lease: "live", cancel: "none" }, ["disconnected_not_stopped"]],
      [
        { connection: "connected", lease: "expired", cancel: "none" },
        ["lease_expired_not_stopped"],
      ],
      [
        { connection: "connected", lease: "live", cancel: "requested" },
        ["cancel_requested_not_stopped"],
      ],
      [
        { connection: "connected", lease: "live", cancel: "acknowledged" },
        ["cancel_acknowledged_not_terminal"],
      ],
      [
        { connection: "unknown", lease: "unknown", cancel: "unknown" },
        ["connection_unknown", "lease_unknown", "cancel_unknown"],
      ],
      [{ connection: "connected", lease: "live", cancel: "none" }, []],
    ];
    for (const [status, expectedReasons] of cases) {
      const result = decideHostAutomaticRetry(
        retryInput({ status: attemptStatus(status), terminal: undefined }),
      );
      expect(result.decision).toBe("hold");
      expect(result.reasons).toEqual(
        ["terminal_missing", ...expectedReasons].toSorted(byReasonOrder),
      );
    }
  });

  it("lets exact terminal evidence outrank uncertain liveness", () => {
    const result = decideHostAutomaticRetry(
      retryInput({
        status: attemptStatus({ connection: "unknown", lease: "expired", cancel: "requested" }),
      }),
    );
    expect(result.decision).toBe("automatic_retry_permitted");
  });

  it("holds uncertain, completed, and uncleaned terminal evidence", () => {
    const cases: Array<[Json, string]> = [
      [{ outcome: "uncertain" }, "terminal_outcome_uncertain"],
      [{ outcome: "completed" }, "attempt_completed"],
      [{ cleanup: "pending" }, "cleanup_unproven"],
      [{ cleanup: "unknown" }, "cleanup_unproven"],
      [{ fencedThroughAttempt: 1 }, "fence_generation_behind"],
    ];
    for (const [patch, reason] of cases) {
      const result = decideHostAutomaticRetry(
        retryInput({ terminal: terminalReport(patch), status: quietStatus() }),
      );
      expect(result.decision).toBe("hold");
      expect(result.reasons).toContain(reason);
      expect(result.evidenceDigest).toBeNull();
    }
  });

  it("blocks automatic retry when transport fencing is unknown or unsupported", () => {
    for (const [fencing, reason] of [
      ["unknown", "fencing_unknown"],
      ["unsupported", "fencing_unsupported"],
    ] as const) {
      const result = decideHostAutomaticRetry(
        retryInput({ binding: baseBinding({ fencing }), status: quietStatus() }),
      );
      expect(result.decision).toBe("hold");
      expect(result.reasons).toEqual([reason]);
    }
  });

  it("holds terminal evidence that names a different attempt, run, or build", () => {
    const cases: Array<[Json, string]> = [
      [{ attemptNumber: 1 }, "attempt_mismatch"],
      [{ runId: "run-2" }, "run_mismatch"],
      [{ receiverHostId: "host-m9" }, "receiver_host_mismatch"],
      [{ controllerEpoch: 3 }, "epoch_mismatch"],
      [{ runtimeBuildId: "build-old" }, "runtime_build_mismatch"],
      [{ company: "CATCHES" }, "company_denied"],
    ];
    for (const [patch, reason] of cases) {
      const result = decideHostAutomaticRetry(retryInput({ terminal: terminalReport(patch) }));
      expect(result.decision === "automatic_retry_permitted").toBe(false);
      expect(result.reasons).toContain(reason);
    }
  });

  it("holds without an authenticated binding or a valid status fact", () => {
    expect(
      decideHostAutomaticRetry(
        retryInput({ binding: baseBinding({ authentication: "unknown" }), status: quietStatus() }),
      ).reasons,
    ).toEqual(["transport_unauthenticated"]);
    expect(decideHostAutomaticRetry(retryInput({ status: undefined })).reasons).toEqual([
      "status_malformed",
    ]);
    expect(
      decideHostAutomaticRetry(
        retryInput({
          status: quietStatus({ observedAtMs: NOW - HOST_PROTOCOL_MAX_EVIDENCE_AGE_MS - 1 }),
        }),
      ).reasons,
    ).toEqual(["evidence_stale"]);
  });
});

/** Same fixed ordering the verifier reports, used to build expected arrays. */
function byReasonOrder(left: string, right: string): number {
  const order: ReadonlyArray<string> = HostProtocolReasonCode.literals;
  return order.indexOf(left) - order.indexOf(right);
}

describe("MissionHostProtocol input hygiene", () => {
  it("never mutates input, never aliases it, and returns frozen decisions", () => {
    const input = claimInput();
    const before = structuredClone(input);
    const decision = verifyHostClaimAck(input);
    expect(input).toEqual(before);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.reasons)).toBe(true);
    expect(() => (decision.reasons as unknown as string[]).push("x")).toThrow(TypeError);
    expect(() => {
      (decision as { decision: string }).decision = "hold";
    }).toThrow(TypeError);

    // Mutating the original input afterwards cannot change the earlier decision.
    const snapshot = JSON.stringify(decision);
    (input.ack as Json).runId = "run-other";
    (input.admission as Json).hostEpoch = 99;
    expect(JSON.stringify(decision)).toBe(snapshot);
    expect(verifyHostClaimAck(input).decision).toBe("hold");
  });

  it("accepts deeply frozen input and tolerates cloned input identically", () => {
    const frozen = structuredClone(artifactInput());
    const freeze = (value: unknown): void => {
      if (typeof value === "object" && value !== null) {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    };
    freeze(frozen);
    const a = verifyHostArtifactReceipt(frozen);
    const b = verifyHostArtifactReceipt(structuredClone(artifactInput()));
    expect(a).toEqual(b);
    expect(a.decision).toBe("delivery_acknowledged");
  });

  it("is deterministic and reports reasons in the fixed order", () => {
    const input = readinessInput({
      report: readinessReport({
        buildOk: false,
        pressure: "unknown",
        controllerEpoch: 1,
        runtimeBuildId: "x",
      }),
      capacity: capacity({ headroom: "unknown", reservationId: null }),
    });
    const first = verifyHostReadiness(input);
    const second = verifyHostReadiness(structuredClone(input));
    expect(first).toEqual(second);
    expect(first.reasons).toEqual(
      [
        "epoch_mismatch",
        "runtime_build_mismatch",
        "build_not_ok",
        "pressure_unknown",
        "account_reservation_missing",
        "account_headroom_unknown",
      ].toSorted(byReasonOrder),
    );
    const isReason = Schema.is(HostProtocolReasonCode);
    expect(first.reasons.every((reason) => isReason(reason))).toBe(true);
  });

  it("never reads a clock", () => {
    const now = vi.spyOn(Date, "now");
    try {
      verifyHostReadiness(readinessInput());
      verifyHostClaimAck(claimInput());
      verifyHostArtifactReceipt(artifactInput());
      decideHostAutomaticRetry(retryInput());
      expect(now).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("holds an invalid caller clock", () => {
    for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 2 ** 53, "now" as never]) {
      const result = verifyHostClaimAck(claimInput({ nowMs }));
      expect(result.decision).toBe("hold");
      expect(result.reasons).toEqual(["clock_invalid"]);
    }
  });

  it("enforces identifier bounds, exact keys, and safe integers", () => {
    const limit = "x".repeat(MAX_HOST_PROTOCOL_ID_LENGTH);
    expect(
      verifyHostClaimAck(
        claimInput({
          expected: taskExpectation({ commandId: limit }),
          ack: claimAck({ commandId: limit }),
        }),
      ).decision,
    ).toBe("claim_acknowledged");

    const malformed: Array<[string, Json]> = [
      ["too long", { commandId: `${limit}x` }],
      ["empty", { commandId: "" }],
      ["edge whitespace", { commandId: " command-9" }],
      ["control character", { commandId: "command\u0000-9" }],
      ["newline", { commandId: "command\n9" }],
      ["unsafe attempt", { attemptNumber: 2 ** 53 }],
      ["fractional attempt", { attemptNumber: 2.5 }],
      ["zero attempt", { attemptNumber: 0 }],
      ["NaN epoch", { controllerEpoch: Number.NaN }],
      ["infinite issued time", { issuedAtMs: Number.POSITIVE_INFINITY }],
      ["negative issued time", { issuedAtMs: -1 }],
      ["short digest", { admissionDigest: "abc" }],
      ["uppercase digest", { admissionDigest: "A".repeat(64) }],
      ["bad commit", { sourceCommit: "not-a-commit" }],
      ["bad stage", { stage: "claimed-ish" }],
      ["wrong kind", { kind: "host_artifact_receipt" }],
      ["wrong version", { version: 2 }],
      ["extra key", { sessionToken: "secret" }],
      ["number as string id", { commandId: 9 }],
    ];
    for (const [name, patch] of malformed) {
      const result = verifyHostClaimAck(claimInput({ ack: claimAck(patch) }));
      expect(result.decision, name).toBe("hold");
      expect(result.reasons, name).toEqual(["message_malformed"]);
    }
  });

  it("rejects host-local paths, addresses of path shape, and prototype tricks", () => {
    for (const worktreeRef of ["/Users/nofun/work/tree", "~/work", "C:\\work\\tree", "a/b", ".."]) {
      const ack = claimAck({ worktreeRef });
      const expected = taskExpectation({ worktreeRef });
      const result = verifyHostClaimAck(claimInput({ ack, expected }));
      expect(result.decision, worktreeRef).toBe("hold");
      expect(result.reasons, worktreeRef).toContain("expectation_malformed");
    }
    const polluted = JSON.parse(
      `{"__proto__":{"isAdmin":true},"version":1,"kind":"host_claim_ack"}`,
    ) as unknown;
    expect(verifyHostClaimAck(claimInput({ ack: polluted })).reasons).toEqual([
      "message_malformed",
    ]);
    expect(({} as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  });

  it("never throws on hostile or non-object input", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
        ownKeys() {
          throw new Error("boom");
        },
        getOwnPropertyDescriptor() {
          throw new Error("boom");
        },
      },
    );
    const throwingGetter = Object.defineProperty({ ...claimAck() }, "runId", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    const values: unknown[] = [
      undefined,
      null,
      0,
      1.5,
      "text",
      true,
      [],
      [1, 2],
      Symbol("s"),
      () => 1,
      hostile,
      throwingGetter,
      "y".repeat(2_000_000),
    ];
    for (const value of values) {
      for (const result of [
        verifyHostReadiness({ ...readinessInput(), report: value, binding: value } as never),
        verifyHostClaimAck({
          ...claimInput(),
          ack: value,
          expected: value,
          admission: value,
        } as never),
        verifyHostArtifactReceipt({ ...artifactInput(), receipt: value, manifest: value } as never),
        decideHostAutomaticRetry({ ...retryInput(), terminal: value, status: value } as never),
      ]) {
        expect(["hold", "denied", "quarantine"]).toContain(result.decision);
        expect(result.reasons.length).toBeGreaterThan(0);
        expect(result.evidenceDigest).toBeNull();
      }
    }
    // The whole input being hostile is a bounded hold too.
    for (const whole of [undefined, null, hostile]) {
      expect(verifyHostClaimAck(whole as never)).toMatchObject({
        decision: "hold",
        reasons: ["verifier_fault"],
      });
    }
    expect(verifyHostClaimAck(5 as never).decision).toBe("hold");
  });
});

describe("host protocol root acceptance", () => {
  it("accepts an actual opaque T3 run identity without decoding it", () => {
    const runId =
      "run:thread:thread%3Adelegated-task%3Acommand%253Amcp%253A5c5500c7-7c56-4777-9034-b9ac7d5833b6%253Adelegate-task%253Acombined-v3-20261014-p4-host-protocol-01:ordinal:1";
    const extendedRunId = runId.replace(
      "p4-host-protocol-01",
      "p4-host-protocol-01-receiver-artifact-ack-reconciliation-independently-observed-exact-source-contract-version-pinned-01",
    );
    expect(extendedRunId.length).toBeGreaterThan(256);
    expect(extendedRunId.length).toBeLessThan(512);
    expect(
      verifyHostClaimAck(
        claimInput({
          expected: taskExpectation({ runId: extendedRunId }),
          ack: claimAck({ runId: extendedRunId }),
        }),
      ).decision,
    ).toBe("claim_acknowledged");
  });

  it("holds invalid explicit evidence-age settings instead of silently widening them", () => {
    for (const maxAgeMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      const result = verifyHostClaimAck(claimInput({ maxAgeMs }));
      expect(result.decision).toBe("hold");
      expect(result.reasons).toContain("clock_invalid");
    }
  });

  it("denies reusing an artifact identity with different acknowledged run evidence", () => {
    const first = verifyHostArtifactReceipt(artifactInput());
    if (first.decision !== "delivery_acknowledged") throw new Error("fixture must acknowledge");
    const prior = {
      artifactId: "artifact-77",
      sha256: ARTIFACT_SHA,
      byteCount: ARTIFACT_SIZE,
      evidenceDigest: first.evidenceDigest,
    };
    const retargetedManifest = {
      ...manifest(),
      expectation: { ...(manifest().expectation as Json), runId: "different-run" },
    };
    const result = verifyHostArtifactReceipt(
      artifactInput({
        manifest: retargetedManifest,
        receipt: artifactReceipt({ runId: "different-run" }),
        priorAcks: [prior],
      }),
    );
    expect(result.decision).toBe("denied");
    expect(result.reasons).toContain("artifact_alias_conflict");
  });
});

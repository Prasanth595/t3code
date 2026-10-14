import { describe, expect, it } from "@effect/vitest";

import { MAX_PRO_PLANNING_RECORD_REVISION } from "../../../../packages/contracts/src/missionProPlanning.ts";
import {
  advanceProPlanning,
  PRO_PLANNING_MAX_CLOCK_SKEW_MS,
  PRO_PLANNING_MAX_EVIDENCE_AGE_MS,
  type ProPlanningDecision,
} from "./MissionProPlanning.ts";

/**
 * TRUST BOUNDARY OF THESE FIXTURES. Every `facts` and `evidence` value below
 * is a hand-built stand-in for what a future trusted producer would supply
 * (canonical mission read, independent GUI verification, the owning store's
 * reservation ACK). Nothing here talks to ChatGPT, a model, a browser, a
 * clock, or a database, so a passing positive case proves only that the pure
 * guard proposes the next step for a fully matching set of facts. It is NOT
 * evidence of a persisted reservation, a real Pro run, usage allowance, or any
 * authorization to submit or to code.
 */

const NOW = 1_800_000_000_000;
const hex = (char: string): string => char.repeat(64);

type Json = Record<string, unknown>;

const MANAGER = "t3:thread/éπ-0007:mgr 1";
const CONVERSATION = "https://chat.example.test/c/abc";
const RESPONSE = "https://chat.example.test/c/abc/response/1";
const PROMPT_SHA = hex("a");
const ACCEPTANCE = hex("c");
const SCOPE = hex("d");

const route = (): Json => ({
  accountRef: "acct-pro-1",
  workspaceRef: "ws-nofun",
  chatMode: "Chat",
  proOption: "Pro",
  model: "pro-model-1",
});

const preparedRecord = (patch: Json = {}): Json => ({
  schemaVersion: 1,
  planningId: "plan-1",
  submissionId: "sub-1",
  idempotencyKey: "idem-1",
  missionId: "mission-1",
  missionRevision: 7,
  teamId: "team-nofun",
  environmentId: "env-authority",
  managerThreadId: MANAGER,
  managerEpoch: 3,
  stage: "prepared",
  revision: 0,
  route: route(),
  prompt: {
    revision: 2,
    sha256: PROMPT_SHA,
    sourcePointers: ["https://example.test/spec"],
    attachmentHashes: [hex("b")],
  },
  ...patch,
});

const submittedRecord = (patch: Json = {}): Json =>
  preparedRecord({ stage: "submitted", revision: 1, ...patch });

const wake = (patch: Json = {}): Json => ({
  wakeKey: "wake-1",
  notBeforeMs: NOW - 1_000,
  expiresAtMs: NOW + 3_600_000,
  ...patch,
});

const pendingRecord = (patch: Json = {}): Json =>
  preparedRecord({
    stage: "response_pending",
    revision: 2,
    conversation: { conversationRef: CONVERSATION, source: "submit_ack" },
    wake: wake(),
    ...patch,
  });

const retrieval = (patch: Json = {}): Json => ({
  responseRef: RESPONSE,
  completionEvidenceSha256: hex("e"),
  responseSha256: hex("f"),
  observedModel: "pro-model-1",
  observedMode: "Chat",
  complete: true,
  paginationGaps: 0,
  requiredAttachmentHashes: [hex("1")],
  verifiedAttachmentHashes: [hex("1")],
  ...patch,
});

const retrievedRecord = (patch: Json = {}): Json =>
  pendingRecord({ stage: "retrieved", revision: 3, retrieval: retrieval(), ...patch });

const reconciliation = (patch: Json = {}): Json => ({
  recommendationRef: RESPONSE,
  currentConstraintRef: "constraint-1",
  constraintRevision: 7,
  adaptedRouteRef: "route-1",
  acceptanceDigest: ACCEPTANCE,
  scopeDigest: SCOPE,
  proposalRevision: 1,
  reconciliationRef: "recon-1",
  ...patch,
});

const reconciledRecord = (patch: Json = {}): Json =>
  retrievedRecord({ stage: "reconciled", revision: 4, reconciliation: reconciliation(), ...patch });

const cancelledRecord = (patch: Json = {}): Json =>
  pendingRecord({ stage: "cancelled", revision: 3, cancelReason: "operator_cancel", ...patch });

const blockedRecord = (patch: Json = {}): Json =>
  pendingRecord({ stage: "blocked", revision: 3, blockReason: "model_fallback", ...patch });

const missionFacts = (patch: Json = {}): Json => ({
  missionId: "mission-1",
  revision: 7,
  teamId: "team-nofun",
  environmentId: "env-authority",
  managerThreadId: MANAGER,
  managerEpoch: 3,
  status: "active",
  stopRequested: false,
  pauseRequested: false,
  acceptanceDigest: ACCEPTANCE,
  ...patch,
});

const facts = (patch: Json = {}): Json => ({
  observedAtMs: NOW - 1_000,
  mission: missionFacts(),
  usage: { operatorBudget: "available", responseAllowance: "available" },
  planningApproval: {
    approvalRef: "approval-1",
    planningId: "plan-1",
    promptSha256: PROMPT_SHA,
    scopeDigest: SCOPE,
  },
  ...patch,
});

const factsWith = (mission: Json): Json => facts({ mission: missionFacts(mission) });
const factsWithUsage = (usage: Json): Json =>
  facts({ usage: { operatorBudget: "available", responseAllowance: "available", ...usage } });

const verification = (patch: Json = {}): Json => ({
  receiptRef: "receipt-verify-1",
  verifiedAtMs: NOW - 5_000,
  submissionId: "sub-1",
  promptRevision: 2,
  promptSha256: PROMPT_SHA,
  accountRef: "acct-pro-1",
  workspaceRef: "ws-nofun",
  chatMode: "Chat",
  proOption: "Pro",
  ...patch,
});

const reservation = (patch: Json = {}): Json => ({
  ackRef: "ack-1",
  persistedAtMs: NOW - 60_000,
  planningId: "plan-1",
  submissionId: "sub-1",
  idempotencyKey: "idem-1",
  promptRevision: 2,
  promptSha256: PROMPT_SHA,
  missionId: "mission-1",
  missionRevision: 7,
  managerThreadId: MANAGER,
  managerEpoch: 3,
  recordRevision: 0,
  ...patch,
});

const completion = (patch: Json = {}): Json => ({
  receiptRef: "receipt-complete-1",
  verifiedAtMs: NOW - 5_000,
  planningId: "plan-1",
  submissionId: "sub-1",
  conversationRef: CONVERSATION,
  responseRef: RESPONSE,
  completionEvidenceSha256: hex("e"),
  responseSha256: hex("f"),
  accountRef: "acct-pro-1",
  workspaceRef: "ws-nofun",
  observedModel: "pro-model-1",
  observedMode: "Chat",
  pagesExpected: 3,
  pagesRetrieved: 3,
  requiredAttachmentHashes: [hex("1")],
  verifiedAttachmentHashes: [hex("1")],
  ...patch,
});

const submitEvidence = (): Json => ({ verification: verification(), reservation: reservation() });

const actor = (patch: Json = {}): Json => ({ managerThreadId: MANAGER, managerEpoch: 3, ...patch });
const event = (type: string, payload: Json = {}): Json => ({
  type,
  planningId: "plan-1",
  idempotencyKey: "idem-1",
  actor: actor(),
  ...payload,
});
const prepareEvent = (prepared: Json = preparedRecord()): Json => ({
  type: "prepare",
  actor: actor(),
  prepared,
});
const awaitEvent = (patch: Json = {}): Json =>
  event("await_response", {
    conversation: { conversationRef: CONVERSATION, source: "submit_ack" },
    wake: wake(),
    ...patch,
  });
const retrieveEvent = (patch: Json = {}): Json =>
  event("retrieve", { responseRef: RESPONSE, ...patch });
const reconcileEvent = (patch: Json = {}): Json =>
  event("reconcile", { reconciliation: reconciliation(patch) });

interface Run {
  readonly event: unknown;
  readonly current?: unknown;
  readonly facts?: unknown;
  readonly evidence?: unknown;
  readonly nowMs?: number;
}

const run = (input: Run): ProPlanningDecision =>
  advanceProPlanning({
    event: input.event,
    current: input.current ?? null,
    facts: input.facts ?? facts(),
    evidence: input.evidence,
    nowMs: input.nowMs ?? NOW,
  });

const reasonsOf = (decision: ProPlanningDecision): string[] => [...decision.reasons];

const expectRejected = (
  decision: ProPlanningDecision,
  kind: "hold" | "deny" | "noop",
  reasons: string[],
): void => {
  expect(decision.kind).toBe(kind);
  expect(reasonsOf(decision)).toStrictEqual(reasons);
  expect(decision.record).toBeNull();
  expect(decision.authority).toBe("proposal_only");
};

const advancedRecord = (decision: ProPlanningDecision) => {
  if (decision.kind !== "advance" || decision.record === null) {
    throw new Error(`expected advance, got ${decision.kind}: ${decision.reasons.join(",")}`);
  }
  return decision.record;
};

describe("MissionProPlanning lifecycle", () => {
  it("proposes each stage in order, feeding every proposed record back as the current one", () => {
    const prepared = run({ event: prepareEvent() });
    expect(prepared.action).toBe("persist_reservation");
    expect(prepared.guiLease).toBe("release");
    expect(prepared.pointer).toStrictEqual({
      planningId: "plan-1",
      submissionId: "sub-1",
      stage: "prepared",
      recordRevision: 0,
    });

    const submit = run({
      event: event("submit"),
      current: advancedRecord(prepared),
      evidence: submitEvidence(),
    });
    expect(submit.action).toBe("submit_prompt");
    expect(submit.guiLease).toBe("required");
    expect(advancedRecord(submit).stage).toBe("submitted");
    expect(advancedRecord(submit).revision).toBe(1);

    const pending = run({ event: awaitEvent(), current: advancedRecord(submit) });
    expect(pending.action).toBe("release_gui_and_wait");
    expect(pending.guiLease).toBe("release");
    expect(advancedRecord(pending).stage).toBe("response_pending");

    const woke = run({
      event: event("wake", { wakeKey: "wake-1" }),
      current: advancedRecord(pending),
    });
    expect(woke.kind).toBe("act");
    expect(woke.action).toBe("reacquire_gui_and_retrieve");
    expect(woke.guiLease).toBe("required");

    const retrieved = run({
      event: retrieveEvent(),
      current: advancedRecord(pending),
      evidence: { completion: completion() },
    });
    expect(retrieved.action).toBe("reconcile_response");
    expect(advancedRecord(retrieved).retrieval).toMatchObject({
      complete: true,
      paginationGaps: 0,
    });

    const reconciled = run({ event: reconcileEvent(), current: advancedRecord(retrieved) });
    expect(reconciled.action).toBe("rerun_admission");
    expect(advancedRecord(reconciled).stage).toBe("reconciled");
    expect(advancedRecord(reconciled).revision).toBe(4);
    expect(reconciled.authority).toBe("proposal_only");
  });

  it("rebinds to the rotated manager when the lower-epoch record advances", () => {
    const decision = run({
      event: event("submit"),
      current: preparedRecord({ managerThreadId: "thread:old", managerEpoch: 2 }),
      evidence: {
        verification: verification(),
        reservation: reservation({ managerThreadId: "thread:old", managerEpoch: 2 }),
      },
    });
    const record = advancedRecord(decision);
    expect(record.managerThreadId).toBe(MANAGER);
    expect(record.managerEpoch).toBe(3);
  });
});

describe("MissionProPlanning prepare", () => {
  const cases: ReadonlyArray<[string, Json, Json, string[]]> = [
    [
      "a non-prepared stage claim",
      preparedRecord({ stage: "submitted", revision: 1 }),
      facts(),
      ["stage_out_of_order"],
    ],
    [
      "mission revision drift",
      preparedRecord({ missionRevision: 6 }),
      facts(),
      ["mission_revision_mismatch"],
    ],
    ["another mission", preparedRecord({ missionId: "mission-2" }), facts(), ["mission_mismatch"]],
    ["another team", preparedRecord({ teamId: "team-other" }), facts(), ["team_mismatch"]],
    [
      "another environment",
      preparedRecord({ environmentId: "env-other" }),
      facts(),
      ["environment_mismatch"],
    ],
    ["a stale manager epoch", preparedRecord({ managerEpoch: 2 }), facts(), ["epoch_mismatch"]],
    [
      "a different thread at the current epoch",
      preparedRecord({ managerThreadId: "thread:x" }),
      facts(),
      ["manager_mismatch"],
    ],
    ["a paused mission", preparedRecord(), factsWith({ pauseRequested: true }), ["mission_paused"]],
    [
      "an inactive mission",
      preparedRecord(),
      factsWith({ status: "completed" }),
      ["mission_not_active"],
    ],
    ["a stopped mission", preparedRecord(), factsWith({ status: "stopped" }), ["mission_stopped"]],
  ];
  it.each(cases)("does not prepare against %s", (_name, prepared, withFacts, reasons) => {
    const decision = run({ event: prepareEvent(prepared), facts: withFacts });
    expect(decision.record).toBeNull();
    expect(reasonsOf(decision)).toStrictEqual(reasons);
    expect(["hold", "deny"]).toContain(decision.kind);
  });

  it("denies an actor that is not the current manager thread and epoch", () => {
    const stale = run({
      event: { ...prepareEvent(), actor: actor({ managerEpoch: 2 }) },
    });
    expectRejected(stale, "deny", ["epoch_mismatch"]);
    const other = run({
      event: { ...prepareEvent(), actor: actor({ managerThreadId: "thread:other" }) },
    });
    expectRejected(other, "deny", ["manager_mismatch"]);
  });
});

describe("MissionProPlanning submit gate", () => {
  const submit = (patch: Run = { event: event("submit") }): ProPlanningDecision =>
    run({ current: preparedRecord(), evidence: submitEvidence(), ...patch });

  it("never proposes the external submit from a prepared record alone", () => {
    for (const evidence of [
      { verification: verification() },
      { verification: verification(), reservation: { garbage: true } },
    ]) {
      const decision = submit({ event: event("submit"), evidence });
      expectRejected(decision, "hold", ["reservation_missing"]);
      expect(decision.action).toBe("persist_reservation");
    }
  });

  const forged: ReadonlyArray<[string, Json]> = [
    ["planning id", { planningId: "plan-2" }],
    ["submission id", { submissionId: "sub-2" }],
    ["idempotency key", { idempotencyKey: "idem-2" }],
    ["prompt digest", { promptSha256: hex("9") }],
    ["prompt revision", { promptRevision: 3 }],
    ["mission", { missionId: "mission-2" }],
    ["mission revision", { missionRevision: 6 }],
    ["manager thread", { managerThreadId: "thread:other" }],
    ["manager epoch", { managerEpoch: 4 }],
    ["persisted record revision", { recordRevision: 1 }],
  ];
  it.each(forged)("denies a reservation ACK bound to another %s", (_name, patch) => {
    const decision = submit({
      event: event("submit"),
      evidence: { verification: verification(), reservation: reservation(patch) },
    });
    expectRejected(decision, "deny", ["reservation_mismatch"]);
  });

  it("holds a reservation ACK stamped in the future", () => {
    const decision = submit({
      event: event("submit"),
      evidence: {
        verification: verification(),
        reservation: reservation({ persistedAtMs: NOW + PRO_PLANNING_MAX_CLOCK_SKEW_MS + 1 }),
      },
    });
    expectRejected(decision, "hold", ["evidence_from_future"]);
  });

  const wrongBinding: ReadonlyArray<[string, Json, string]> = [
    ["submission identity", { submissionId: "sub-2" }, "submission_mismatch"],
    ["prompt digest", { promptSha256: hex("9") }, "prompt_mismatch"],
    ["prompt revision", { promptRevision: 3 }, "prompt_mismatch"],
    ["account", { accountRef: "acct-other" }, "account_mismatch"],
    ["workspace", { workspaceRef: "ws-other" }, "workspace_mismatch"],
    ["Chat mode", { chatMode: "Agent" }, "chat_mode_mismatch"],
    ["exact Pro option", { proOption: "Pro Extended" }, "pro_option_mismatch"],
  ];
  it.each(wrongBinding)(
    "denies before any action when the verified %s differs",
    (_name, patch, reason) => {
      const decision = submit({
        event: event("submit"),
        evidence: { verification: verification(patch), reservation: reservation() },
      });
      expectRejected(decision, "deny", [reason]);
      expect(decision.action).toBe("operator_review");
    },
  );

  it("holds without an independent verification, and when it is stale or from the future", () => {
    expectRejected(
      submit({ event: event("submit"), evidence: { reservation: reservation() } }),
      "hold",
      ["verification_missing"],
    );
    const stale = verification({ verifiedAtMs: NOW - PRO_PLANNING_MAX_EVIDENCE_AGE_MS - 1 });
    expectRejected(
      submit({
        event: event("submit"),
        evidence: { verification: stale, reservation: reservation() },
      }),
      "hold",
      ["evidence_stale"],
    );
    const future = verification({ verifiedAtMs: NOW + PRO_PLANNING_MAX_CLOCK_SKEW_MS + 1 });
    expectRejected(
      submit({
        event: event("submit"),
        evidence: { verification: future, reservation: reservation() },
      }),
      "hold",
      ["evidence_from_future"],
    );
  });

  it("needs actual approval for this planning stage and exact prompt", () => {
    const withoutApproval = facts();
    delete withoutApproval.planningApproval;
    const missing = submit({ event: event("submit"), facts: withoutApproval });
    expectRejected(missing, "hold", ["approval_missing"]);
    expect(missing.action).toBe("request_user_approval");

    const otherPrompt = facts({
      planningApproval: {
        approvalRef: "approval-1",
        planningId: "plan-1",
        promptSha256: hex("9"),
        scopeDigest: SCOPE,
      },
    });
    expectRejected(submit({ event: event("submit"), facts: otherPrompt }), "deny", [
      "approval_mismatch",
    ]);
  });

  it("denies mission revision drift before submitting, and a stale or forged manager", () => {
    expectRejected(submit({ event: event("submit"), facts: factsWith({ revision: 8 }) }), "deny", [
      "mission_revision_mismatch",
    ]);
    expectRejected(
      submit({ event: event("submit"), facts: factsWith({ managerEpoch: 4 }) }),
      "deny",
      ["epoch_mismatch"],
    );
    expectRejected(
      submit({ event: { ...event("submit"), actor: actor({ managerEpoch: 2 }) } }),
      "deny",
      ["epoch_mismatch"],
    );
    expectRejected(
      submit({ event: event("submit"), facts: factsWith({ managerThreadId: "thread:other" }) }),
      "deny",
      ["manager_mismatch"],
    );
    expectRejected(submit({ event: event("submit", { planningId: "plan-2" }) }), "deny", [
      "identity_mismatch",
    ]);
  });

  it("holds under pause and inactive scope instead of submitting", () => {
    expectRejected(
      submit({ event: event("submit"), facts: factsWith({ pauseRequested: true }) }),
      "hold",
      ["mission_paused"],
    );
    expectRejected(
      submit({ event: event("submit"), facts: factsWith({ status: "paused" }) }),
      "hold",
      ["mission_paused"],
    );
    expectRejected(
      submit({ event: event("submit"), facts: factsWith({ status: "completed" }) }),
      "hold",
      ["mission_not_active"],
    );
  });

  it("keeps operator usage and the Chat response allowance separate, and unknown is not unlimited", () => {
    expectRejected(
      submit({ event: event("submit"), facts: factsWithUsage({ responseAllowance: "unknown" }) }),
      "hold",
      ["response_allowance_unknown"],
    );
    expectRejected(
      submit({ event: event("submit"), facts: factsWithUsage({ operatorBudget: "unknown" }) }),
      "hold",
      ["operator_budget_unknown"],
    );
    expectRejected(
      submit({
        event: event("submit"),
        facts: factsWithUsage({ operatorBudget: "exhausted", responseAllowance: "exhausted" }),
      }),
      "hold",
      ["operator_budget_exhausted", "response_allowance_exhausted"],
    );
    for (const usage of [
      { operatorBudget: "available", responseAllowance: "unlimited" },
      { operatorBudget: "available", responseAllowance: "available", unlimitedPro: true },
    ]) {
      expectRejected(submit({ event: event("submit"), facts: facts({ usage }) }), "hold", [
        "facts_malformed",
      ]);
    }
  });

  it("cancels instead of submitting when the mission is stopped", () => {
    for (const stopped of [{ stopRequested: true }, { status: "stopped" }]) {
      const decision = submit({ event: event("submit"), facts: factsWith(stopped) });
      expect(decision.kind).toBe("advance");
      expect(advancedRecord(decision)).toMatchObject({
        stage: "cancelled",
        cancelReason: "mission_stopped",
      });
      expect(decision.action).toBe("none");
      expect(decision.guiLease).toBe("release");
    }
  });
});

describe("MissionProPlanning lost acknowledgment and waiting", () => {
  it("locates the existing conversation and never submits again", () => {
    const decision = run({
      event: event("submit"),
      current: submittedRecord(),
      evidence: submitEvidence(),
    });
    expect(decision.kind).toBe("act");
    expect(decision.action).toBe("locate_existing");
    expect(decision.guiLease).toBe("required");
    expect(decision.record).toBeNull();
    expect(decision.pointer).toStrictEqual({
      planningId: "plan-1",
      submissionId: "sub-1",
      stage: "submitted",
      recordRevision: 1,
    });
    expect(run({ event: event("submit"), current: submittedRecord() })).toStrictEqual(decision);
    expectRejected(
      run({
        event: event("submit"),
        current: submittedRecord(),
        facts: factsWithUsage({ operatorBudget: "unknown" }),
      }),
      "hold",
      ["operator_budget_unknown"],
    );
  });

  it("records a located conversation as the pointer to resume from", () => {
    const decision = run({
      event: awaitEvent({ conversation: { conversationRef: CONVERSATION, source: "located" } }),
      current: submittedRecord(),
    });
    expect(advancedRecord(decision).conversation).toStrictEqual({
      conversationRef: CONVERSATION,
      source: "located",
    });
  });

  it("releases the GUI with a bounded wake cursor while the response is pending", () => {
    const decision = run({ event: awaitEvent(), current: submittedRecord() });
    expect(decision.guiLease).toBe("release");
    expect(decision.action).toBe("release_gui_and_wait");
    const cursor = advancedRecord(decision).wake;
    expect(cursor).toStrictEqual(wake());
  });

  it("refuses an unbounded, expired, or oversized wait", () => {
    const expired = run({
      event: awaitEvent({ wake: wake({ notBeforeMs: NOW - 10_000, expiresAtMs: NOW }) }),
      current: submittedRecord(),
    });
    expectRejected(expired, "hold", ["wake_window_invalid"]);
    const tooFar = run({
      event: awaitEvent({
        wake: wake({ notBeforeMs: NOW, expiresAtMs: NOW + 24 * 60 * 60_000 + 1 }),
      }),
      current: submittedRecord(),
    });
    expectRejected(tooFar, "hold", ["input_malformed"]);
    const farFuture = run({
      event: awaitEvent({
        wake: wake({
          notBeforeMs: NOW + 48 * 60 * 60_000,
          expiresAtMs: NOW + 48 * 60 * 60_000 + 60_000,
        }),
      }),
      current: submittedRecord(),
    });
    expectRejected(farFuture, "hold", ["wake_window_invalid"]);
  });

  it("acts on a due wake, and waits when it is early or expired", () => {
    const wakeEvent = event("wake", { wakeKey: "wake-1" });
    const due = run({ event: wakeEvent, current: pendingRecord() });
    expect(due.kind).toBe("act");
    expect(due.action).toBe("reacquire_gui_and_retrieve");

    const early = run({
      event: wakeEvent,
      current: pendingRecord({ wake: wake({ notBeforeMs: NOW + 60_000 }) }),
    });
    expectRejected(early, "hold", ["wake_not_due"]);
    expect(early.guiLease).toBe("release");

    const late = run({
      event: wakeEvent,
      current: pendingRecord({ wake: wake({ notBeforeMs: NOW - 10_000, expiresAtMs: NOW - 1 }) }),
    });
    expectRejected(late, "hold", ["wake_expired"]);
    expect(late.action).toBe("operator_review");
  });

  it("returns the stable pointer for a stale wake and denies a wake from a stale epoch", () => {
    const stale = run({ event: event("wake", { wakeKey: "wake-old" }), current: pendingRecord() });
    expectRejected(stale, "noop", ["stale_event"]);
    expect(stale.pointer?.stage).toBe("response_pending");
    expect(stale.action).toBe("none");

    const wrongEpoch = run({
      event: { ...event("wake", { wakeKey: "wake-1" }), actor: actor({ managerEpoch: 2 }) },
      current: pendingRecord(),
    });
    expectRejected(wrongEpoch, "deny", ["epoch_mismatch"]);
  });

  it("only needs operator usage to wake: the response allowance is not consulted", () => {
    const wakeEvent = event("wake", { wakeKey: "wake-1" });
    const allowanceUnknown = run({
      event: wakeEvent,
      current: pendingRecord(),
      facts: factsWithUsage({ responseAllowance: "unknown" }),
    });
    expect(allowanceUnknown.kind).toBe("act");
    expectRejected(
      run({
        event: wakeEvent,
        current: pendingRecord(),
        facts: factsWithUsage({ operatorBudget: "exhausted" }),
      }),
      "hold",
      ["operator_budget_exhausted"],
    );
  });
});

describe("MissionProPlanning cancellation and terminal stages", () => {
  it("cancels an open stage and treats a replayed cancel as already applied", () => {
    const cancelled = run({
      event: event("cancel", { reason: "operator_cancel" }),
      current: pendingRecord(),
    });
    expect(advancedRecord(cancelled)).toMatchObject({
      stage: "cancelled",
      cancelReason: "operator_cancel",
      revision: 3,
    });
    expect(cancelled.action).toBe("none");

    const replay = run({
      event: event("cancel", { reason: "operator_cancel" }),
      current: cancelledRecord(),
    });
    expectRejected(replay, "noop", ["already_applied"]);
  });

  it("still cancels while the mission is paused", () => {
    const decision = run({
      event: event("cancel", { reason: "operator_cancel" }),
      current: pendingRecord(),
      facts: factsWith({ pauseRequested: true }),
    });
    expect(advancedRecord(decision).stage).toBe("cancelled");
  });

  it("cannot restart a cancelled planning stage from a stale wake, submit, or late completion", () => {
    const attempts: ReadonlyArray<[Json, Json | undefined, string]> = [
      [event("wake", { wakeKey: "wake-1" }), undefined, "terminal_stage"],
      [event("submit"), submitEvidence(), "terminal_stage"],
      [retrieveEvent(), { completion: completion() }, "terminal_stage"],
      [reconcileEvent(), undefined, "terminal_stage"],
      // The stored pending pointers are carried onto the cancelled record, so
      // this exact replay is recognized instead of reopening the wait.
      [awaitEvent(), undefined, "already_applied"],
    ];
    for (const [claim, evidence, reason] of attempts) {
      const decision = run({ event: claim, current: cancelledRecord(), evidence });
      expectRejected(decision, "noop", [reason]);
      expect(decision.pointer).toStrictEqual({
        planningId: "plan-1",
        submissionId: "sub-1",
        stage: "cancelled",
        recordRevision: 3,
      });
      expect(decision.action).toBe("none");
    }
  });

  it.each(["unknown", "exhausted"])("holds retrieval when operator budget is %s", (budget) => {
    const decision = run({
      event: retrieveEvent(),
      current: pendingRecord(),
      facts: factsWithUsage({ operatorBudget: budget }),
      evidence: { completion: completion({ pagesExpected: 2, pagesRetrieved: 1 }) },
    });
    expectRejected(decision, "hold", [`operator_budget_${budget}`]);
    expect(decision.action).toBe("operator_review");
    expect(decision.guiLease).toBe("release");
  });

  it("lets cancellation win over a valid late completion when the mission is stopped", () => {
    const decision = run({
      event: retrieveEvent(),
      current: pendingRecord(),
      evidence: { completion: completion() },
      facts: factsWith({ stopRequested: true }),
    });
    expect(advancedRecord(decision)).toMatchObject({
      stage: "cancelled",
      cancelReason: "mission_stopped",
    });
  });

  it("does not resume a blocked or reconciled stage", () => {
    for (const current of [blockedRecord(), reconciledRecord()]) {
      const decision = run({
        event: retrieveEvent(),
        current,
        evidence: { completion: completion() },
      });
      expect(decision.kind).toBe("noop");
      expect(decision.record).toBeNull();
    }
  });

  it("records an explicit block from an open stage", () => {
    const decision = run({
      event: event("block", { reason: "operator_hold" }),
      current: submittedRecord(),
    });
    expect(advancedRecord(decision)).toMatchObject({
      stage: "blocked",
      blockReason: "operator_hold",
    });
    expect(decision.action).toBe("operator_review");
  });
});

describe("MissionProPlanning retrieval", () => {
  const retrieve = (patch: Json = {}, withFacts: Json = facts()): ProPlanningDecision =>
    run({
      event: retrieveEvent(),
      current: pendingRecord(),
      evidence: { completion: completion(patch) },
      facts: withFacts,
    });

  it("advances only on the full response with verified attachments and the requested model and mode", () => {
    const decision = retrieve();
    expect(advancedRecord(decision).retrieval).toStrictEqual(retrieval());
    expect(advancedRecord(decision).stage).toBe("retrieved");
  });

  it("holds on pagination gaps and continues retrieval", () => {
    for (const patch of [{ pagesRetrieved: 2 }, { pagesExpected: 0, pagesRetrieved: 0 }]) {
      const decision = retrieve(patch);
      expectRejected(decision, "hold", ["pagination_gap"]);
      expect(decision.action).toBe("continue_retrieval");
      expect(decision.guiLease).toBe("required");
    }
    expectRejected(retrieve({ pagesRetrieved: 4 }), "deny", ["coverage_inconsistent"]);
  });

  it("holds when a required attachment is missing or not hash-verified", () => {
    const missing = retrieve({
      requiredAttachmentHashes: [hex("1"), hex("2")],
      verifiedAttachmentHashes: [hex("1")],
    });
    expectRejected(missing, "hold", ["attachment_incomplete"]);
    const both = retrieve({
      pagesRetrieved: 1,
      requiredAttachmentHashes: [hex("1")],
      verifiedAttachmentHashes: [],
    });
    expectRejected(both, "hold", ["pagination_gap", "attachment_incomplete"]);
  });

  it("does not accept a response pointer without a verified completion receipt", () => {
    const decision = run({ event: retrieveEvent(), current: pendingRecord(), evidence: {} });
    expectRejected(decision, "hold", ["completion_missing"]);
  });

  const mismatches: ReadonlyArray<[string, Json, string]> = [
    [
      "conversation",
      { conversationRef: "https://chat.example.test/c/other" },
      "conversation_mismatch",
    ],
    [
      "response",
      { responseRef: "https://chat.example.test/c/abc/response/9" },
      "response_mismatch",
    ],
    ["account", { accountRef: "acct-other" }, "account_mismatch"],
    ["workspace", { workspaceRef: "ws-other" }, "workspace_mismatch"],
    ["planning", { planningId: "plan-2" }, "identity_mismatch"],
    ["submission", { submissionId: "sub-2" }, "submission_mismatch"],
  ];
  it.each(mismatches)("denies a completion receipt for another %s", (_name, patch, reason) => {
    expectRejected(retrieve(patch), "deny", [reason]);
  });

  it("holds on a stale completion receipt", () => {
    const stale = retrieve({ verifiedAtMs: NOW - PRO_PLANNING_MAX_EVIDENCE_AGE_MS - 1 });
    expectRejected(stale, "hold", ["evidence_stale"]);
  });

  it("blocks a model fallback or wrong Chat mode instead of counting it as the requested run", () => {
    const fallback = retrieve({ observedModel: "fallback-mini" });
    expect(advancedRecord(fallback)).toMatchObject({
      stage: "blocked",
      blockReason: "model_fallback",
    });
    expect(advancedRecord(fallback).retrieval).toBeUndefined();
    expect(fallback.action).toBe("operator_review");

    const mode = retrieve({ observedMode: "Agent" });
    expect(advancedRecord(mode)).toMatchObject({ stage: "blocked", blockReason: "mode_mismatch" });
  });

  it("holds when the resulting model or mode is not visible", () => {
    expectRejected(retrieve({ observedModel: null }), "hold", ["model_unverified"]);
    expectRejected(retrieve({ observedMode: null }), "hold", ["model_unverified"]);
  });
});

describe("MissionProPlanning reconciliation", () => {
  const reconcile = (patch: Json = {}, withFacts: Json = facts()): ProPlanningDecision =>
    run({ event: reconcileEvent(patch), current: retrievedRecord(), facts: withFacts });

  it("proposes a reconciled revision and still requires a fresh admission before coding", () => {
    const decision = reconcile();
    const record = advancedRecord(decision);
    expect(record.reconciliation).toStrictEqual(reconciliation());
    expect(decision.action).toBe("rerun_admission");
    expect(decision.authority).toBe("proposal_only");
    expect(Object.keys(decision)).not.toContain("codingAuthorized");
  });

  it("holds an authority or scope change until a separate actual approval exists", () => {
    const changed = { scopeDigest: hex("9") };
    const unapproved = reconcile(changed);
    expectRejected(unapproved, "hold", ["scope_change_unapproved"]);
    expect(unapproved.action).toBe("request_user_approval");

    const approved = reconcile(
      changed,
      facts({
        scopeChangeApproval: {
          approvalRef: "approval-2",
          planningId: "plan-1",
          scopeDigest: hex("9"),
        },
      }),
    );
    expect(advancedRecord(approved).stage).toBe("reconciled");

    const wrongScope = reconcile(
      changed,
      facts({
        scopeChangeApproval: {
          approvalRef: "approval-2",
          planningId: "plan-1",
          scopeDigest: hex("8"),
        },
      }),
    );
    expectRejected(wrongScope, "deny", ["approval_mismatch"]);
  });

  it("holds when the acceptance or the verified constraint is no longer current", () => {
    expectRejected(reconcile({}, factsWith({ acceptanceDigest: hex("8") })), "hold", [
      "acceptance_changed",
    ]);
    // The mission moved on while Pro was thinking: the reconciliation must be against now.
    expectRejected(reconcile({}, factsWith({ revision: 8 })), "hold", ["constraint_stale"]);
    expectRejected(reconcile({ recommendationRef: "https://chat.example.test/c/other" }), "deny", [
      "recommendation_mismatch",
    ]);
  });

  it("does not reconcile without the planning approval", () => {
    const withoutApproval = facts();
    delete withoutApproval.planningApproval;
    expectRejected(reconcile({}, withoutApproval), "hold", ["approval_missing"]);
  });
});

describe("MissionProPlanning replay and ordering", () => {
  const replays: ReadonlyArray<[string, Json, Json, string]> = [
    ["prepare", prepareEvent(), preparedRecord(), "prepared"],
    ["prepare after later stages", prepareEvent(), retrievedRecord(), "retrieved"],
    ["await_response", awaitEvent(), pendingRecord(), "response_pending"],
    ["retrieve", retrieveEvent(), retrievedRecord(), "retrieved"],
    ["reconcile", reconcileEvent(), reconciledRecord(), "reconciled"],
  ];
  it.each(replays)(
    "treats an exact %s replay as already applied at the stable pointer",
    (_name, claim, current, stage) => {
      const decision = run({ event: claim, current });
      expectRejected(decision, "noop", ["already_applied"]);
      expect(decision.pointer?.stage).toBe(stage);
      expect(decision.action).toBe("none");
    },
  );

  const conflicts: ReadonlyArray<[string, Json, Json]> = [
    [
      "prepare with a changed prompt digest",
      prepareEvent(
        preparedRecord({ prompt: { ...(preparedRecord().prompt as Json), sha256: hex("9") } }),
      ),
      preparedRecord(),
    ],
    [
      "await_response with a changed conversation",
      awaitEvent({
        conversation: {
          conversationRef: "https://chat.example.test/c/other",
          source: "submit_ack",
        },
      }),
      pendingRecord(),
    ],
    [
      "retrieve with a changed response",
      retrieveEvent({ responseRef: "https://chat.example.test/r/2" }),
      retrievedRecord(),
    ],
    [
      "reconcile with a changed proposal revision",
      reconcileEvent({ proposalRevision: 2 }),
      reconciledRecord(),
    ],
  ];
  it.each(conflicts)("denies the same key with changed bytes: %s", (_name, claim, current) => {
    expectRejected(run({ event: claim, current }), "deny", ["idempotency_conflict"]);
  });

  it("denies another planning identity for the same record", () => {
    expectRejected(
      run({
        event: event("submit", { idempotencyKey: "idem-2" }),
        current: preparedRecord(),
        evidence: submitEvidence(),
      }),
      "deny",
      ["identity_mismatch"],
    );
    expectRejected(
      run({
        event: prepareEvent(preparedRecord({ planningId: "plan-2" })),
        current: preparedRecord(),
      }),
      "deny",
      ["identity_mismatch"],
    );
  });

  it("denies events that skip a stage and returns the pointer for stale ones", () => {
    expectRejected(run({ event: retrieveEvent(), current: submittedRecord() }), "deny", [
      "stage_out_of_order",
    ]);
    expectRejected(run({ event: awaitEvent(), current: preparedRecord() }), "deny", [
      "stage_out_of_order",
    ]);
    expectRejected(run({ event: reconcileEvent(), current: pendingRecord() }), "deny", [
      "stage_out_of_order",
    ]);
    expectRejected(
      run({ event: event("wake", { wakeKey: "wake-1" }), current: retrievedRecord() }),
      "noop",
      ["stale_event"],
    );
    expectRejected(
      run({ event: event("submit"), current: pendingRecord(), evidence: submitEvidence() }),
      "noop",
      ["stale_event"],
    );
  });

  it("holds an event for a record that does not exist yet", () => {
    expectRejected(run({ event: event("submit"), evidence: submitEvidence() }), "hold", [
      "record_missing",
    ]);
  });
});

describe("MissionProPlanning malformed, oversized, and unsafe input", () => {
  it("holds on an invalid clock", () => {
    for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 2 ** 53, "now" as never]) {
      expectRejected(
        advanceProPlanning({ event: prepareEvent(), current: null, facts: facts(), nowMs }),
        "hold",
        ["clock_invalid"],
      );
    }
  });

  it("holds on missing, malformed, stale, or future trusted facts", () => {
    expectRejected(
      advanceProPlanning({ event: prepareEvent(), current: null, facts: undefined, nowMs: NOW }),
      "hold",
      ["facts_malformed"],
    );
    expectRejected(
      run({ event: prepareEvent(), facts: { ...facts(), mission: { revision: 7 } } }),
      "hold",
      ["facts_malformed"],
    );
    expectRejected(
      run({
        event: prepareEvent(),
        facts: facts({ observedAtMs: NOW - PRO_PLANNING_MAX_EVIDENCE_AGE_MS - 1 }),
      }),
      "hold",
      ["facts_stale"],
    );
    expectRejected(
      run({
        event: prepareEvent(),
        facts: facts({ observedAtMs: NOW + PRO_PLANNING_MAX_CLOCK_SKEW_MS + 1 }),
      }),
      "hold",
      ["facts_from_future"],
    );
  });

  it("does not take a body boolean as authority", () => {
    const forgedFacts = facts();
    (forgedFacts.mission as Json).planningAuthorized = true;
    expectRejected(run({ event: prepareEvent(), facts: forgedFacts }), "hold", ["facts_malformed"]);
    expectRejected(
      run({ event: prepareEvent(preparedRecord({ reservationPersisted: true })) }),
      "hold",
      ["input_malformed"],
    );
  });

  const malformedPrepared: ReadonlyArray<[string, Json]> = [
    [
      "65 attachment hashes",
      {
        prompt: {
          ...(preparedRecord().prompt as Json),
          attachmentHashes: Array.from({ length: 65 }, (_, i) => i.toString(16).padStart(64, "0")),
        },
      },
    ],
    [
      "65 source pointers",
      {
        prompt: {
          ...(preparedRecord().prompt as Json),
          sourcePointers: Array.from({ length: 65 }, (_, i) => `https://example.test/${i}`),
        },
      },
    ],
    [
      "duplicate attachment hashes",
      { prompt: { ...(preparedRecord().prompt as Json), attachmentHashes: [hex("b"), hex("b")] } },
    ],
    [
      "an upper-case digest",
      { prompt: { ...(preparedRecord().prompt as Json), sha256: "A".repeat(64) } },
    ],
    [
      "a prompt body",
      { prompt: { ...(preparedRecord().prompt as Json), text: "the whole prompt" } },
    ],
    ["a body key on the record", { promptBody: "the whole prompt" }],
    ["an unsafe mission revision", { missionRevision: 2 ** 53 }],
    ["a fractional manager epoch", { managerEpoch: 1.5 }],
    [
      "a negative prompt revision",
      { prompt: { ...(preparedRecord().prompt as Json), revision: -1 } },
    ],
    ["a 513 character planning id", { planningId: "p".repeat(513) }],
    ["an id with edge whitespace", { planningId: " plan-1" }],
    ["an id with a control character", { submissionId: "sub\u0000-1" }],
    ["an email as the account", { route: { ...route(), accountRef: "jimmy@nofun.io" } }],
    [
      "a credential-like workspace label",
      { route: { ...route(), workspaceRef: "sk-live-abcdefghijklmnopqrstuvwx" } },
    ],
    [
      "a source pointer with a query",
      {
        prompt: {
          ...(preparedRecord().prompt as Json),
          sourcePointers: ["https://example.test/spec?token=abc"],
        },
      },
    ],
    [
      "a source pointer with userinfo",
      {
        prompt: {
          ...(preparedRecord().prompt as Json),
          sourcePointers: ["https://user:pw@example.test/spec"],
        },
      },
    ],
    ["a record revision beyond the bound", { revision: MAX_PRO_PLANNING_RECORD_REVISION + 1 }],
    [
      "a conversation on a prepared record",
      { conversation: { conversationRef: CONVERSATION, source: "submit_ack" } },
    ],
    ["a pending stage without its cursor", { stage: "response_pending", revision: 2 }],
  ];
  it.each(malformedPrepared)("rejects %s", (_name, patch) => {
    expectRejected(run({ event: prepareEvent(preparedRecord(patch)) }), "hold", [
      "input_malformed",
    ]);
  });

  it("rejects a wake window that is not a finite forward window", () => {
    for (const patch of [
      { notBeforeMs: NOW, expiresAtMs: NOW },
      { notBeforeMs: NOW, expiresAtMs: 2 ** 53 },
    ]) {
      expectRejected(
        run({ event: awaitEvent({ wake: wake(patch) }), current: submittedRecord() }),
        "hold",
        ["input_malformed"],
      );
    }
  });

  it("rejects an inconsistent retrieved record: a complete flag with gaps, or a fallback model", () => {
    const inconsistent = [
      retrievedRecord({ retrieval: retrieval({ complete: true, paginationGaps: 2 }) }),
      retrievedRecord({ retrieval: retrieval({ complete: false }) }),
      retrievedRecord({ retrieval: retrieval({ observedModel: "fallback-mini" }) }),
    ];
    for (const current of inconsistent) {
      expectRejected(run({ event: reconcileEvent(), current }), "hold", ["record_malformed"]);
    }
  });

  it("holds when advancing would exceed the record revision bound", () => {
    const atBound = run({
      event: event("submit"),
      current: preparedRecord({ revision: MAX_PRO_PLANNING_RECORD_REVISION }),
      evidence: {
        verification: verification(),
        reservation: reservation({ recordRevision: MAX_PRO_PLANNING_RECORD_REVISION }),
      },
    });
    expectRejected(atBound, "hold", ["counter_overflow"]);
  });

  it("never throws on hostile or non-object input", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
        has() {
          throw new Error("boom");
        },
        ownKeys() {
          throw new Error("boom");
        },
      },
    );
    const throwingGetter = Object.defineProperty({ ...prepareEvent() }, "actor", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    for (const input of [hostile, null, undefined, "text", 42, []]) {
      const decision = advanceProPlanning(input as never);
      expect(decision.kind).toBe("hold");
      expect(decision.record).toBeNull();
    }
    expect(run({ event: throwingGetter }).kind).toBe("hold");
    expect(run({ event: prepareEvent(), current: hostile }).kind).toBe("hold");
    expect(run({ event: event("submit"), current: preparedRecord(), evidence: hostile }).kind).toBe(
      "hold",
    );
  });
});

describe("MissionProPlanning outputs", () => {
  it("returns detached, deeply frozen decisions and never mutates the inputs", () => {
    const prepared = preparedRecord();
    const claim = prepareEvent(prepared);
    const before = JSON.stringify(claim);
    const decision = run({ event: claim });
    const record = advancedRecord(decision);

    expect(JSON.stringify(claim)).toBe(before);
    expect(Object.isFrozen(prepared)).toBe(false);
    for (const value of [
      decision,
      decision.reasons,
      decision.pointer,
      record,
      record.route,
      record.prompt,
      record.prompt.sourcePointers,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }

    (prepared.prompt as Json).sha256 = hex("9");
    ((prepared.prompt as Json).sourcePointers as string[]).push("https://example.test/late");
    expect(record.prompt.sha256).toBe(PROMPT_SHA);
    expect(record.prompt.sourcePointers).toStrictEqual(["https://example.test/spec"]);
  });

  it("keeps opaque identifiers byte-for-byte and gives the same answer for the same input", () => {
    const first = run({ event: prepareEvent() });
    expect(advancedRecord(first).managerThreadId).toBe(MANAGER);
    expect(run({ event: prepareEvent() })).toStrictEqual(first);
  });

  it("reports every applicable reason in a stable order", () => {
    const decision = run({
      event: event("submit"),
      current: preparedRecord(),
      evidence: {},
      facts: factsWithUsage({ operatorBudget: "unknown", responseAllowance: "unknown" }),
    });
    expect(reasonsOf(decision)).toStrictEqual([
      "verification_missing",
      "reservation_missing",
      "operator_budget_unknown",
      "response_allowance_unknown",
    ]);
  });
});

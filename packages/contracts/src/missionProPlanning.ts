import * as Schema from "effect/Schema";

import { Sha256Hex } from "./missionRetro.ts";

/**
 * Leaf wire schemas for the bounded ChatGPT Pro planning stage (P5 source
 * slice; spec: PRO-PLANNING.md). The server's pure guard
 * (`MissionProPlanning.ts`) decodes `unknown` input with these and returns a
 * bounded proposal; nothing here stores, schedules, or talks to ChatGPT.
 *
 * The record is a small state POINTER into the existing canonical mission
 * (mission id, observed revision, team, environment, current manager thread
 * and epoch), not a second plan store. It carries identities, digests, and
 * opaque pointers only: no prompt or response bodies, expected answers,
 * provider keys, environment variables, emails, sessions, or cookies.
 *
 * Persistence is future work: the owning store (expected to be the existing
 * mission store and admission path) is not wired here, and no store, event,
 * command, transport, or MCP change ships with this leaf. A record accepted
 * by this codec is a candidate, never proof that anything was persisted or
 * authorized; the guard asks for a separate persisted-reservation ACK before
 * it will ever propose the external submit.
 *
 * Trust model. Anything in `ProPlanningEvent` and in a record body is an
 * untrusted stage claim. `ProPlanningFacts`, `ProPlanningSubmitVerification`,
 * `ProPlanningReservationAck`, and `ProPlanningCompletionReceipt` are facts a
 * trusted producer established separately (canonical mission read, the
 * independent GUI verification, the owning store's ACK). Identifiers are
 * bounded opaque strings compared byte-for-byte: never trimmed, normalized,
 * or decoded, so a padded or aliased value cannot silently become an equal one.
 */

export const PRO_PLANNING_SCHEMA_VERSION = 1;

/** Longest accepted opaque identifier or pointer, including manager thread ids. */
export const MAX_PRO_PLANNING_ID_LENGTH = 512;
/** Longest accepted account/workspace/mode/model label. */
export const MAX_PRO_PLANNING_LABEL_LENGTH = 128;
/** Most source pointers or attachment hashes one list may carry. */
export const MAX_PRO_PLANNING_LIST_ENTRIES = 64;
/** Records advance one step per transition; far above the six real stages. */
export const MAX_PRO_PLANNING_RECORD_REVISION = 64;
/** Longest bounded wait a wake cursor may describe. */
export const MAX_PRO_PLANNING_WAKE_WINDOW_MS = 24 * 60 * 60_000;

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

/** Heuristic guard so tokens and bearer strings are never stored as pointers or labels. */
const looksLikeCredential = (value: string): boolean =>
  /(?:^|[^A-Za-z0-9])(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}/.test(value) ||
  /eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}/.test(value) ||
  /bearer\s/i.test(value);

const isSafeNonNegative = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/** Safe non-negative integer: counters, revisions, epochs, and epoch-millisecond times. */
export const ProPlanningCount = Schema.Int.check(
  Schema.makeFilter(isSafeNonNegative, { expected: "a safe non-negative integer" }),
);
export type ProPlanningCount = typeof ProPlanningCount.Type;

/** Bounded opaque identifier: 1..512 chars, no control characters, no edge whitespace. */
export const ProPlanningId = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.length >= 1 &&
      value.length <= MAX_PRO_PLANNING_ID_LENGTH &&
      value === value.trim() &&
      !hasControlCharacter(value),
    { expected: "a bounded opaque identifier without control characters or edge whitespace" },
  ),
);
export type ProPlanningId = typeof ProPlanningId.Type;

/**
 * Opaque pointer (URL, conversation, response, receipt, or artifact ref).
 * No whitespace, userinfo, query, or fragment, so credentials and session
 * tokens cannot ride along in the pointer.
 */
export const ProPlanningRef = ProPlanningId.check(
  Schema.makeFilter((value) => !/[\s@?#]/.test(value) && !looksLikeCredential(value), {
    expected: "a pointer without whitespace, '@', '?', '#', or credential-like text",
  }),
);
export type ProPlanningRef = typeof ProPlanningRef.Type;

/**
 * Account, workspace, Chat mode, Pro option, or model label. Metadata only:
 * the charset excludes '@' so an email address can never be stored here.
 */
export const ProPlanningLabel = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.length <= MAX_PRO_PLANNING_LABEL_LENGTH &&
      /^[A-Za-z0-9][A-Za-z0-9 ._:/+()-]*$/.test(value) &&
      value === value.trim() &&
      !looksLikeCredential(value),
    { expected: "a short label without '@', control characters, or credential-like text" },
  ),
);
export type ProPlanningLabel = typeof ProPlanningLabel.Type;

const isBoundedUnique = (values: ReadonlyArray<unknown>): boolean =>
  values.length <= MAX_PRO_PLANNING_LIST_ENTRIES && new Set(values).size === values.length;

const boundedUniqueExpectation = {
  expected: `at most ${MAX_PRO_PLANNING_LIST_ENTRIES} unique entries`,
};

export const ProPlanningRefList = Schema.Array(ProPlanningRef).check(
  Schema.makeFilter(isBoundedUnique, boundedUniqueExpectation),
);
export const ProPlanningHashList = Schema.Array(Sha256Hex).check(
  Schema.makeFilter(isBoundedUnique, boundedUniqueExpectation),
);

export const ProPlanningStage = Schema.Literals([
  "prepared",
  "submitted",
  "response_pending",
  "retrieved",
  "reconciled",
  "blocked",
  "cancelled",
]);
export type ProPlanningStage = typeof ProPlanningStage.Type;

/** Blocked is an explicit terminal outcome; a new planning attempt needs a new identity. */
export const ProPlanningBlockReason = Schema.Literals([
  "operator_hold",
  "model_fallback",
  "mode_mismatch",
]);
export type ProPlanningBlockReason = typeof ProPlanningBlockReason.Type;

export const ProPlanningCancelReason = Schema.Literals(["operator_cancel", "mission_stopped"]);
export type ProPlanningCancelReason = typeof ProPlanningCancelReason.Type;

/**
 * Finite next actions a decision may recommend. These are recommendations
 * for the owning adapter, never executed here.
 */
export const ProPlanningAction = Schema.Literals([
  "persist_reservation",
  "submit_prompt",
  "locate_existing",
  "release_gui_and_wait",
  "reacquire_gui_and_retrieve",
  "continue_retrieval",
  "reconcile_response",
  "rerun_admission",
  "request_user_approval",
  "refresh_facts",
  "operator_review",
  "none",
]);
export type ProPlanningAction = typeof ProPlanningAction.Type;

/** Finite reasons a guard decision may return. Severity is server policy. */
export const ProPlanningReasonCode = Schema.Literals([
  // Inputs, clock, and freshness
  "clock_invalid",
  "input_malformed",
  "facts_malformed",
  "record_malformed",
  "record_missing",
  "facts_stale",
  "facts_from_future",
  "evidence_stale",
  "evidence_from_future",
  "counter_overflow",
  "verifier_fault",
  // Canonical scope
  "mission_mismatch",
  "team_mismatch",
  "environment_mismatch",
  "mission_revision_mismatch",
  "manager_mismatch",
  "epoch_mismatch",
  "identity_mismatch",
  "idempotency_conflict",
  "stage_out_of_order",
  "mission_paused",
  "mission_not_active",
  "mission_stopped",
  // Submit gate
  "approval_missing",
  "approval_mismatch",
  "verification_missing",
  "submission_mismatch",
  "prompt_mismatch",
  "account_mismatch",
  "workspace_mismatch",
  "chat_mode_mismatch",
  "pro_option_mismatch",
  "reservation_missing",
  "reservation_mismatch",
  "operator_budget_unknown",
  "operator_budget_exhausted",
  "response_allowance_unknown",
  "response_allowance_exhausted",
  // Waiting
  "wake_window_invalid",
  "wake_not_due",
  "wake_expired",
  // Retrieval
  "completion_missing",
  "conversation_mismatch",
  "response_mismatch",
  "model_unverified",
  "pagination_gap",
  "attachment_incomplete",
  "coverage_inconsistent",
  // Reconciliation
  "recommendation_mismatch",
  "constraint_stale",
  "acceptance_changed",
  "scope_change_unapproved",
  // Stable no-ops
  "already_applied",
  "stale_event",
  "terminal_stage",
]);
export type ProPlanningReasonCode = typeof ProPlanningReasonCode.Type;

// ---------------------------------------------------------------------------
// Persisted-shape record
// ---------------------------------------------------------------------------

/** The exact requested route. Compared byte-for-byte; a fallback is not this run. */
export const ProPlanningRoute = Schema.Struct({
  accountRef: ProPlanningLabel,
  workspaceRef: ProPlanningLabel,
  chatMode: ProPlanningLabel,
  proOption: ProPlanningLabel,
  model: ProPlanningLabel,
});
export type ProPlanningRoute = typeof ProPlanningRoute.Type;

/** Prompt identity: revision, digest, source pointers, and attachment hashes. No body. */
export const ProPlanningPrompt = Schema.Struct({
  revision: ProPlanningCount,
  sha256: Sha256Hex,
  sourcePointers: ProPlanningRefList,
  attachmentHashes: ProPlanningHashList,
});
export type ProPlanningPrompt = typeof ProPlanningPrompt.Type;

export const ProPlanningConversation = Schema.Struct({
  conversationRef: ProPlanningRef,
  /** `located` means found again after a lost submission ACK. */
  source: Schema.Literals(["submit_ack", "located"]),
});
export type ProPlanningConversation = typeof ProPlanningConversation.Type;

/**
 * Bounded resume cursor for the wait. A wake carrying a different key is
 * stale; the window is finite so an unknown clock or lost wake never waits
 * forever. Scheduling the actual timer is the existing runtime wake's job.
 */
export const ProPlanningWakeCursor = Schema.Struct({
  wakeKey: ProPlanningId,
  notBeforeMs: ProPlanningCount,
  expiresAtMs: ProPlanningCount,
}).check(
  Schema.makeFilter(
    (cursor) =>
      cursor.notBeforeMs < cursor.expiresAtMs &&
      cursor.expiresAtMs - cursor.notBeforeMs <= MAX_PRO_PLANNING_WAKE_WINDOW_MS,
    { expected: `a wake window of at most ${MAX_PRO_PLANNING_WAKE_WINDOW_MS}ms` },
  ),
);
export type ProPlanningWakeCursor = typeof ProPlanningWakeCursor.Type;

const coversRequired = (
  required: ReadonlyArray<string>,
  verified: ReadonlyArray<string>,
): boolean => {
  const have = new Set(verified);
  return required.every((hash) => have.has(hash));
};

/**
 * Retrieved response coverage. `complete` is derived, never trusted: the
 * codec rejects a flag that disagrees with the gaps and verified hashes.
 */
export const ProPlanningRetrieval = Schema.Struct({
  responseRef: ProPlanningRef,
  completionEvidenceSha256: Sha256Hex,
  responseSha256: Sha256Hex,
  observedModel: ProPlanningLabel,
  observedMode: ProPlanningLabel,
  complete: Schema.Boolean,
  paginationGaps: ProPlanningCount,
  requiredAttachmentHashes: ProPlanningHashList,
  verifiedAttachmentHashes: ProPlanningHashList,
}).check(
  Schema.makeFilter(
    (retrieval) =>
      retrieval.complete ===
      (retrieval.paginationGaps === 0 &&
        coversRequired(retrieval.requiredAttachmentHashes, retrieval.verifiedAttachmentHashes)),
    { expected: "a complete flag consistent with pagination gaps and verified attachments" },
  ),
);
export type ProPlanningRetrieval = typeof ProPlanningRetrieval.Type;

/**
 * Original recommendation → verified current constraint → adapted route →
 * unchanged acceptance. Pointers and digests only; the proposal revision and
 * reconciliation pointer preserve the imported plan as a PROPOSED revision.
 */
export const ProPlanningReconciliation = Schema.Struct({
  recommendationRef: ProPlanningRef,
  currentConstraintRef: ProPlanningRef,
  /** Canonical mission revision the constraint was verified against. */
  constraintRevision: ProPlanningCount,
  adaptedRouteRef: ProPlanningRef,
  acceptanceDigest: Sha256Hex,
  /** Digest of the authority and scope the adapted route implies. */
  scopeDigest: Sha256Hex,
  proposalRevision: ProPlanningCount,
  reconciliationRef: ProPlanningRef,
});
export type ProPlanningReconciliation = typeof ProPlanningReconciliation.Type;

const ProPlanningRecordFields = Schema.Struct({
  schemaVersion: Schema.Literal(PRO_PLANNING_SCHEMA_VERSION),
  planningId: ProPlanningId,
  submissionId: ProPlanningId,
  idempotencyKey: ProPlanningId,
  missionId: ProPlanningId,
  missionRevision: ProPlanningCount,
  teamId: ProPlanningId,
  environmentId: ProPlanningId,
  managerThreadId: ProPlanningId,
  managerEpoch: ProPlanningCount,
  stage: ProPlanningStage,
  /** Record CAS revision, advanced by exactly one per transition. */
  revision: Schema.Int.check(
    Schema.makeFilter((value: number) => value >= 0 && value <= MAX_PRO_PLANNING_RECORD_REVISION, {
      expected: `a record revision between 0 and ${MAX_PRO_PLANNING_RECORD_REVISION}`,
    }),
  ),
  route: ProPlanningRoute,
  prompt: ProPlanningPrompt,
  conversation: Schema.optional(ProPlanningConversation),
  wake: Schema.optional(ProPlanningWakeCursor),
  retrieval: Schema.optional(ProPlanningRetrieval),
  reconciliation: Schema.optional(ProPlanningReconciliation),
  blockReason: Schema.optional(ProPlanningBlockReason),
  cancelReason: Schema.optional(ProPlanningCancelReason),
});

/** Optional parts that must be present or absent for each stage. */
const isStageConsistent = (record: typeof ProPlanningRecordFields.Type): boolean => {
  const conversation = record.conversation !== undefined;
  const wake = record.wake !== undefined;
  const retrieval = record.retrieval !== undefined;
  const reconciliation = record.reconciliation !== undefined;
  const blocked = record.blockReason !== undefined;
  const cancelled = record.cancelReason !== undefined;
  if (conversation !== wake) return false;
  if (retrieval && !wake) return false;
  if (reconciliation && !retrieval) return false;
  if (blocked && cancelled) return false;
  if (record.retrieval !== undefined) {
    // A stored retrieval is always the complete, requested-model-and-mode run.
    if (!record.retrieval.complete) return false;
    if (record.retrieval.observedModel !== record.route.model) return false;
    if (record.retrieval.observedMode !== record.route.chatMode) return false;
  }
  if (
    record.reconciliation !== undefined &&
    record.retrieval !== undefined &&
    record.reconciliation.recommendationRef !== record.retrieval.responseRef
  ) {
    return false;
  }
  switch (record.stage) {
    case "prepared":
    case "submitted":
      return !conversation && !retrieval && !reconciliation && !blocked && !cancelled;
    case "response_pending":
      return conversation && !retrieval && !reconciliation && !blocked && !cancelled;
    case "retrieved":
      return retrieval && !reconciliation && !blocked && !cancelled;
    case "reconciled":
      return reconciliation && !blocked && !cancelled;
    case "blocked":
      return blocked && !reconciliation;
    case "cancelled":
      return cancelled && !reconciliation;
  }
};

/**
 * Candidate planning state record. Accepting one here proves only that it is
 * well-formed and stage-consistent, not that it was persisted or authorized.
 */
export const ProPlanningRecord = ProPlanningRecordFields.check(
  Schema.makeFilter(isStageConsistent, { expected: "optional parts consistent with the stage" }),
);
export type ProPlanningRecord = typeof ProPlanningRecord.Type;

// ---------------------------------------------------------------------------
// Untrusted stage events
// ---------------------------------------------------------------------------

/** The manager the event claims to act as; checked against the canonical current manager. */
export const ProPlanningActor = Schema.Struct({
  managerThreadId: ProPlanningId,
  managerEpoch: ProPlanningCount,
});
export type ProPlanningActor = typeof ProPlanningActor.Type;

const eventBase = {
  planningId: ProPlanningId,
  idempotencyKey: ProPlanningId,
  actor: ProPlanningActor,
} as const;

export const ProPlanningPrepareEvent = Schema.Struct({
  type: Schema.Literal("prepare"),
  actor: ProPlanningActor,
  prepared: ProPlanningRecord,
});
export const ProPlanningSubmitEvent = Schema.Struct({
  type: Schema.Literal("submit"),
  ...eventBase,
});
export const ProPlanningAwaitResponseEvent = Schema.Struct({
  type: Schema.Literal("await_response"),
  ...eventBase,
  conversation: ProPlanningConversation,
  wake: ProPlanningWakeCursor,
});
export const ProPlanningWakeEvent = Schema.Struct({
  type: Schema.Literal("wake"),
  ...eventBase,
  wakeKey: ProPlanningId,
});
export const ProPlanningRetrieveEvent = Schema.Struct({
  type: Schema.Literal("retrieve"),
  ...eventBase,
  responseRef: ProPlanningRef,
});
export const ProPlanningReconcileEvent = Schema.Struct({
  type: Schema.Literal("reconcile"),
  ...eventBase,
  reconciliation: ProPlanningReconciliation,
});
export const ProPlanningBlockEvent = Schema.Struct({
  type: Schema.Literal("block"),
  ...eventBase,
  reason: ProPlanningBlockReason,
});
export const ProPlanningCancelEvent = Schema.Struct({
  type: Schema.Literal("cancel"),
  ...eventBase,
  reason: ProPlanningCancelReason,
});

export const ProPlanningEvent = Schema.Union([
  ProPlanningPrepareEvent,
  ProPlanningSubmitEvent,
  ProPlanningAwaitResponseEvent,
  ProPlanningWakeEvent,
  ProPlanningRetrieveEvent,
  ProPlanningReconcileEvent,
  ProPlanningBlockEvent,
  ProPlanningCancelEvent,
]);
export type ProPlanningEvent = typeof ProPlanningEvent.Type;

// ---------------------------------------------------------------------------
// Separately trusted facts and receipts
// ---------------------------------------------------------------------------

export const ProPlanningMissionFacts = Schema.Struct({
  missionId: ProPlanningId,
  revision: ProPlanningCount,
  teamId: ProPlanningId,
  environmentId: ProPlanningId,
  managerThreadId: ProPlanningId,
  managerEpoch: ProPlanningCount,
  status: Schema.Literals(["active", "paused", "completed", "stopped"]),
  stopRequested: Schema.Boolean,
  pauseRequested: Schema.Boolean,
  /** Digest of the mission's current acceptance criteria. */
  acceptanceDigest: Sha256Hex,
});
export type ProPlanningMissionFacts = typeof ProPlanningMissionFacts.Type;

/**
 * Operator (Codex GUI) usage and ChatGPT response allowance are separate
 * pools. There is no "unlimited" state: unknown never means unlimited, and
 * the guard never probes or spends to find out.
 */
export const ProPlanningUsageState = Schema.Literals(["available", "exhausted", "unknown"]);
export type ProPlanningUsageState = typeof ProPlanningUsageState.Type;

export const ProPlanningUsageFacts = Schema.Struct({
  operatorBudget: ProPlanningUsageState,
  responseAllowance: ProPlanningUsageState,
});
export type ProPlanningUsageFacts = typeof ProPlanningUsageFacts.Type;

/** Actual user authorization for this planning stage and the scope it may propose. */
export const ProPlanningApproval = Schema.Struct({
  approvalRef: ProPlanningRef,
  planningId: ProPlanningId,
  promptSha256: Sha256Hex,
  scopeDigest: Sha256Hex,
});
export type ProPlanningApproval = typeof ProPlanningApproval.Type;

/** Separate actual approval for an authority or scope change found at reconciliation. */
export const ProPlanningScopeChangeApproval = Schema.Struct({
  approvalRef: ProPlanningRef,
  planningId: ProPlanningId,
  scopeDigest: Sha256Hex,
});
export type ProPlanningScopeChangeApproval = typeof ProPlanningScopeChangeApproval.Type;

/** Canonical mission, usage, and approval facts from the trusted producer. */
export const ProPlanningFacts = Schema.Struct({
  observedAtMs: ProPlanningCount,
  mission: ProPlanningMissionFacts,
  usage: ProPlanningUsageFacts,
  planningApproval: Schema.optional(ProPlanningApproval),
  scopeChangeApproval: Schema.optional(ProPlanningScopeChangeApproval),
});
export type ProPlanningFacts = typeof ProPlanningFacts.Type;

/** Independent verification of what is about to be submitted and where. */
export const ProPlanningSubmitVerification = Schema.Struct({
  receiptRef: ProPlanningRef,
  verifiedAtMs: ProPlanningCount,
  submissionId: ProPlanningId,
  promptRevision: ProPlanningCount,
  promptSha256: Sha256Hex,
  accountRef: ProPlanningLabel,
  workspaceRef: ProPlanningLabel,
  chatMode: ProPlanningLabel,
  proOption: ProPlanningLabel,
});
export type ProPlanningSubmitVerification = typeof ProPlanningSubmitVerification.Type;

/**
 * The owning store's ACK that it persisted the prepared record before the
 * external side effect. Future owner: the existing mission SQL store.
 */
export const ProPlanningReservationAck = Schema.Struct({
  ackRef: ProPlanningRef,
  persistedAtMs: ProPlanningCount,
  planningId: ProPlanningId,
  submissionId: ProPlanningId,
  idempotencyKey: ProPlanningId,
  promptRevision: ProPlanningCount,
  promptSha256: Sha256Hex,
  missionId: ProPlanningId,
  missionRevision: ProPlanningCount,
  managerThreadId: ProPlanningId,
  managerEpoch: ProPlanningCount,
  /** Revision of the persisted prepared record. */
  recordRevision: ProPlanningCount,
});
export type ProPlanningReservationAck = typeof ProPlanningReservationAck.Type;

/**
 * Independently verified retrieval of the response. Observed model and mode
 * are null when not visible, which the guard treats as unverified.
 */
export const ProPlanningCompletionReceipt = Schema.Struct({
  receiptRef: ProPlanningRef,
  verifiedAtMs: ProPlanningCount,
  planningId: ProPlanningId,
  submissionId: ProPlanningId,
  conversationRef: ProPlanningRef,
  responseRef: ProPlanningRef,
  completionEvidenceSha256: Sha256Hex,
  responseSha256: Sha256Hex,
  accountRef: ProPlanningLabel,
  workspaceRef: ProPlanningLabel,
  observedModel: Schema.NullOr(ProPlanningLabel),
  observedMode: Schema.NullOr(ProPlanningLabel),
  pagesExpected: ProPlanningCount,
  pagesRetrieved: ProPlanningCount,
  requiredAttachmentHashes: ProPlanningHashList,
  verifiedAttachmentHashes: ProPlanningHashList,
});
export type ProPlanningCompletionReceipt = typeof ProPlanningCompletionReceipt.Type;

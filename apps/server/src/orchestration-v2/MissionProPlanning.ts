import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  MAX_PRO_PLANNING_RECORD_REVISION,
  MAX_PRO_PLANNING_WAKE_WINDOW_MS,
  ProPlanningCompletionReceipt,
  ProPlanningEvent,
  ProPlanningFacts,
  ProPlanningRecord,
  ProPlanningReservationAck,
  ProPlanningSubmitVerification,
  type ProPlanningAction,
  type ProPlanningApproval,
  type ProPlanningReasonCode,
  type ProPlanningStage,
} from "../../../../packages/contracts/src/missionProPlanning.ts";

/**
 * Pure guarded transitions for the bounded ChatGPT Pro planning stage (P5
 * source slice): prepared → submitted → response_pending → retrieved →
 * reconciled, with explicit blocked / cancelled outcomes.
 *
 * It is dormant and proposal-only. It reads no clock, store, network, or
 * model, schedules nothing, and probes no quota. A decision is a bounded
 * reason code, a finite next action, and (for `advance`) a PROPOSED next
 * record. None of it is durable authorization: the existing mission SQL
 * store and admission path are the future owners that persist a proposed
 * record (compare-and-set on its revision) before the adapter performs the
 * action. No such store exists in this slice, and this module creates none.
 *
 * Trust boundary. The event and the record body are untrusted stage claims.
 * Canonical mission, epoch, team, environment, manager, pause/stop,
 * approval, and usage facts arrive separately as `facts`; the independent
 * GUI verification, the owning store's reservation ACK, and the verified
 * completion arrive separately as `evidence`. A boolean or pointer inside a
 * claim is never authority. Missing, stale, or malformed facts hold.
 *
 * The entry point takes `unknown`, decodes into fresh detached objects with
 * exact keys, returns a deeply frozen decision, and never throws.
 */

/** Longest evidence age accepted; trusted facts and receipts older than this hold. */
export const PRO_PLANNING_MAX_EVIDENCE_AGE_MS = 5 * 60_000;
/** Largest forward clock skew tolerated between a producer's clock and ours. */
export const PRO_PLANNING_MAX_CLOCK_SKEW_MS = 30_000;

type Severity = "noop" | "hold" | "deny";

/** Severity per reason, and (by key order) the stable order reasons are reported in. */
const REASON_SEVERITY: Readonly<Record<ProPlanningReasonCode, Severity>> = {
  clock_invalid: "hold",
  input_malformed: "hold",
  facts_malformed: "hold",
  record_malformed: "hold",
  record_missing: "hold",
  facts_stale: "hold",
  facts_from_future: "hold",
  evidence_stale: "hold",
  evidence_from_future: "hold",
  counter_overflow: "hold",
  verifier_fault: "hold",
  mission_mismatch: "deny",
  team_mismatch: "deny",
  environment_mismatch: "deny",
  mission_revision_mismatch: "deny",
  manager_mismatch: "deny",
  epoch_mismatch: "deny",
  identity_mismatch: "deny",
  idempotency_conflict: "deny",
  stage_out_of_order: "deny",
  mission_paused: "hold",
  mission_not_active: "hold",
  mission_stopped: "hold",
  approval_missing: "hold",
  approval_mismatch: "deny",
  verification_missing: "hold",
  submission_mismatch: "deny",
  prompt_mismatch: "deny",
  account_mismatch: "deny",
  workspace_mismatch: "deny",
  chat_mode_mismatch: "deny",
  pro_option_mismatch: "deny",
  reservation_missing: "hold",
  reservation_mismatch: "deny",
  operator_budget_unknown: "hold",
  operator_budget_exhausted: "hold",
  response_allowance_unknown: "hold",
  response_allowance_exhausted: "hold",
  wake_window_invalid: "hold",
  wake_not_due: "hold",
  wake_expired: "hold",
  completion_missing: "hold",
  conversation_mismatch: "deny",
  response_mismatch: "deny",
  model_unverified: "hold",
  pagination_gap: "hold",
  attachment_incomplete: "hold",
  coverage_inconsistent: "deny",
  recommendation_mismatch: "deny",
  constraint_stale: "hold",
  acceptance_changed: "hold",
  scope_change_unapproved: "hold",
  already_applied: "noop",
  stale_event: "noop",
  terminal_stage: "noop",
};

const REASON_ORDER: ReadonlyMap<ProPlanningReasonCode, number> = new Map(
  (Object.keys(REASON_SEVERITY) as ProPlanningReasonCode[]).map((code, index) => [code, index]),
);

/** The next action a held reason points at; other holds refresh facts, denials go to a human. */
const HOLD_ACTION: Partial<Record<ProPlanningReasonCode, ProPlanningAction>> = {
  reservation_missing: "persist_reservation",
  operator_budget_unknown: "operator_review",
  operator_budget_exhausted: "operator_review",
  response_allowance_unknown: "operator_review",
  response_allowance_exhausted: "operator_review",
  mission_paused: "operator_review",
  mission_not_active: "operator_review",
  mission_stopped: "operator_review",
  approval_missing: "request_user_approval",
  scope_change_unapproved: "request_user_approval",
  wake_not_due: "release_gui_and_wait",
  wake_expired: "operator_review",
  pagination_gap: "continue_retrieval",
  attachment_incomplete: "continue_retrieval",
  model_unverified: "continue_retrieval",
};

const GUI_ACTIONS: ReadonlySet<ProPlanningAction> = new Set([
  "submit_prompt",
  "locate_existing",
  "reacquire_gui_and_retrieve",
  "continue_retrieval",
]);

/** Stable pointer to the record a decision was made against. */
export interface ProPlanningStagePointer {
  readonly planningId: string;
  /** The reserved submission identity, so `locate_existing` names what to find. */
  readonly submissionId: string;
  readonly stage: ProPlanningStage;
  readonly recordRevision: number;
}

/**
 * - `advance`: `record` is the proposed next record; persist it by CAS on the
 *   current revision, then perform `action`.
 * - `act`: no record change; perform `action` (wake retrieval, locate existing).
 * - `noop`: stale, duplicate, replayed, or terminal; `pointer` is the stable
 *   current stage and nothing restarts.
 * - `hold`: facts are missing, stale, or not yet allowed; nothing may be done.
 * - `deny`: a binding, identity, or ordering fact contradicts the claim.
 */
export interface ProPlanningDecision {
  readonly kind: "advance" | "act" | "noop" | "hold" | "deny";
  /** Always a proposal: never durable authorization or coding authority. */
  readonly authority: "proposal_only";
  readonly reasons: ReadonlyArray<ProPlanningReasonCode>;
  readonly action: ProPlanningAction;
  /** `required` while the action drives the GUI; `release` otherwise, including while waiting. */
  readonly guiLease: "required" | "release";
  readonly pointer: ProPlanningStagePointer | null;
  readonly record: ProPlanningRecord | null;
}

export interface AdvanceProPlanningInput {
  /** Untrusted stage claim. */
  readonly event: unknown;
  /** Current record as the owning store holds it, or null before preparation. Not proof of persistence. */
  readonly current: unknown;
  /** Trusted canonical mission, usage, and approval facts. */
  readonly facts: unknown;
  /** Trusted `{ verification, reservation, completion }` receipts; each part optional. */
  readonly evidence?: unknown;
  /** Caller-supplied clock. The guard never reads one. */
  readonly nowMs: number;
}

type Event = ProPlanningEvent;
type EventOf<T extends Event["type"]> = Extract<Event, { readonly type: T }>;

// ---------------------------------------------------------------------------
// Decoding and decision plumbing
// ---------------------------------------------------------------------------

type DecoderSchema = Parameters<typeof Schema.decodeUnknownOption>[0];

/** Decodes into a fresh detached value; undefined on any failure, never throws. */
const decoder = <S extends DecoderSchema>(schema: S) => {
  const decode = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" });
  return (input: unknown): S["Type"] | undefined => {
    try {
      const result = decode(input);
      return Option.isSome(result) ? result.value : undefined;
    } catch {
      return undefined;
    }
  };
};

const decodeEvent = decoder(ProPlanningEvent);
const decodeRecord = decoder(ProPlanningRecord);
const decodeFacts = decoder(ProPlanningFacts);
const decodeVerification = decoder(ProPlanningSubmitVerification);
const decodeReservation = decoder(ProPlanningReservationAck);
const decodeCompletion = decoder(ProPlanningCompletionReceipt);

const isRecordLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
};

const pointerOf = (record: ProPlanningRecord | null | undefined): ProPlanningStagePointer | null =>
  record === null || record === undefined
    ? null
    : {
        planningId: record.planningId,
        submissionId: record.submissionId,
        stage: record.stage,
        recordRevision: record.revision,
      };

const decide = (
  kind: ProPlanningDecision["kind"],
  action: ProPlanningAction,
  pointer: ProPlanningStagePointer | null,
  reasons: ReadonlyArray<ProPlanningReasonCode>,
  record: ProPlanningRecord | null,
): ProPlanningDecision =>
  deepFreeze({
    kind,
    authority: "proposal_only",
    reasons,
    action,
    guiLease: GUI_ACTIONS.has(action) ? "required" : "release",
    pointer,
    record,
  });

const proposeAdvance = (
  action: ProPlanningAction,
  record: ProPlanningRecord,
): ProPlanningDecision => decide("advance", action, pointerOf(record), [], record);

const proposeAct = (action: ProPlanningAction, current: ProPlanningRecord): ProPlanningDecision =>
  decide("act", action, pointerOf(current), [], null);

/** Turns accumulated reasons into the stable hold, deny, or no-op decision. */
const reject = (
  reasons: ReadonlySet<ProPlanningReasonCode>,
  current: ProPlanningRecord | null,
): ProPlanningDecision => {
  const ordered = [...(reasons.size === 0 ? ["verifier_fault" as const] : reasons)].sort(
    (left, right) => (REASON_ORDER.get(left) ?? 0) - (REASON_ORDER.get(right) ?? 0),
  );
  const severities = new Set(ordered.map((reason) => REASON_SEVERITY[reason]));
  const kind = severities.has("deny") ? "deny" : severities.has("hold") ? "hold" : "noop";
  const action: ProPlanningAction =
    kind === "noop"
      ? "none"
      : kind === "deny"
        ? "operator_review"
        : (ordered.map((reason) => HOLD_ACTION[reason]).find((entry) => entry !== undefined) ??
          "refresh_facts");
  return decide(kind, action, pointerOf(current), ordered, null);
};

const isNowMs = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const only = (reason: ProPlanningReasonCode): Set<ProPlanningReasonCode> =>
  new Set<ProPlanningReasonCode>([reason]);

interface Ctx {
  readonly nowMs: number;
  readonly facts: ProPlanningFacts;
  readonly evidence: unknown;
  readonly reasons: Set<ProPlanningReasonCode>;
}
const checkFresh = (
  ctx: Ctx,
  observedAtMs: number,
  stale: "facts_stale" | "evidence_stale",
): void => {
  const future = stale === "facts_stale" ? "facts_from_future" : "evidence_from_future";
  if (observedAtMs > ctx.nowMs + PRO_PLANNING_MAX_CLOCK_SKEW_MS) ctx.reasons.add(future);
  else if (ctx.nowMs - observedAtMs > PRO_PLANNING_MAX_EVIDENCE_AGE_MS) ctx.reasons.add(stale);
};

const evidencePart = <T>(
  evidence: unknown,
  key: "verification" | "reservation" | "completion",
  decode: (input: unknown) => T | undefined,
): T | undefined => (isRecordLike(evidence) ? decode(evidence[key]) : undefined);

const sameBytes = (left: unknown, right: unknown): boolean =>
  stableStringify(left) === stableStringify(right);

/** Fields a replayed `prepare` must reproduce byte-for-byte. */
const immutableIdentity = (record: ProPlanningRecord) => ({
  planningId: record.planningId,
  submissionId: record.submissionId,
  idempotencyKey: record.idempotencyKey,
  missionId: record.missionId,
  missionRevision: record.missionRevision,
  teamId: record.teamId,
  environmentId: record.environmentId,
  route: record.route,
  prompt: record.prompt,
});

/** The record's canonical scope against the trusted mission. A rotated manager (lower epoch) is allowed. */
const checkScope = (ctx: Ctx, record: ProPlanningRecord, strictManager: boolean): void => {
  const { reasons } = ctx;
  const { mission } = ctx.facts;
  if (record.missionId !== mission.missionId) reasons.add("mission_mismatch");
  if (record.teamId !== mission.teamId) reasons.add("team_mismatch");
  if (record.environmentId !== mission.environmentId) reasons.add("environment_mismatch");
  if (record.missionRevision > mission.revision) reasons.add("mission_revision_mismatch");
  if (
    record.managerEpoch > mission.managerEpoch ||
    (strictManager && record.managerEpoch !== mission.managerEpoch)
  ) {
    reasons.add("epoch_mismatch");
  } else if (
    record.managerEpoch === mission.managerEpoch &&
    record.managerThreadId !== mission.managerThreadId
  ) {
    reasons.add("manager_mismatch");
  }
};

/** The claimed actor must be the canonical current manager thread and epoch. */
const checkActor = (
  ctx: Ctx,
  actor: { readonly managerThreadId: string; readonly managerEpoch: number },
): void => {
  const { mission } = ctx.facts;
  if (actor.managerEpoch !== mission.managerEpoch) ctx.reasons.add("epoch_mismatch");
  if (actor.managerThreadId !== mission.managerThreadId) ctx.reasons.add("manager_mismatch");
};

const checkMissionOpen = (ctx: Ctx): void => {
  const { mission } = ctx.facts;
  if (mission.status === "paused" || mission.pauseRequested) ctx.reasons.add("mission_paused");
  else if (mission.status !== "active") ctx.reasons.add("mission_not_active");
};

const isMissionStopped = (ctx: Ctx): boolean =>
  ctx.facts.mission.status === "stopped" || ctx.facts.mission.stopRequested;

/** Explicit approval for this planning stage and exact prompt. */
const checkApproval = (
  ctx: Ctx,
  approval: ProPlanningApproval | undefined,
  record: ProPlanningRecord,
): void => {
  if (approval === undefined) ctx.reasons.add("approval_missing");
  else if (
    approval.planningId !== record.planningId ||
    approval.promptSha256 !== record.prompt.sha256
  ) {
    ctx.reasons.add("approval_mismatch");
  }
};

/** Both pools must be known and available; one never stands in for the other. */
const checkUsage = (ctx: Ctx, includeResponse: boolean): void => {
  const { usage } = ctx.facts;
  if (usage.operatorBudget === "unknown") ctx.reasons.add("operator_budget_unknown");
  if (usage.operatorBudget === "exhausted") ctx.reasons.add("operator_budget_exhausted");
  if (!includeResponse) return;
  if (usage.responseAllowance === "unknown") ctx.reasons.add("response_allowance_unknown");
  if (usage.responseAllowance === "exhausted") ctx.reasons.add("response_allowance_exhausted");
};

/** Builds the next record: one revision up, rebound to the canonical current manager, re-decoded. */
const nextRecord = (
  ctx: Ctx,
  current: ProPlanningRecord,
  patch: Partial<ProPlanningRecord>,
): ProPlanningRecord | undefined => {
  if (current.revision + 1 > MAX_PRO_PLANNING_RECORD_REVISION) return undefined;
  const { mission } = ctx.facts;
  return decodeRecord({
    ...current,
    ...patch,
    managerThreadId: mission.managerThreadId,
    managerEpoch: mission.managerEpoch,
    revision: current.revision + 1,
  });
};

const advanceTo = (
  ctx: Ctx,
  current: ProPlanningRecord,
  patch: Partial<ProPlanningRecord>,
  action: ProPlanningAction,
): ProPlanningDecision => {
  const record = nextRecord(ctx, current, patch);
  if (record === undefined) {
    ctx.reasons.add(
      current.revision + 1 > MAX_PRO_PLANNING_RECORD_REVISION
        ? "counter_overflow"
        : "verifier_fault",
    );
    return reject(ctx.reasons, current);
  }
  return proposeAdvance(action, record);
};

// ---------------------------------------------------------------------------
// Stage routing: replay, stale, terminal, and ordering
// ---------------------------------------------------------------------------

const STAGE_RANK: Readonly<Record<ProPlanningStage, number>> = {
  prepared: 0,
  submitted: 1,
  response_pending: 2,
  retrieved: 3,
  reconciled: 4,
  blocked: 5,
  cancelled: 5,
};

const TERMINAL_STAGES: ReadonlySet<ProPlanningStage> = new Set([
  "reconciled",
  "blocked",
  "cancelled",
]);

/** Stage each event acts on; block and cancel act on any open stage. */
const REQUIRED_STAGE: Readonly<Record<Exclude<Event["type"], "prepare">, ProPlanningStage | null>> =
  {
    submit: "prepared",
    await_response: "submitted",
    wake: "response_pending",
    retrieve: "response_pending",
    reconcile: "retrieved",
    block: null,
    cancel: null,
  };

/** Whether the event's own effect already exists on the record, and with the same bytes. */
const replayOf = (
  event: Exclude<Event, { readonly type: "prepare" }>,
  current: ProPlanningRecord,
): "applied" | "conflict" | undefined => {
  switch (event.type) {
    case "await_response":
      return current.conversation === undefined
        ? undefined
        : sameBytes(
              { conversation: event.conversation, wake: event.wake },
              { conversation: current.conversation, wake: current.wake },
            )
          ? "applied"
          : "conflict";
    case "retrieve":
      return current.retrieval === undefined
        ? undefined
        : current.retrieval.responseRef === event.responseRef
          ? "applied"
          : "conflict";
    case "reconcile":
      return current.reconciliation === undefined
        ? undefined
        : sameBytes(event.reconciliation, current.reconciliation)
          ? "applied"
          : "conflict";
    case "block":
      return current.stage === "blocked" && current.blockReason === event.reason
        ? "applied"
        : undefined;
    case "cancel":
      return current.stage === "cancelled" && current.cancelReason === event.reason
        ? "applied"
        : undefined;
    default:
      return undefined;
  }
};

type Route =
  | { readonly kind: "proceed" }
  | { readonly kind: "locate" }
  | { readonly kind: "stop"; readonly reason: ProPlanningReasonCode };

const routeEvent = (
  event: Exclude<Event, { readonly type: "prepare" }>,
  current: ProPlanningRecord,
): Route => {
  const replay = replayOf(event, current);
  if (replay === "conflict") return { kind: "stop", reason: "idempotency_conflict" };
  if (replay === "applied") return { kind: "stop", reason: "already_applied" };
  if (TERMINAL_STAGES.has(current.stage)) return { kind: "stop", reason: "terminal_stage" };
  const required = REQUIRED_STAGE[event.type];
  if (required === null) return { kind: "proceed" };
  const have = STAGE_RANK[current.stage];
  const need = STAGE_RANK[required];
  if (have === need) return { kind: "proceed" };
  if (have < need) return { kind: "stop", reason: "stage_out_of_order" };
  // A submit after the reservation moved on means the acknowledgment was lost:
  // find the existing conversation, never submit again.
  return event.type === "submit" && current.stage === "submitted"
    ? { kind: "locate" }
    : { kind: "stop", reason: "stale_event" };
};

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

const handlePrepare = (
  ctx: Ctx,
  event: EventOf<"prepare">,
  current: ProPlanningRecord | null,
): ProPlanningDecision => {
  const { reasons, facts } = ctx;
  const prepared = event.prepared;
  checkActor(ctx, event.actor);
  if (current !== null) {
    // A replay of an applied prepare is stable only when every claim still checks out.
    if (current.planningId !== prepared.planningId) reasons.add("identity_mismatch");
    else if (!sameBytes(immutableIdentity(current), immutableIdentity(prepared))) {
      reasons.add("idempotency_conflict");
    } else if (reasons.size === 0) return reject(only("already_applied"), current);
    return reject(reasons, current);
  }
  checkScope(ctx, prepared, true);
  if (prepared.stage !== "prepared" || prepared.revision !== 0) reasons.add("stage_out_of_order");
  if (prepared.missionRevision !== facts.mission.revision) {
    reasons.add("mission_revision_mismatch");
  }
  if (isMissionStopped(ctx)) reasons.add("mission_stopped");
  else checkMissionOpen(ctx);
  return reasons.size > 0 ? reject(reasons, null) : proposeAdvance("persist_reservation", prepared);
};

const handleSubmit = (
  ctx: Ctx,
  current: ProPlanningRecord,
  locate: boolean,
): ProPlanningDecision => {
  const { reasons, facts, nowMs } = ctx;
  if (locate) {
    // Lost ACK: the identity is already reserved. Only locating is allowed.
    checkUsage(ctx, false);
    return reasons.size > 0 ? reject(reasons, current) : proposeAct("locate_existing", current);
  }

  if (current.missionRevision !== facts.mission.revision) {
    reasons.add("mission_revision_mismatch");
  }
  checkApproval(ctx, facts.planningApproval, current);

  const verification = evidencePart(ctx.evidence, "verification", decodeVerification);
  if (verification === undefined) reasons.add("verification_missing");
  else {
    checkFresh(ctx, verification.verifiedAtMs, "evidence_stale");
    if (verification.submissionId !== current.submissionId) reasons.add("submission_mismatch");
    if (
      verification.promptSha256 !== current.prompt.sha256 ||
      verification.promptRevision !== current.prompt.revision
    ) {
      reasons.add("prompt_mismatch");
    }
    if (verification.accountRef !== current.route.accountRef) reasons.add("account_mismatch");
    if (verification.workspaceRef !== current.route.workspaceRef) reasons.add("workspace_mismatch");
    if (verification.chatMode !== current.route.chatMode) reasons.add("chat_mode_mismatch");
    if (verification.proOption !== current.route.proOption) reasons.add("pro_option_mismatch");
  }

  // The prepared record alone is not proof it was persisted: the owning
  // store's ACK, supplied separately, must name this exact record.
  const reservation = evidencePart(ctx.evidence, "reservation", decodeReservation);
  if (reservation === undefined) reasons.add("reservation_missing");
  else {
    if (reservation.persistedAtMs > nowMs + PRO_PLANNING_MAX_CLOCK_SKEW_MS) {
      reasons.add("evidence_from_future");
    }
    if (
      reservation.planningId !== current.planningId ||
      reservation.submissionId !== current.submissionId ||
      reservation.idempotencyKey !== current.idempotencyKey ||
      reservation.promptRevision !== current.prompt.revision ||
      reservation.promptSha256 !== current.prompt.sha256 ||
      reservation.missionId !== current.missionId ||
      reservation.missionRevision !== current.missionRevision ||
      reservation.managerThreadId !== current.managerThreadId ||
      reservation.managerEpoch !== current.managerEpoch ||
      reservation.recordRevision !== current.revision
    ) {
      reasons.add("reservation_mismatch");
    }
  }

  checkUsage(ctx, true);
  return reasons.size > 0
    ? reject(reasons, current)
    : advanceTo(ctx, current, { stage: "submitted" }, "submit_prompt");
};

const handleAwaitResponse = (
  ctx: Ctx,
  event: EventOf<"await_response">,
  current: ProPlanningRecord,
): ProPlanningDecision => {
  // A finite window: a lost wake or unknown clock can never wait forever.
  if (
    event.wake.expiresAtMs <= ctx.nowMs ||
    event.wake.expiresAtMs - ctx.nowMs > MAX_PRO_PLANNING_WAKE_WINDOW_MS
  ) {
    ctx.reasons.add("wake_window_invalid");
    return reject(ctx.reasons, current);
  }
  return advanceTo(
    ctx,
    current,
    { stage: "response_pending", conversation: event.conversation, wake: event.wake },
    "release_gui_and_wait",
  );
};

const handleWake = (
  ctx: Ctx,
  event: EventOf<"wake">,
  current: ProPlanningRecord,
): ProPlanningDecision => {
  const wake = current.wake;
  if (wake === undefined) return reject(only("record_malformed"), current);
  if (wake.wakeKey !== event.wakeKey) return reject(only("stale_event"), current);
  if (ctx.nowMs < wake.notBeforeMs) ctx.reasons.add("wake_not_due");
  else if (ctx.nowMs > wake.expiresAtMs) ctx.reasons.add("wake_expired");
  checkUsage(ctx, false);
  return ctx.reasons.size > 0
    ? reject(ctx.reasons, current)
    : proposeAct("reacquire_gui_and_retrieve", current);
};

const handleRetrieve = (
  ctx: Ctx,
  event: EventOf<"retrieve">,
  current: ProPlanningRecord,
): ProPlanningDecision => {
  const { reasons } = ctx;
  // Retrieval may request more GUI work; it must not bypass the operator pool.
  checkUsage(ctx, false);
  if (reasons.size > 0) return reject(reasons, current);
  const completion = evidencePart(ctx.evidence, "completion", decodeCompletion);
  const conversation = current.conversation;
  if (conversation === undefined) return reject(only("record_malformed"), current);
  if (completion === undefined) return reject(only("completion_missing"), current);

  // The pointers in the claim are not proof: the verified receipt must name
  // the same conversation, response, account, and workspace.
  checkFresh(ctx, completion.verifiedAtMs, "evidence_stale");
  if (completion.planningId !== current.planningId) reasons.add("identity_mismatch");
  if (completion.submissionId !== current.submissionId) reasons.add("submission_mismatch");
  if (completion.conversationRef !== conversation.conversationRef) {
    reasons.add("conversation_mismatch");
  }
  if (completion.responseRef !== event.responseRef) reasons.add("response_mismatch");
  if (completion.accountRef !== current.route.accountRef) reasons.add("account_mismatch");
  if (completion.workspaceRef !== current.route.workspaceRef) reasons.add("workspace_mismatch");
  if (completion.pagesRetrieved > completion.pagesExpected) reasons.add("coverage_inconsistent");
  if (reasons.size > 0) return reject(reasons, current);

  const { observedModel, observedMode } = completion;
  // A fallback response is a block, never the requested Pro run succeeding.
  if (observedModel !== null && observedModel !== current.route.model) {
    return advanceTo(
      ctx,
      current,
      { stage: "blocked", blockReason: "model_fallback" },
      "operator_review",
    );
  }
  if (observedMode !== null && observedMode !== current.route.chatMode) {
    return advanceTo(
      ctx,
      current,
      { stage: "blocked", blockReason: "mode_mismatch" },
      "operator_review",
    );
  }
  if (observedModel === null || observedMode === null) reasons.add("model_unverified");

  // Coverage is computed from the receipt; no completeness flag is trusted.
  if (completion.pagesExpected === 0 || completion.pagesRetrieved < completion.pagesExpected) {
    reasons.add("pagination_gap");
  }
  const verified = new Set(completion.verifiedAttachmentHashes);
  if (!completion.requiredAttachmentHashes.every((hash) => verified.has(hash))) {
    reasons.add("attachment_incomplete");
  }
  if (reasons.size > 0 || observedModel === null || observedMode === null) {
    return reject(reasons, current);
  }

  return advanceTo(
    ctx,
    current,
    {
      stage: "retrieved",
      retrieval: {
        responseRef: completion.responseRef,
        completionEvidenceSha256: completion.completionEvidenceSha256,
        responseSha256: completion.responseSha256,
        observedModel,
        observedMode,
        complete: true,
        paginationGaps: 0,
        requiredAttachmentHashes: completion.requiredAttachmentHashes,
        verifiedAttachmentHashes: completion.verifiedAttachmentHashes,
      },
    },
    "reconcile_response",
  );
};

const handleReconcile = (
  ctx: Ctx,
  event: EventOf<"reconcile">,
  current: ProPlanningRecord,
): ProPlanningDecision => {
  const { reasons, facts } = ctx;
  const { reconciliation } = event;
  if (current.retrieval === undefined) return reject(only("record_malformed"), current);

  if (reconciliation.recommendationRef !== current.retrieval.responseRef) {
    reasons.add("recommendation_mismatch");
  }
  // The constraint must be the one verified against the mission as it is now.
  if (reconciliation.constraintRevision !== facts.mission.revision) reasons.add("constraint_stale");
  if (reconciliation.acceptanceDigest !== facts.mission.acceptanceDigest) {
    reasons.add("acceptance_changed");
  }
  checkApproval(ctx, facts.planningApproval, current);
  const approval = facts.planningApproval;
  if (approval !== undefined && reconciliation.scopeDigest !== approval.scopeDigest) {
    // An authority or scope change needs its own actual approval, never the planning one.
    const change = facts.scopeChangeApproval;
    if (change === undefined) reasons.add("scope_change_unapproved");
    else if (
      change.planningId !== current.planningId ||
      change.scopeDigest !== reconciliation.scopeDigest
    ) {
      reasons.add("approval_mismatch");
    }
  }
  // Reconciled only proposes a revision: coding still needs a fresh admission.
  return reasons.size > 0
    ? reject(reasons, current)
    : advanceTo(ctx, current, { stage: "reconciled", reconciliation }, "rerun_admission");
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const evaluate = (input: unknown): ProPlanningDecision => {
  const reasons = new Set<ProPlanningReasonCode>();
  if (!isRecordLike(input)) return reject(only("input_malformed"), null);

  const nowMs = isNowMs(input.nowMs) ? input.nowMs : undefined;
  if (nowMs === undefined) reasons.add("clock_invalid");
  const event = decodeEvent(input.event);
  if (event === undefined) reasons.add("input_malformed");
  const facts = decodeFacts(input.facts);
  if (facts === undefined) reasons.add("facts_malformed");
  const hasCurrent = input.current !== null && input.current !== undefined;
  const decodedCurrent = hasCurrent ? decodeRecord(input.current) : null;
  if (decodedCurrent === undefined) reasons.add("record_malformed");
  const current = decodedCurrent ?? null;
  if (
    nowMs === undefined ||
    event === undefined ||
    facts === undefined ||
    decodedCurrent === undefined
  ) {
    return reject(reasons, current);
  }

  const ctx: Ctx = { nowMs, facts, evidence: input.evidence, reasons };
  checkFresh(ctx, facts.observedAtMs, "facts_stale");

  if (event.type === "prepare") return handlePrepare(ctx, event, current);

  if (current === null) {
    reasons.add("record_missing");
    return reject(reasons, null);
  }
  if (event.planningId !== current.planningId || event.idempotencyKey !== current.idempotencyKey) {
    reasons.add("identity_mismatch");
  }
  checkScope(ctx, current, false);
  checkActor(ctx, event.actor);
  if (reasons.size > 0) return reject(reasons, current);

  const route = routeEvent(event, current);
  if (route.kind === "stop") return reject(only(route.reason), current);

  // Cancellation wins over late completion, a stale wake, or any progress.
  if (isMissionStopped(ctx)) {
    return advanceTo(ctx, current, { stage: "cancelled", cancelReason: "mission_stopped" }, "none");
  }
  if (event.type !== "block" && event.type !== "cancel") checkMissionOpen(ctx);
  if (reasons.size > 0) return reject(reasons, current);

  switch (event.type) {
    case "submit":
      return handleSubmit(ctx, current, route.kind === "locate");
    case "await_response":
      return handleAwaitResponse(ctx, event, current);
    case "wake":
      return handleWake(ctx, event, current);
    case "retrieve":
      return handleRetrieve(ctx, event, current);
    case "reconcile":
      return handleReconcile(ctx, event, current);
    case "block":
      return advanceTo(
        ctx,
        current,
        { stage: "blocked", blockReason: event.reason },
        "operator_review",
      );
    case "cancel":
      return advanceTo(ctx, current, { stage: "cancelled", cancelReason: event.reason }, "none");
  }
};

/**
 * Decides one planning event against the current record and the separately
 * trusted facts and receipts. Total over `unknown` input: a malformed or
 * hostile value yields a held decision, never an exception.
 */
export const advanceProPlanning = (input: AdvanceProPlanningInput): ProPlanningDecision => {
  try {
    return evaluate(input);
  } catch {
    return reject(only("verifier_fault"), null);
  }
};

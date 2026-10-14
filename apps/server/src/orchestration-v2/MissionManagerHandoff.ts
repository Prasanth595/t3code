// @effect-diagnostics nodeBuiltinImport:off -- SHA-256 binds exact canonical handoff bytes.
import * as NodeCrypto from "node:crypto";

import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Schema from "effect/Schema";

import type { Mission } from "../../../../packages/contracts/src/mission.ts";
import { MissionResultDisposition } from "../../../../packages/contracts/src/missionResult.ts";
import {
  MAX_SAME_DAY_ORDINAL,
  type PreparedRotationIntent,
  type RotationDueReason,
} from "./MissionManagerRotation.ts";

/**
 * Immutable team-scoped manager-handoff snapshot builder (P3 handoff slice).
 * Pure: returns a detached deeply frozen PREPARED record plus canonical
 * UTF-8 bytes/SHA-256. Never launches, persists, or reads private sources.
 * Canonical scope/authority wording is never serialized: only bounded
 * hashes and canonical mission/revision/index pointers are emitted.
 */
export const HANDOFF_SNAPSHOT_SCHEMA_VERSION = 1;
export const HANDOFF_MAX_ARRAY_ITEMS = 16;
export const HANDOFF_MAX_SERIALIZED_BYTES = 64 * 1024;
export const HANDOFF_MAX_ID_LENGTH = 128;
export const HANDOFF_MAX_REF_LENGTH = 256;
const MAX_CANONICAL_TEXT_BYTES = 4096;
const MAX_CANONICAL_LIST_BYTES = 16384;
const MAX_FACT_KEYS = 16;

export type HandoffCoverageState = "complete" | "partial" | "none" | "unknown";
export type HandoffCandidateState = "none" | "proposed" | "validated" | "unknown";
export type HandoffRuntimeState = "idle" | "active" | "quiesced" | "unknown";
export type HandoffRejectReason =
  | "invalid_mission"
  | "mission_inactive"
  | "invalid_intent"
  | "intent_mismatch"
  | "stale_intent"
  | "invalid_boundary"
  | "invalid_facts"
  | "invalid_pointer"
  | "forbidden_pointer"
  | "unknown_task_ref"
  | "invalid_predecessor"
  | "predecessor_scope_mismatch"
  | "array_overflow"
  | "string_overflow"
  | "byte_overflow";

export interface HandoffOwnershipFact {
  readonly taskId: string;
  readonly threadId?: string | undefined;
  readonly runId?: string | undefined;
  readonly attemptNumber?: number | undefined;
}
export interface HandoffResultFact {
  readonly taskId: string;
  readonly dispatchKey?: string | undefined;
  readonly resultRevision?: number | undefined;
  readonly commandId?: string | undefined;
  readonly disposition?: MissionResultDisposition | undefined;
}
export interface HandoffHoldFact {
  readonly holdId: string;
  readonly keepAliveRef?: string | undefined;
}
export interface HandoffIdRefFact {
  readonly id: string;
  readonly ref?: string | undefined;
}
export interface HandoffCoverageFacts {
  readonly coverage: HandoffCoverageState;
  readonly reportRef?: string | undefined;
  readonly candidate: HandoffCandidateState;
  readonly candidateRef?: string | undefined;
  readonly runtime: HandoffRuntimeState;
}
export interface HandoffIntegrationFacts {
  readonly branch?: string | undefined;
  readonly buildRef?: string | undefined;
  readonly commit?: string | undefined;
}
export interface HandoffRoutePolicyFacts {
  readonly ref: string;
  /** Publisher revision string `<cryptoUUID>#<monotonic counter>`; never coerced. */
  readonly revision?: string | undefined;
}
export interface HandoffDeadlineFacts {
  readonly cursor?: number | undefined;
  readonly ref?: string | undefined;
}
export interface HandoffPredecessorFacts {
  readonly missionId: string;
  readonly teamId: string;
  readonly environmentId: string;
  readonly role: PreparedRotationIntent["role"];
  readonly managerThreadId: string;
  readonly epoch: number;
  readonly localDate?: string | undefined;
  readonly ordinal?: number | undefined;
}
export interface BuildManagerHandoffInput {
  readonly mission: Mission;
  readonly intent: PreparedRotationIntent;
  readonly ownership?: ReadonlyArray<HandoffOwnershipFact> | undefined;
  readonly pendingResults?: ReadonlyArray<HandoffResultFact> | undefined;
  readonly integration?: HandoffIntegrationFacts | undefined;
  readonly coverage?: HandoffCoverageFacts | undefined;
  readonly resourceHolds?: ReadonlyArray<HandoffHoldFact> | undefined;
  readonly routePolicy?: HandoffRoutePolicyFacts | undefined;
  readonly blockers?: ReadonlyArray<HandoffIdRefFact> | undefined;
  readonly nextActions?: ReadonlyArray<HandoffIdRefFact> | undefined;
  readonly deadline?: HandoffDeadlineFacts | undefined;
  readonly predecessor?: HandoffPredecessorFacts | undefined;
}

export interface HandoffDecisionPointer {
  readonly id: string;
  /** Canonical pointer `missionId@revision:decision:index`; no wording copied. */
  readonly canonicalRef: string;
  /** SHA-256 hex of stable-stringified canonical authority {source, ref}. */
  readonly authorityDigest: string;
}
export interface HandoffScopePointer {
  readonly count: number;
  /** SHA-256 hex of stable-stringified canonical scope list; wording omitted. */
  readonly digest: string;
}
export interface HandoffAcceptancePointer {
  readonly id: string;
}
export interface HandoffOwnershipPointer {
  readonly taskId: string;
  readonly threadId?: string | undefined;
  readonly runId?: string | undefined;
  readonly attemptNumber?: number | undefined;
}
export interface HandoffResultPointer {
  readonly taskId: string;
  readonly dispatchKey?: string | undefined;
  readonly resultRevision?: number | undefined;
  readonly commandId?: string | undefined;
  readonly disposition?: MissionResultDisposition | undefined;
}
export interface HandoffHoldPointer {
  readonly holdId: string;
  readonly keepAliveRef?: string | undefined;
}
export interface HandoffIdRefPointer {
  readonly id: string;
  readonly ref?: string | undefined;
}
export interface HandoffCoverageValue {
  readonly coverage: HandoffCoverageState;
  readonly reportRef?: string | undefined;
  readonly candidate: HandoffCandidateState;
  readonly candidateRef?: string | undefined;
  readonly runtime: HandoffRuntimeState;
}
export interface HandoffIntegrationValue {
  readonly branch?: string | undefined;
  readonly buildRef?: string | undefined;
  readonly commit?: string | undefined;
}
export interface HandoffRoutePolicyValue {
  readonly ref: string;
  readonly revision?: string | undefined;
}
export interface HandoffDeadlineValue {
  readonly cursor?: number | undefined;
  readonly ref?: string | undefined;
}
export interface HandoffPredecessorValue {
  readonly missionId: string;
  readonly teamId: string;
  readonly environmentId: string;
  readonly role: PreparedRotationIntent["role"];
  readonly managerThreadId: string;
  readonly epoch: number;
  readonly localDate?: string | undefined;
  readonly ordinal?: number | undefined;
}
export type HandoffUnknown = { readonly state: "unknown"; readonly reason: string };
export type HandoffListField<T> =
  | { readonly state: "known"; readonly items: ReadonlyArray<T> }
  | HandoffUnknown;
export type HandoffValueField<T> =
  | { readonly state: "known"; readonly value: T }
  | HandoffUnknown;

export interface ManagerHandoffSnapshot {
  readonly schemaVersion: typeof HANDOFF_SNAPSHOT_SCHEMA_VERSION;
  readonly serialization: {
    readonly encoding: "utf8-json";
    readonly canonicalization: "stable-stringify-v1";
  };
  readonly mission: {
    readonly ref: string;
    readonly revision: number;
    readonly teamId: string;
    readonly environmentId: string;
  };
  readonly manager: {
    readonly role: PreparedRotationIntent["role"];
    readonly threadId: string;
    readonly epoch: number;
  };
  readonly boundary: {
    readonly timezone: string;
    readonly localDate: string;
    readonly ordinal: number;
    readonly reason: RotationDueReason;
  };
  readonly decisions: ReadonlyArray<HandoffDecisionPointer>;
  readonly scope: HandoffScopePointer;
  readonly acceptance: ReadonlyArray<HandoffAcceptancePointer>;
  readonly ownership: HandoffListField<HandoffOwnershipPointer>;
  readonly pendingResults: HandoffListField<HandoffResultPointer>;
  readonly integration: HandoffValueField<HandoffIntegrationValue>;
  readonly coverage: HandoffValueField<HandoffCoverageValue>;
  readonly resourceHolds: HandoffListField<HandoffHoldPointer>;
  readonly routePolicy: HandoffValueField<HandoffRoutePolicyValue>;
  readonly blockers: HandoffListField<HandoffIdRefPointer>;
  readonly nextActions: HandoffListField<HandoffIdRefPointer>;
  readonly deadline: HandoffValueField<HandoffDeadlineValue>;
  readonly predecessor: HandoffValueField<HandoffPredecessorValue>;
}

export type BuildManagerHandoffResult =
  | {
      readonly ok: true;
      readonly snapshot: ManagerHandoffSnapshot;
      readonly bytes: Uint8Array;
      readonly sha256Hex: string;
    }
  | { readonly ok: false; readonly reason: HandoffRejectReason; readonly detail: string };

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
/** Namespaced reference: lowercase namespace + ':' + compact id part. No path/URL forms. */
const REF_PATTERN = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9_.:-]{1,223}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PUBLISHER_REVISION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}#[0-9]{1,32}$/;
const COVERAGE_STATES: ReadonlySet<string> = new Set(["complete", "partial", "none", "unknown"]);
const CANDIDATE_STATES: ReadonlySet<string> = new Set(["none", "proposed", "validated", "unknown"]);
const RUNTIME_STATES: ReadonlySet<string> = new Set(["idle", "active", "quiesced", "unknown"]);
const BOUNDARY_REASONS: ReadonlySet<string> = new Set([
  "first_slot",
  "new_local_day",
  "context_pressure",
]);

const encoder = new TextEncoder();
const byteLength = (value: string): number => encoder.encode(value).length;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasControlChar = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
};
export const isHandoffSafeId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= HANDOFF_MAX_ID_LENGTH &&
  ID_PATTERN.test(value) &&
  !hasControlChar(value);
const isForbiddenRefShape = (value: unknown): boolean =>
  typeof value === "string" &&
  (value.includes("/") ||
    value.includes("\\") ||
    value.includes("%") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("=") ||
    value.includes(" ") ||
    value.includes("://"));
export const isHandoffSafeRef = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 3 &&
  value.length <= HANDOFF_MAX_REF_LENGTH &&
  REF_PATTERN.test(value) &&
  !hasControlChar(value);
const isSafeBranch = (value: unknown): value is string =>
  typeof value === "string" &&
  BRANCH_PATTERN.test(value) &&
  !value.includes("..") &&
  !value.endsWith("/") &&
  !value.endsWith(".") &&
  !hasControlChar(value);
const isSafeCommit = (value: unknown): value is string =>
  typeof value === "string" && COMMIT_PATTERN.test(value);
const isPublisherRevision = (value: unknown): value is string =>
  typeof value === "string" && PUBLISHER_REVISION_PATTERN.test(value);
const isSafeCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const dispositionCheck = Schema.is(MissionResultDisposition);
const isDisposition = (value: unknown): value is MissionResultDisposition => dispositionCheck(value);

const daysInMonth = (y: number, m: number): number =>
  m === 2
    ? (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
      ? 29
      : 28
    : m === 4 || m === 6 || m === 9 || m === 11
      ? 30
      : 31;
const isCalendarDate = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (match === null) return false;
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  return y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
};
const isValidTimezone = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 128) return false;
  if (!/^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)*$/.test(value)) return false;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: value }).resolvedOptions().timeZone
      .length > 0;
  } catch {
    return false;
  }
};
const reject = (reason: HandoffRejectReason, detail: string): BuildManagerHandoffResult =>
  Object.freeze({ ok: false as const, reason, detail });
const hashText = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
export const serializeHandoffSnapshot = (
  snapshot: ManagerHandoffSnapshot,
): { readonly bytes: Uint8Array; readonly sha256Hex: string } => {
  const bytes = encoder.encode(stableStringify(snapshot));
  return { bytes, sha256Hex: NodeCrypto.createHash("sha256").update(bytes).digest("hex") };
};
const deepFreeze = (value: unknown): void => {
  if (Array.isArray(value)) {
    for (const e of value) deepFreeze(e);
    Object.freeze(value);
    return;
  }
  if (isRecord(value)) {
    for (const e of Object.values(value)) deepFreeze(e);
    Object.freeze(value);
  }
};
const unknownField = (): HandoffUnknown =>
  Object.freeze({ state: "unknown" as const, reason: "not-supplied" });
interface ProjectionFailure {
  readonly reason: HandoffRejectReason;
  readonly detail: string;
}
type Projection<T> = { readonly value: T } | { readonly failure: ProjectionFailure };
const failed = (reason: HandoffRejectReason, detail: string): Projection<never> => ({
  failure: { reason, detail },
});
const failedPointer = (detail: string, value: unknown): Projection<never> =>
  failed(isForbiddenRefShape(value) ? "forbidden_pointer" : "invalid_pointer", detail);
const isFailure = <T>(
  p: Projection<T>,
): p is { readonly failure: ProjectionFailure } => "failure" in p;
const keysBounded = (record: Record<string, unknown>): boolean =>
  Object.keys(record).length <= MAX_FACT_KEYS;

export const buildManagerHandoffSnapshot = (
  input: BuildManagerHandoffInput,
): BuildManagerHandoffResult => {
  if (!isRecord(input)) return reject("invalid_facts", "Handoff input is not an object.");
  const raw: Record<string, unknown> = input;
  const mission: unknown = raw.mission;
  if (!isRecord(mission)) return reject("invalid_mission", "Mission is not an object.");
  if (!isHandoffSafeId(mission.id)) return reject("invalid_mission", "Mission identity is not a safe id.");
  if (!isHandoffSafeId(mission.teamId)) return reject("invalid_mission", "Mission team is not a safe id.");
  if (!isHandoffSafeId(mission.authorityEnvironmentId))
    return reject("invalid_mission", "Mission environment is not a safe id.");
  if (!isSafeCount(mission.revision)) return reject("invalid_mission", "Mission revision is not a safe integer.");
  if (mission.status !== "active") return reject("mission_inactive", "Only active missions hand off.");
  const missionId = mission.id;
  const missionRevision = mission.revision;

  const intent: unknown = raw.intent;
  if (!isRecord(intent)) return reject("invalid_intent", "Rotation intent is not an object.");
  const role = intent.role;
  if (role !== "delivery" && role !== "retro")
    return reject("invalid_intent", "Intent role is not a canonical manager role.");
  const managers: unknown = mission.managers;
  const assignment: unknown = isRecord(managers) ? managers[role] : undefined;
  if (!isRecord(assignment) || !isHandoffSafeId(assignment.threadId) || !isSafeCount(assignment.epoch))
    return reject("invalid_mission", "Canonical mission has no bound manager for the role.");
  const currentThreadId = assignment.threadId;
  const currentEpoch = assignment.epoch;
  if (intent.missionId !== missionId) return reject("intent_mismatch", "Intent mission mismatch.");
  if (!isSafeCount(intent.observedRevision) || intent.observedRevision !== missionRevision)
    return reject("stale_intent", "Intent revision does not match canonical revision.");
  if (intent.currentThreadId !== currentThreadId || intent.currentEpoch !== currentEpoch)
    return reject("intent_mismatch", "Intent manager binding mismatch.");
  if (!isValidTimezone(intent.timezone)) return reject("invalid_boundary", "Intent timezone invalid.");
  if (!isCalendarDate(intent.localDate)) return reject("invalid_boundary", "Intent local date invalid.");
  if (!isSafeCount(intent.ordinal) || intent.ordinal > MAX_SAME_DAY_ORDINAL)
    return reject("invalid_boundary", "Intent ordinal out of bounds.");
  const boundaryReason = intent.reason;
  if (typeof boundaryReason !== "string" || !BOUNDARY_REASONS.has(boundaryReason))
    return reject("invalid_boundary", "Intent reason invalid.");
  const timezone = intent.timezone;
  const localDate = intent.localDate;
  const ordinal = intent.ordinal;

  const missionIntent: unknown = mission.intent;
  if (!isRecord(missionIntent)) return reject("invalid_mission", "Mission intent is not an object.");
  const rawDecisions: unknown = missionIntent.decisions;
  if (!Array.isArray(rawDecisions)) return reject("invalid_mission", "Mission decisions invalid.");
  if (rawDecisions.length > HANDOFF_MAX_ARRAY_ITEMS) return reject("array_overflow", "Decisions overflow.");
  const decisions: Array<HandoffDecisionPointer> = [];
  for (let index = 0; index < rawDecisions.length; index += 1) {
    const entry: unknown = rawDecisions[index];
    if (!isRecord(entry) || !isHandoffSafeId(entry.id))
      return reject("invalid_mission", "Mission decision identity invalid.");
    const authority: unknown = entry.authority;
    if (!isRecord(authority)) return reject("invalid_mission", "Decision authority invalid.");
    const source: unknown = authority.source;
    const ref: unknown = authority.ref;
    if (
      typeof source !== "string" || source.length === 0 || source.length > MAX_CANONICAL_TEXT_BYTES || byteLength(source) > MAX_CANONICAL_TEXT_BYTES ||
      typeof ref !== "string" || ref.length === 0 || ref.length > MAX_CANONICAL_TEXT_BYTES || byteLength(ref) > MAX_CANONICAL_TEXT_BYTES ||
      hasControlChar(source) || hasControlChar(ref)
    )
      return reject("string_overflow", "Decision authority exceeds bounded preimage.");
    decisions.push({
      id: entry.id,
      canonicalRef: `${missionId}@${missionRevision}:decision:${index}`,
      authorityDigest: hashText(stableStringify({ ref, source })),
    });
  }

  const rawScope: unknown = missionIntent.scope;
  if (!Array.isArray(rawScope)) return reject("invalid_mission", "Mission scope invalid.");
  if (rawScope.length > HANDOFF_MAX_ARRAY_ITEMS) return reject("array_overflow", "Scope overflow.");
  let scopeBytes = 0;
  for (const entry of rawScope) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_CANONICAL_TEXT_BYTES || hasControlChar(entry))
      return reject("string_overflow", "Mission scope entry invalid.");
    scopeBytes += byteLength(entry);
    if (byteLength(entry) > MAX_CANONICAL_TEXT_BYTES || scopeBytes > MAX_CANONICAL_LIST_BYTES)
      return reject("string_overflow", "Mission scope exceeds bounded preimage bytes.");
  }
  const scope: HandoffScopePointer = {
    count: rawScope.length,
    digest: hashText(stableStringify(rawScope)),
  };

  const rawAcceptance: unknown = missionIntent.acceptanceCriteria;
  if (!Array.isArray(rawAcceptance)) return reject("invalid_mission", "Acceptance invalid.");
  if (rawAcceptance.length > HANDOFF_MAX_ARRAY_ITEMS) return reject("array_overflow", "Acceptance overflow.");
  const acceptance: Array<HandoffAcceptancePointer> = [];
  for (const entry of rawAcceptance) {
    if (!isRecord(entry) || !isHandoffSafeId(entry.id))
      return reject("invalid_mission", "Acceptance identity invalid.");
    acceptance.push({ id: entry.id });
  }

  const taskIds = new Set<string>();
  const rawTasks: unknown = mission.tasks;
  if (rawTasks !== undefined) {
    if (!Array.isArray(rawTasks)) return reject("invalid_mission", "Mission tasks invalid.");
    // Canonical task list itself may exceed snapshot list bound; only membership matters.
    for (const task of rawTasks) {
      if (isRecord(task) && typeof task.id === "string") taskIds.add(task.id);
    }
  }
  const isKnownTask = (v: unknown): v is string => isHandoffSafeId(v) && taskIds.has(v);

  const projectOwnership = (values: unknown): Projection<HandoffListField<HandoffOwnershipPointer>> => {
    if (values === undefined) return { value: unknownField() };
    if (!Array.isArray(values)) return failed("invalid_facts", "Ownership is not a list.");
    if (values.length > HANDOFF_MAX_ARRAY_ITEMS) return failed("array_overflow", "Ownership overflow.");
    const items: Array<HandoffOwnershipPointer> = [];
    for (const entry of values) {
      if (!isRecord(entry) || !keysBounded(entry) || !isKnownTask(entry.taskId))
        return failed("unknown_task_ref", "Ownership task is not canonical.");
      const p: { taskId: string; threadId?: string; runId?: string; attemptNumber?: number } = { taskId: entry.taskId };
      if (entry.threadId !== undefined) {
        if (!isHandoffSafeId(entry.threadId)) return failed("invalid_pointer", "Ownership thread invalid.");
        p.threadId = entry.threadId;
      }
      if (entry.runId !== undefined) {
        if (!isHandoffSafeId(entry.runId)) return failed("invalid_pointer", "Ownership run invalid.");
        p.runId = entry.runId;
      }
      if (entry.attemptNumber !== undefined) {
        if (!isSafeCount(entry.attemptNumber)) return failed("invalid_facts", "Attempt invalid.");
        p.attemptNumber = entry.attemptNumber;
      }
      items.push(p);
    }
    return { value: { state: "known", items } };
  };

  const projectResults = (values: unknown): Projection<HandoffListField<HandoffResultPointer>> => {
    if (values === undefined) return { value: unknownField() };
    if (!Array.isArray(values)) return failed("invalid_facts", "Pending results is not a list.");
    if (values.length > HANDOFF_MAX_ARRAY_ITEMS) return failed("array_overflow", "Results overflow.");
    const items: Array<HandoffResultPointer> = [];
    for (const entry of values) {
      if (!isRecord(entry) || !keysBounded(entry) || !isKnownTask(entry.taskId))
        return failed("unknown_task_ref", "Result task is not canonical.");
      const p: {
        taskId: string; dispatchKey?: string; resultRevision?: number; commandId?: string;
        disposition?: MissionResultDisposition;
      } = { taskId: entry.taskId };
      if (entry.dispatchKey !== undefined) {
        if (!isHandoffSafeId(entry.dispatchKey)) return failed("invalid_pointer", "Dispatch key invalid.");
        p.dispatchKey = entry.dispatchKey;
      }
      if (entry.resultRevision !== undefined) {
        if (!isSafeCount(entry.resultRevision)) return failed("invalid_facts", "Result revision invalid.");
        p.resultRevision = entry.resultRevision;
      }
      if (entry.commandId !== undefined) {
        if (!isHandoffSafeId(entry.commandId)) return failed("invalid_pointer", "Command invalid.");
        p.commandId = entry.commandId;
      }
      if (entry.disposition !== undefined) {
        if (!isDisposition(entry.disposition)) return failed("invalid_pointer", "Disposition is not a canonical MissionResultDisposition.");
        p.disposition = entry.disposition;
      }
      items.push(p);
    }
    return { value: { state: "known", items } };
  };

  const projectIdRefs = (values: unknown, label: string): Projection<HandoffListField<HandoffIdRefPointer>> => {
    if (values === undefined) return { value: unknownField() };
    if (!Array.isArray(values)) return failed("invalid_facts", `${label} is not a list.`);
    if (values.length > HANDOFF_MAX_ARRAY_ITEMS) return failed("array_overflow", `${label} overflow.`);
    const items: Array<HandoffIdRefPointer> = [];
    for (const entry of values) {
      if (!isRecord(entry) || !keysBounded(entry) || !isHandoffSafeId(entry.id))
        return failed("invalid_pointer", `${label} entry invalid.`);
      if (entry.ref !== undefined && !isHandoffSafeRef(entry.ref))
        return failedPointer(`${label} reference invalid.`, entry.ref);
      const p: { id: string; ref?: string } = { id: entry.id };
      if (entry.ref !== undefined && isHandoffSafeRef(entry.ref)) p.ref = entry.ref;
      items.push(p);
    }
    return { value: { state: "known", items } };
  };

  const projectHolds = (values: unknown): Projection<HandoffListField<HandoffHoldPointer>> => {
    if (values === undefined) return { value: unknownField() };
    if (!Array.isArray(values)) return failed("invalid_facts", "Holds is not a list.");
    if (values.length > HANDOFF_MAX_ARRAY_ITEMS) return failed("array_overflow", "Holds overflow.");
    const items: Array<HandoffHoldPointer> = [];
    for (const entry of values) {
      if (!isRecord(entry) || !keysBounded(entry) || !isHandoffSafeId(entry.holdId))
        return failed("invalid_pointer", "Hold invalid.");
      if (entry.keepAliveRef !== undefined && !isHandoffSafeRef(entry.keepAliveRef))
        return failedPointer("Keep-alive reference invalid.", entry.keepAliveRef);
      const p: { holdId: string; keepAliveRef?: string } = { holdId: entry.holdId };
      if (entry.keepAliveRef !== undefined && isHandoffSafeRef(entry.keepAliveRef)) p.keepAliveRef = entry.keepAliveRef;
      items.push(p);
    }
    return { value: { state: "known", items } };
  };

  const projectIntegration = (facts: unknown): Projection<HandoffValueField<HandoffIntegrationValue>> => {
    if (facts === undefined) return { value: unknownField() };
    if (!isRecord(facts) || !keysBounded(facts)) return failed("invalid_facts", "Integration facts invalid.");
    const { branch, buildRef, commit } = facts;
    if (branch === undefined && buildRef === undefined && commit === undefined)
      return failed("invalid_facts", "Integration carries no pointer.");
    if (branch !== undefined && !isSafeBranch(branch)) return failedPointer("Integration branch invalid.", branch);
    if (buildRef !== undefined && !isHandoffSafeRef(buildRef)) return failedPointer("Integration buildRef invalid.", buildRef);
    if (commit !== undefined && !isSafeCommit(commit)) return failedPointer("Integration commit must be full 40/64 hex.", commit);
    const value: { branch?: string; buildRef?: string; commit?: string } = {};
    if (branch !== undefined && isSafeBranch(branch)) value.branch = branch;
    if (buildRef !== undefined && isHandoffSafeRef(buildRef)) value.buildRef = buildRef;
    if (commit !== undefined && isSafeCommit(commit)) value.commit = commit;
    return { value: { state: "known", value } };
  };

  const projectCoverage = (facts: unknown): Projection<HandoffValueField<HandoffCoverageValue>> => {
    if (facts === undefined) return { value: unknownField() };
    if (!isRecord(facts) || !keysBounded(facts)) return failed("invalid_facts", "Coverage facts invalid.");
    if (
      typeof facts.coverage !== "string" || !COVERAGE_STATES.has(facts.coverage) ||
      typeof facts.candidate !== "string" || !CANDIDATE_STATES.has(facts.candidate) ||
      typeof facts.runtime !== "string" || !RUNTIME_STATES.has(facts.runtime)
    ) return failed("invalid_facts", "Coverage state invalid.");
    if (facts.reportRef !== undefined && !isHandoffSafeRef(facts.reportRef))
      return failedPointer("Report ref invalid.", facts.reportRef);
    if (facts.candidateRef !== undefined && !isHandoffSafeRef(facts.candidateRef))
      return failedPointer("Candidate ref invalid.", facts.candidateRef);
    const value: {
      coverage: HandoffCoverageState; reportRef?: string; candidate: HandoffCandidateState;
      candidateRef?: string; runtime: HandoffRuntimeState;
    } = {
      coverage: facts.coverage as HandoffCoverageState,
      candidate: facts.candidate as HandoffCandidateState,
      runtime: facts.runtime as HandoffRuntimeState,
    };
    if (facts.reportRef !== undefined && isHandoffSafeRef(facts.reportRef)) value.reportRef = facts.reportRef;
    if (facts.candidateRef !== undefined && isHandoffSafeRef(facts.candidateRef)) value.candidateRef = facts.candidateRef;
    return { value: { state: "known", value } };
  };

  const projectRoutePolicy = (facts: unknown): Projection<HandoffValueField<HandoffRoutePolicyValue>> => {
    if (facts === undefined) return { value: unknownField() };
    if (!isRecord(facts) || !keysBounded(facts)) return failed("invalid_facts", "Route-policy facts invalid.");
    if (!isHandoffSafeRef(facts.ref)) return failedPointer("Route-policy ref invalid.", facts.ref);
    if (facts.revision !== undefined && !isPublisherRevision(facts.revision))
      return failed("invalid_facts", "Route-policy revision must be publisher string '<uuid>#<counter>'.");
    const value: { ref: string; revision?: string } = { ref: facts.ref };
    if (facts.revision !== undefined && isPublisherRevision(facts.revision)) value.revision = facts.revision;
    return { value: { state: "known", value } };
  };

  const projectDeadline = (facts: unknown): Projection<HandoffValueField<HandoffDeadlineValue>> => {
    if (facts === undefined) return { value: unknownField() };
    if (!isRecord(facts) || !keysBounded(facts)) return failed("invalid_facts", "Deadline facts invalid.");
    if (facts.cursor === undefined && facts.ref === undefined) return failed("invalid_facts", "Deadline empty.");
    if (facts.cursor !== undefined && !isSafeCount(facts.cursor)) return failed("invalid_facts", "Deadline cursor invalid.");
    if (facts.ref !== undefined && !isHandoffSafeRef(facts.ref)) return failedPointer("Deadline ref invalid.", facts.ref);
    const value: { cursor?: number; ref?: string } = {};
    if (facts.cursor !== undefined && isSafeCount(facts.cursor)) value.cursor = facts.cursor;
    if (facts.ref !== undefined && isHandoffSafeRef(facts.ref)) value.ref = facts.ref;
    return { value: { state: "known", value } };
  };

  const projectPredecessor = (facts: unknown): Projection<HandoffValueField<HandoffPredecessorValue>> => {
    if (facts === undefined) return { value: unknownField() };
    if (!isRecord(facts) || !keysBounded(facts)) return failed("invalid_predecessor", "Predecessor facts invalid.");
    if (facts.missionId !== missionId || facts.teamId !== mission.teamId ||
      facts.environmentId !== mission.authorityEnvironmentId || facts.role !== role)
      return failed("predecessor_scope_mismatch", "Predecessor scope diverges.");
    if (!isHandoffSafeId(facts.managerThreadId) || facts.managerThreadId === currentThreadId)
      return failed("invalid_predecessor", "Predecessor manager must be distinct.");
    if (!isSafeCount(facts.epoch)) return failed("invalid_predecessor", "Predecessor epoch invalid.");
    if (facts.epoch >= currentEpoch)
      return failed("invalid_predecessor", "Predecessor epoch must be older than current epoch.");
    if (facts.localDate !== undefined && !isCalendarDate(facts.localDate))
      return failed("invalid_predecessor", "Predecessor date must be a real string calendar date.");
    if (facts.ordinal !== undefined && (!isSafeCount(facts.ordinal) || facts.ordinal > MAX_SAME_DAY_ORDINAL))
      return failed("invalid_predecessor", "Predecessor ordinal out of bounds.");
    const value: {
      missionId: string; teamId: string; environmentId: string;
      role: PreparedRotationIntent["role"]; managerThreadId: string; epoch: number;
      localDate?: string; ordinal?: number;
    } = {
      missionId: facts.missionId as string, teamId: facts.teamId as string,
      environmentId: facts.environmentId as string,
      role: facts.role as PreparedRotationIntent["role"],
      managerThreadId: facts.managerThreadId, epoch: facts.epoch,
    };
    if (facts.localDate !== undefined && isCalendarDate(facts.localDate)) value.localDate = facts.localDate;
    if (facts.ordinal !== undefined && isSafeCount(facts.ordinal)) value.ordinal = facts.ordinal;
    return { value: { state: "known", value } };
  };

  const ownership = projectOwnership(raw.ownership);
  if (isFailure(ownership)) return reject(ownership.failure.reason, ownership.failure.detail);
  const pendingResults = projectResults(raw.pendingResults);
  if (isFailure(pendingResults)) return reject(pendingResults.failure.reason, pendingResults.failure.detail);
  const blockers = projectIdRefs(raw.blockers, "Blocker");
  if (isFailure(blockers)) return reject(blockers.failure.reason, blockers.failure.detail);
  const nextActions = projectIdRefs(raw.nextActions, "Next action");
  if (isFailure(nextActions)) return reject(nextActions.failure.reason, nextActions.failure.detail);
  const resourceHolds = projectHolds(raw.resourceHolds);
  if (isFailure(resourceHolds)) return reject(resourceHolds.failure.reason, resourceHolds.failure.detail);
  const integration = projectIntegration(raw.integration);
  if (isFailure(integration)) return reject(integration.failure.reason, integration.failure.detail);
  const coverage = projectCoverage(raw.coverage);
  if (isFailure(coverage)) return reject(coverage.failure.reason, coverage.failure.detail);
  const routePolicy = projectRoutePolicy(raw.routePolicy);
  if (isFailure(routePolicy)) return reject(routePolicy.failure.reason, routePolicy.failure.detail);
  const deadline = projectDeadline(raw.deadline);
  if (isFailure(deadline)) return reject(deadline.failure.reason, deadline.failure.detail);
  const predecessor = projectPredecessor(raw.predecessor);
  if (isFailure(predecessor)) return reject(predecessor.failure.reason, predecessor.failure.detail);

  const snapshot: ManagerHandoffSnapshot = {
    schemaVersion: HANDOFF_SNAPSHOT_SCHEMA_VERSION,
    serialization: { encoding: "utf8-json", canonicalization: "stable-stringify-v1" },
    mission: { ref: missionId, revision: missionRevision, teamId: mission.teamId, environmentId: mission.authorityEnvironmentId },
    manager: { role, threadId: currentThreadId, epoch: currentEpoch },
    boundary: {
      timezone, localDate, ordinal,
      reason: boundaryReason as RotationDueReason,
    },
    decisions, scope, acceptance,
    ownership: ownership.value, pendingResults: pendingResults.value,
    integration: integration.value, coverage: coverage.value,
    resourceHolds: resourceHolds.value, routePolicy: routePolicy.value,
    blockers: blockers.value, nextActions: nextActions.value,
    deadline: deadline.value, predecessor: predecessor.value,
  };
  const { bytes, sha256Hex } = serializeHandoffSnapshot(snapshot);
  if (bytes.length > HANDOFF_MAX_SERIALIZED_BYTES)
    return reject("byte_overflow", "Serialized handoff exceeds 64KiB.");
  deepFreeze(snapshot);
  return Object.freeze({ ok: true as const, snapshot, bytes, sha256Hex });
};





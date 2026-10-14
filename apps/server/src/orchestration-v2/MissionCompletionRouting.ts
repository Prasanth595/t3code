// @effect-diagnostics nodeBuiltinImport:off -- deterministic notification identities bind immutable completion keys.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { MissionResultRecord } from "../../../../packages/contracts/src/missionResult.ts";
import { MissionExecutionAdmission } from "../../../../packages/contracts/src/missionExecution.ts";
import { MissionRetroCheckpoint } from "../../../../packages/contracts/src/missionRetro.ts";
import { MissionRetroAnalysis } from "../../../../packages/contracts/src/missionRetroAnalysis.ts";
import { MissionRetroReportReceipt } from "../../../../packages/contracts/src/missionRetroReportReceipt.ts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import type { Mission } from "../../../../packages/contracts/src/mission.ts";
import {
  MAX_MISSION_EXECUTION_ADMISSIONS,
  MAX_MISSION_EXECUTION_RESULTS,
} from "../../../../packages/contracts/src/missionExecution.ts";
import { MAX_MISSION_RETRO_CHECKPOINTS } from "../../../../packages/contracts/src/missionRetro.ts";
import { MAX_MISSION_RETRO_ANALYSES } from "../../../../packages/contracts/src/missionRetroAnalysis.ts";
import { MAX_MISSION_RETRO_REPORT_RECEIPTS } from "../../../../packages/contracts/src/missionRetroReportReceipt.ts";
import {
  isHandoffOpaqueRunId,
  isHandoffOpaqueThreadId,
  isHandoffSafeId,
  isHandoffSafeRef,
} from "./MissionManagerHandoff.ts";

/**
 * Pure bounded P3 role-aware completion-route CANDIDATE resolver (offline).
 * Maps an EXACT persisted canonical completion onto the CURRENT role manager
 * (delivery for task-result, retro for retro-report) at the current epoch and
 * canonical revision. Stale legacy parentThreadId is never read. Candidate
 * only: never sets completionRoutingReady, launches, wakes, dispatches, or
 * marks observed/reviewed/accepted/integrated. Unknown, missing, duplicate,
 * drifted, foreign, or malformed tuples hold finitely; no inferred authority.
 */
export type CompletionTargetRole = "delivery" | "retro";
export interface CompletionScope {
  readonly teamId: string;
  readonly environmentId: string;
  readonly missionId: string;
}
export interface TaskResultCompletionReference {
  readonly kind: "task-result";
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly resultRevision: number;
  readonly childTaskId: string;
  readonly childThreadId: string;
  readonly childRunId: string;
}
export interface RetroReportCompletionReference {
  readonly kind: "retro-report";
  readonly checkpointId: string;
  readonly teamId: string;
  readonly environmentId: string;
  readonly missionId: string;
  readonly sourceThreadId: string;
  readonly sourceRoot: string;
  readonly snapshotFingerprint: string;
  readonly coveredFromInclusive: number;
  readonly coveredToExclusive: number;
  readonly normalizedReportHash: string;
  readonly sourceReportHash: string;
  readonly reportRevision: number;
  readonly reporterChildThreadId: string;
  readonly reporterRunId: string;
}
export type CompletionReference = TaskResultCompletionReference | RetroReportCompletionReference;
export interface ResolveCompletionRouteInput {
  readonly mission: Mission;
  readonly scope: CompletionScope;
  readonly completion: CompletionReference;
}
export type CompletionSourceBinding =
  | ({
      readonly kind: "task-result";
    } & Omit<TaskResultCompletionReference, "kind">)
  | ({
      readonly kind: "retro-report";
    } & Omit<RetroReportCompletionReference, "kind">);
/** Frozen candidate: current target + complete scope/source to re-resolve exactly later. */
export interface CompletionRouteCandidate {
  readonly missionId: string;
  readonly scope: CompletionScope;
  readonly role: CompletionTargetRole;
  readonly targetThreadId: string;
  readonly targetEpoch: number;
  readonly canonicalRevision: number;
  readonly notificationId: string;
  readonly observedRevision: number;
  readonly observedThreadId: string;
  readonly observedEpoch: number;
  readonly source: CompletionSourceBinding;
}
export type CompletionHoldReason =
  | "malformed_input"
  | "scope_mismatch"
  | "mission_inactive"
  | "missing_manager"
  | "unknown_completion"
  | "ambiguous_completion"
  | "source_mismatch"
  | "unresolved_source";
export type CompletionRouteDecision =
  | { readonly kind: "candidate"; readonly candidate: CompletionRouteCandidate }
  | {
      readonly kind: "hold";
      readonly missionId: string;
      readonly reason: CompletionHoldReason;
      readonly detail: string;
    };

const isResultRecord = Schema.is(MissionResultRecord);
const isAdmission = Schema.is(MissionExecutionAdmission);
const isCheckpoint = Schema.is(MissionRetroCheckpoint);
const isAnalysis = Schema.is(MissionRetroAnalysis);
const isReceipt = Schema.is(MissionRetroReportReceipt);

const SHA_HEX = /^[0-9a-f]{64}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: ReadonlyArray<string>): boolean => {
  const actual = Object.keys(v).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((k, i) => k === expected[i]);
};
const isCounter = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isSha = (v: unknown): v is string => typeof v === "string" && SHA_HEX.test(v);
const isThreadId = (v: unknown): v is string => isHandoffSafeId(v) || isHandoffOpaqueThreadId(v);
const isRunId = (v: unknown): v is string => isHandoffSafeId(v) || isHandoffOpaqueRunId(v);
/** Actual delegated child-task IDs: compact, or node:delegated-task with bounded %-encoding. */
const OPAQUE_PATTERN = /^(?:[A-Za-z0-9_.:-]|%(?:25|3[aA]))+$/;
const isChildTaskId = (v: unknown): v is string => {
  if (isHandoffSafeId(v)) return true;
  if (typeof v !== "string" || v.length > 512 || !v.startsWith("node:") || !/%(?:3a|25)/i.test(v)) {
    return false;
  }
  let inspected = v;
  for (let depth = 0; depth <= 512; depth += 1) {
    if (!OPAQUE_PATTERN.test(inspected) || inspected.includes("..")) return false;
    if (!inspected.includes("%")) return true;
    inspected = inspected.replace(/%(25|3a)/gi, (_m, c: string) => (c === "25" ? "%" : ":"));
  }
  return false;
};
const sha256Hex = (parts: ReadonlyArray<string | number>): string =>
  NodeCrypto.createHash("sha256").update(stableStringify(parts), "utf8").digest("hex");
const freezeDecision = (d: CompletionRouteDecision): CompletionRouteDecision => {
  if (d.kind === "candidate") {
    Object.freeze(d.candidate.source);
    Object.freeze(d.candidate.scope);
    Object.freeze(d.candidate);
  }
  return Object.freeze(d);
};
const hold = (missionId: string, reason: CompletionHoldReason, detail: string): CompletionRouteDecision =>
  freezeDecision({ kind: "hold", missionId, reason, detail });
const missionIdOf = (input: unknown): string =>
  isRecord(input) && isRecord(input.mission) && isHandoffSafeId(input.mission.id)
    ? (input.mission.id as string)
    : "unknown";

const SCOPE_KEYS = ["teamId", "environmentId", "missionId"] as const;
const TASK_KEYS = ["kind", "taskId", "attemptNumber", "resultRevision", "childTaskId", "childThreadId", "childRunId"] as const;
const RETRO_KEYS = [
  "kind", "checkpointId", "teamId", "environmentId", "missionId", "sourceThreadId", "sourceRoot",
  "snapshotFingerprint", "coveredFromInclusive", "coveredToExclusive", "normalizedReportHash",
  "sourceReportHash", "reportRevision", "reporterChildThreadId", "reporterRunId",
] as const;
const isValidScope = (s: unknown): s is CompletionScope =>
  isRecord(s) && exactKeys(s, SCOPE_KEYS) && isHandoffSafeId(s.teamId) &&
  isHandoffSafeId(s.environmentId) && isHandoffSafeId(s.missionId);
const isValidTaskRef = (r: unknown): r is TaskResultCompletionReference =>
  isRecord(r) && exactKeys(r, TASK_KEYS) && r.kind === "task-result" && isHandoffSafeId(r.taskId) &&
  isCounter(r.attemptNumber) && isCounter(r.resultRevision) && isChildTaskId(r.childTaskId) &&
  isThreadId(r.childThreadId) && isRunId(r.childRunId);
const isValidRetroRef = (r: unknown): r is RetroReportCompletionReference =>
  isRecord(r) && exactKeys(r, RETRO_KEYS) && r.kind === "retro-report" && isHandoffSafeId(r.checkpointId) &&
  isHandoffSafeId(r.teamId) && isHandoffSafeId(r.environmentId) && isHandoffSafeId(r.missionId) &&
  isThreadId(r.sourceThreadId) && isHandoffSafeRef(r.sourceRoot) && isSha(r.snapshotFingerprint) &&
  isCounter(r.coveredFromInclusive) && isCounter(r.coveredToExclusive) &&
  (r.coveredFromInclusive as number) < (r.coveredToExclusive as number) &&
  isSha(r.normalizedReportHash) && isSha(r.sourceReportHash) && isCounter(r.reportRevision) &&
  (r.reportRevision as number) > 0 && isThreadId(r.reporterChildThreadId) && isRunId(r.reporterRunId);

interface ExecArrays {
  readonly results: ReadonlyArray<Record<string, unknown>>;
  readonly admissions: ReadonlyArray<Record<string, unknown>>;
  readonly receipts: ReadonlyArray<Record<string, unknown>>;
  readonly checkpoints: ReadonlyArray<Record<string, unknown>>;
  readonly analyses: ReadonlyArray<Record<string, unknown>>;
}
/** Guarded execution read: non-object execution or malformed/oversize arrays hold, never throw or fake empty. */
const readExecution = (mission: Record<string, unknown>): ExecArrays | null => {
  const raw = mission.execution;
  if (raw === undefined) return { results: [], admissions: [], receipts: [], checkpoints: [], analyses: [] };
  if (!isRecord(raw)) return null;
  const get = (key: string, cap: number): ReadonlyArray<Record<string, unknown>> | null => {
    const v = raw[key];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > cap) return null;
    return v.every((row) => isRecord(row)) ? (v as ReadonlyArray<Record<string, unknown>>) : null;
  };
  const results = get("results", MAX_MISSION_EXECUTION_RESULTS);
  const admissions = get("admissions", MAX_MISSION_EXECUTION_ADMISSIONS);
  const receipts = get("retroReportReceipts", MAX_MISSION_RETRO_REPORT_RECEIPTS);
  const checkpoints = get("retroCheckpoints", MAX_MISSION_RETRO_CHECKPOINTS);
  const analyses = get("retroAnalyses", MAX_MISSION_RETRO_ANALYSES);
  if (!results || !admissions || !receipts || !checkpoints || !analyses) return null;
  return { results, admissions, receipts, checkpoints, analyses };
};
const str = (row: Record<string, unknown>, k: string): string | null =>
  typeof row[k] === "string" ? (row[k] as string) : null;
const num = (row: Record<string, unknown>, k: string): number | null =>
  isCounter(row[k]) ? (row[k] as number) : null;

export const resolveCompletionRoute = (input: ResolveCompletionRouteInput): CompletionRouteDecision => {
  if (!isRecord(input) || !exactKeys(input, ["mission", "scope", "completion"])) {
    return hold("unknown", "malformed_input", "Route input must carry exactly mission, scope, and completion.");
  }
  const missionId = missionIdOf(input);
  const mission = input.mission;
  if (!isRecord(mission)) return hold(missionId, "malformed_input", "Mission must be an object.");
  if (!isValidScope(input.scope)) return hold(missionId, "malformed_input", "Scope IDs or shape are malformed.");
  const scope = input.scope;
  const completion = input.completion;
  const validRef = isValidTaskRef(completion) || isValidRetroRef(completion);
  if (!validRef) return hold(missionId, "malformed_input", "Completion reference IDs, counters, hashes, or shape are malformed.");
  if (!isHandoffSafeId(mission.id) || !isCounter(mission.revision) || !isHandoffSafeId(mission.teamId)) {
    return hold(missionId, "malformed_input", "Mission identity or revision is malformed.");
  }
  const mid = mission.id as string;
  if (scope.missionId !== mid || scope.teamId !== mission.teamId) {
    return hold(mid, "scope_mismatch", "Scope team or mission does not match the canonical mission.");
  }
  if (!isHandoffSafeId(mission.authorityEnvironmentId) || scope.environmentId !== mission.authorityEnvironmentId) {
    return hold(mid, "scope_mismatch", "Scope environment does not match the canonical mission.");
  }
  if (mission.status !== "active") {
    if (mission.status !== "paused" && mission.status !== "completed" && mission.status !== "stopped") {
      return hold(mid, "malformed_input", "Mission status is malformed.");
    }
    return hold(mid, "mission_inactive", "Mission is not active; source preserved but cannot route now.");
  }
  const role: CompletionTargetRole = completion.kind === "task-result" ? "delivery" : "retro";
  const managers = isRecord(mission.managers) ? mission.managers : null;
  const assignment = managers && isRecord(managers[role]) ? (managers[role] as Record<string, unknown>) : null;
  const targetThreadId = assignment && isThreadId(assignment.threadId) ? (assignment.threadId as string) : null;
  const targetEpoch = assignment && isCounter(assignment.epoch) ? (assignment.epoch as number) : null;
  if (targetThreadId === null || targetEpoch === null) {
    return hold(mid, "missing_manager", "Current role manager is unassigned; no legacy parent fallback is permitted.");
  }
  const exec = readExecution(mission);
  if (!exec) return hold(mid, "malformed_input", "Persisted execution rows are malformed or exceed canonical caps.");
  const canonicalRevision = mission.revision as number;
  const scopeCopy: CompletionScope = { teamId: scope.teamId, environmentId: scope.environmentId, missionId: scope.missionId };

  if (completion.kind === "task-result") {
    // Exact unique canonical task + project binding.
    if (!Array.isArray(mission.tasks) || !Array.isArray(mission.bindings)) {
      return hold(mid, "malformed_input", "Canonical tasks or bindings are malformed.");
    }
    if (mission.tasks.some((t: unknown) => !isRecord(t)) || mission.bindings.some((b: unknown) => !isRecord(b))) {
      return hold(mid, "malformed_input", "Canonical task or binding rows are malformed.");
    }
    const tasks = (mission.tasks as ReadonlyArray<Record<string, unknown>>).filter((t) => t.id === completion.taskId);
    if (tasks.length === 0) return hold(mid, "unknown_completion", "Completion task is absent from the canonical mission.");
    if (tasks.length > 1) return hold(mid, "ambiguous_completion", "Duplicate canonical tasks match; refusing to choose.");
    const task = tasks[0]!;
    if (!isHandoffSafeId(task.projectId)) return hold(mid, "malformed_input", "Canonical task project binding is malformed.");
    const bindings = (mission.bindings as ReadonlyArray<Record<string, unknown>>).filter((b) => b.projectId === task.projectId);
    if (bindings.length !== 1) {
      return hold(mid, "unresolved_source", "Canonical task project binding is missing or ambiguous.");
    }
    // Exact unique persisted admission for this task attempt in scope.
    const admissions = exec.admissions.filter(
      (a) => str(a, "taskId") === completion.taskId && num(a, "attemptNumber") === completion.attemptNumber &&
        str(a, "missionId") === mid && str(a, "teamId") === scope.teamId && str(a, "environmentId") === scope.environmentId,
    );
    if (admissions.length === 0) return hold(mid, "unresolved_source", "No persisted admission binds this task attempt.");
    if (admissions.length > 1) return hold(mid, "ambiguous_completion", "Duplicate persisted admissions match; refusing to choose.");
    // Duplicate keyed records deny even when only one provenance matches.
    const keyed = exec.results.filter(
      (r) => str(r, "taskId") === completion.taskId && num(r, "attemptNumber") === completion.attemptNumber,
    );
    if (keyed.length === 0) return hold(mid, "unknown_completion", "No persisted task-result record matches the reference.");
    if (keyed.length > 1) return hold(mid, "ambiguous_completion", "Duplicate persisted task-result records match; refusing to choose.");
    const record = keyed[0]!;
    if (!isResultRecord(record) || !isAdmission(admissions[0])) {
      return hold(mid, "malformed_input", "Persisted result or admission evidence is incomplete.");
    }
    const prov = record.provenance;
    if (!isRecord(prov)) return hold(mid, "malformed_input", "Persisted result provenance is malformed.");
    if (
      num(prov, "resultRevision") !== completion.resultRevision || str(prov, "childTaskId") !== completion.childTaskId ||
      str(prov, "childThreadId") !== completion.childThreadId || str(prov, "childRunId") !== completion.childRunId
    ) {
      return hold(mid, "source_mismatch", "Task-result revision or producing run drifted from the persisted record.");
    }
    const source: CompletionSourceBinding = {
      kind: "task-result", taskId: completion.taskId, attemptNumber: completion.attemptNumber,
      resultRevision: completion.resultRevision, childTaskId: completion.childTaskId,
      childThreadId: completion.childThreadId, childRunId: completion.childRunId,
    };
    return freezeDecision({
      kind: "candidate",
      candidate: {
        missionId: mid, scope: scopeCopy, role, targetThreadId, targetEpoch, canonicalRevision,
        notificationId: sha256Hex(["completion-route-v1", "task-result", mid, completion.taskId, completion.attemptNumber, completion.resultRevision, completion.childTaskId, completion.childThreadId, completion.childRunId]),
        observedRevision: canonicalRevision, observedThreadId: targetThreadId, observedEpoch: targetEpoch, source,
      },
    });
  }

  // Retro: exact receipt, then EXACT ONE full checkpoint and EXACT ONE lease-bound analysis.
  const keyed = exec.receipts.filter(
    (r) => str(r, "checkpointId") === completion.checkpointId && num(r, "reportRevision") === completion.reportRevision,
  );
  if (keyed.length === 0) return hold(mid, "unknown_completion", "No persisted retro-report receipt matches the reference.");
  if (keyed.length > 1) return hold(mid, "ambiguous_completion", "Duplicate persisted retro-report receipts match; refusing to choose.");
  const receipt = keyed[0]!;
  if (!isReceipt(receipt)) return hold(mid, "malformed_input", "Persisted report evidence is incomplete.");
  const receiptTuple: ReadonlyArray<readonly [string, string | number | null]> = [
    ["teamId", completion.teamId], ["environmentId", completion.environmentId], ["missionId", completion.missionId],
    ["sourceThreadId", completion.sourceThreadId], ["sourceRoot", completion.sourceRoot],
    ["snapshotFingerprint", completion.snapshotFingerprint], ["coveredFromInclusive", completion.coveredFromInclusive],
    ["coveredToExclusive", completion.coveredToExclusive], ["normalizedReportHash", completion.normalizedReportHash],
    ["sourceReportHash", completion.sourceReportHash], ["reporterChildThreadId", completion.reporterChildThreadId],
    ["reporterRunId", completion.reporterRunId],
  ];
  for (const [k, expected] of receiptTuple) {
    const actual = typeof expected === "number" ? num(receipt, k) : str(receipt, k);
    if (actual !== expected) {
      return hold(mid, "source_mismatch", "Retro-report hashes, range, or reporter run drifted from the persisted receipt.");
    }
  }
  if (completion.teamId !== scope.teamId || completion.environmentId !== scope.environmentId || completion.missionId !== scope.missionId) {
    return hold(mid, "scope_mismatch", "Retro completion scope does not match the trusted scope.");
  }
  const checkpoints = exec.checkpoints.filter((c) => str(c, "checkpointId") === completion.checkpointId);
  if (checkpoints.length === 0) return hold(mid, "unresolved_source", "Retro receipt checkpoint association is unresolved.");
  if (checkpoints.length > 1) return hold(mid, "ambiguous_completion", "Duplicate checkpoints share the checkpoint ID; refusing to choose.");
  const checkpoint = checkpoints[0]!;
  if (!isCheckpoint(checkpoint)) return hold(mid, "malformed_input", "Persisted checkpoint evidence is incomplete.");
  for (const [k, expected] of receiptTuple.slice(0, 8)) {
    const actual = typeof expected === "number" ? num(checkpoint, k) : str(checkpoint, k);
    if (actual !== expected) return hold(mid, "source_mismatch", "Checkpoint source tuple drifted from the persisted receipt.");
  }
  const analyses = exec.analyses.filter((a) => str(a, "checkpointId") === completion.checkpointId);
  if (analyses.length === 0) return hold(mid, "unresolved_source", "Retro receipt analysis association is unresolved.");
  if (analyses.length > 1) return hold(mid, "ambiguous_completion", "Duplicate analyses share the checkpoint ID; refusing to choose.");
  const analysis = analyses[0]!;
  if (!isAnalysis(analysis)) return hold(mid, "malformed_input", "Persisted analysis evidence is incomplete.");
  for (const [k, expected] of receiptTuple.slice(0, 8)) {
    const actual = typeof expected === "number" ? num(analysis, k) : str(analysis, k);
    if (actual !== expected) return hold(mid, "source_mismatch", "Analysis source tuple drifted from the persisted receipt.");
  }
  const lease = analysis.lease;
  if (!isRecord(lease)) {
    return hold(mid, "unresolved_source", "Retro analysis has no durable lease binding the receipt; refusing to invent proof.");
  }
  const leaseChecks: boolean =
    str(lease, "assignmentToken") === str(receipt, "assignmentToken") &&
    str(lease, "reporterChildThreadId") === completion.reporterChildThreadId &&
    str(lease, "reporterRunId") === completion.reporterRunId &&
    num(lease, "reportRevision") === completion.reportRevision &&
    str(lease, "accountId") === str(receipt, "accountId") &&
    str(lease, "providerInstanceId") === str(receipt, "providerInstanceId") &&
    str(lease, "modelId") === str(receipt, "modelId") &&
    str(lease, "profile") === str(receipt, "profile") &&
    num(analysis, "fence") === num(receipt, "fence") &&
    num(analysis, "attemptNumber") === num(receipt, "attemptNumber");
  if (!leaseChecks) {
    return hold(mid, "source_mismatch", "Retro analysis lease does not bind the persisted receipt tuple.");
  }
  const source: CompletionSourceBinding = {
    kind: "retro-report", checkpointId: completion.checkpointId, teamId: completion.teamId,
    environmentId: completion.environmentId, missionId: completion.missionId,
    sourceThreadId: completion.sourceThreadId, sourceRoot: completion.sourceRoot,
    snapshotFingerprint: completion.snapshotFingerprint, coveredFromInclusive: completion.coveredFromInclusive,
    coveredToExclusive: completion.coveredToExclusive, normalizedReportHash: completion.normalizedReportHash,
    sourceReportHash: completion.sourceReportHash, reportRevision: completion.reportRevision,
    reporterChildThreadId: completion.reporterChildThreadId, reporterRunId: completion.reporterRunId,
  };
  return freezeDecision({
    kind: "candidate",
    candidate: {
      missionId: mid, scope: scopeCopy, role, targetThreadId, targetEpoch, canonicalRevision,
      notificationId: sha256Hex(["completion-route-v1", "retro-report", mid, completion.checkpointId, completion.reportRevision, completion.reporterChildThreadId, completion.reporterRunId, completion.normalizedReportHash, completion.sourceReportHash, completion.snapshotFingerprint, completion.sourceRoot]),
      observedRevision: canonicalRevision, observedThreadId: targetThreadId, observedEpoch: targetEpoch, source,
    },
  });
};

const CANDIDATE_KEYS = ["missionId", "scope", "role", "targetThreadId", "targetEpoch", "canonicalRevision", "notificationId", "observedRevision", "observedThreadId", "observedEpoch", "source"] as const;
const TASK_SOURCE_KEYS = ["kind", "taskId", "attemptNumber", "resultRevision", "childTaskId", "childThreadId", "childRunId"] as const;
const RETRO_SOURCE_KEYS = RETRO_KEYS;
/**
 * Pure currentness: re-resolves the candidate's complete scope+source against
 * the CURRENT mission and requires exact equality (target, epoch, revision,
 * notification identity included). Forged or stale fields fail; never activates.
 */
export const isCompletionCandidateCurrent = (mission: Mission, candidate: CompletionRouteCandidate): boolean => {
  if (!isRecord(mission) || !isRecord(candidate) || !exactKeys(candidate, CANDIDATE_KEYS)) return false;
  if (!isHandoffSafeId(candidate.missionId) || !isValidScope(candidate.scope)) return false;
  if (candidate.scope.missionId !== candidate.missionId) return false;
  if (candidate.role !== "delivery" && candidate.role !== "retro") return false;
  if (!isThreadId(candidate.targetThreadId) || !isCounter(candidate.targetEpoch)) return false;
  if (!isCounter(candidate.canonicalRevision) || !isSha(candidate.notificationId)) return false;
  if (
    !isCounter(candidate.observedRevision) || !isThreadId(candidate.observedThreadId) ||
    !isCounter(candidate.observedEpoch) || candidate.targetThreadId !== candidate.observedThreadId ||
    candidate.targetEpoch !== candidate.observedEpoch || candidate.canonicalRevision !== candidate.observedRevision
  ) return false;
  const source = candidate.source;
  if (!isRecord(source)) return false;
  let completion: CompletionReference;
  if (candidate.role === "delivery") {
    if (!exactKeys(source, TASK_SOURCE_KEYS) || !isValidTaskRef({ ...source })) return false;
    completion = source as TaskResultCompletionReference;
  } else {
    if (!exactKeys(source, RETRO_SOURCE_KEYS) || !isValidRetroRef({ ...source })) return false;
    completion = source as RetroReportCompletionReference;
  }
  const decision = resolveCompletionRoute({ mission, scope: candidate.scope, completion });
  if (decision.kind !== "candidate") return false;
  const fresh = decision.candidate;
  return (
    fresh.missionId === candidate.missionId && fresh.role === candidate.role &&
    fresh.targetThreadId === candidate.targetThreadId && fresh.targetEpoch === candidate.targetEpoch &&
    fresh.canonicalRevision === candidate.canonicalRevision && fresh.notificationId === candidate.notificationId &&
    fresh.observedRevision === candidate.observedRevision && fresh.observedThreadId === candidate.observedThreadId &&
    fresh.observedEpoch === candidate.observedEpoch &&
    stableStringify(fresh.scope) === stableStringify(candidate.scope) &&
    stableStringify(fresh.source) === stableStringify(candidate.source)
  );
};

// @effect-diagnostics nodeBuiltinImport:off -- stable command hashes bind durable receipts.
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import {
  CommandId,
  EventId,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "../../../../packages/contracts/src/baseSchemas.ts";
import {
  Mission,
  type MissionManagerHandoffReservedEvent,
} from "../../../../packages/contracts/src/mission.ts";
import {
  emptyMissionExecution,
  missionManagerReservations,
  type MissionExecution,
} from "../../../../packages/contracts/src/missionExecution.ts";
import {
  MANAGER_HANDOFF_ARTIFACT_NAMESPACE,
  MAX_MANAGER_TRANSFER_RESERVATIONS,
  ManagerHandoffArtifactRef,
  ManagerReservationLocalDate,
  ManagerReservationOrdinal,
  ManagerReservationReason,
  MissionManagerReservation,
  managerReservationState,
  type MissionManagerReservation as MissionManagerReservationValue,
} from "../../../../packages/contracts/src/missionManagerTransfer.ts";
import { MissionResultDisposition } from "../../../../packages/contracts/src/missionResult.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import {
  evaluateManagerRotation,
  type PreparedRotationIntent,
  type RotationSafeBoundary,
} from "./MissionManagerRotation.ts";
import {
  HANDOFF_MAX_ARRAY_ITEMS,
  HANDOFF_SNAPSHOT_SCHEMA_VERSION,
  isHandoffSafeId,
  isHandoffOpaqueThreadId,
  isHandoffOpaqueRunId,
  isHandoffSafeRef,
} from "./MissionManagerHandoff.ts";

/**
 * Durable source-only manager-successor intent reservation store (repair).
 *
 * No caller-authoritative safety facts: the reserve command carries strict
 * normalized metadata only. The current instant, last slot, context
 * pressure, safe boundary, retro queue, and user stop/pause facts come ONLY
 * from the required private trusted-facts producer, and the requesting
 * role comes ONLY from the required private role authority. Both ports are
 * required with no default producer: a missing, unknown, unsafe, or drifted
 * producer disables reservation (fail closed, no implicit healthy facts).
 * The private root producer/authority is not public MCP authentication; a
 * runtime/MCP owning guard adapter remains gated parent work.
 *
 * One unresolved intent per logical ROLE: a different day, ordinal, or
 * epoch never releases a held intent for the role; only trusted retirement
 * recorded by `MissionManagerLifecycleStore` does. History is never pruned
 * by expiry or day. Fresh reserves commit the dedicated
 * `mission.manager-handoff-reserved` event, the projection snapshot CAS,
 * and the command receipt in ONE owning SQL transaction on the same
 * canonical aggregate (ApplicationEvent version 3, same event store and
 * receipts; no new tables, migration, outbox, or parallel framework).
 * Current canonical ACTIVE status and current trusted safe/stop/pause/
 * queue/routing gates run BEFORE any accepted/rejected receipt lookup,
 * alias, or fresh branch, so replaying an old accepted command after a
 * pause/stop/unsafe drift never returns authorizing success. The incumbent
 * manager remains exactly unchanged; the reserved successorThreadId is an
 * identifier only and no thread is created. This store only reserves:
 * standby, quiesce, the owner-CAS, routing confirmation, and retirement
 * records live in `MissionManagerLifecycleStore`; nothing here launches or
 * tears down a session.
 */
export class MissionManagerTransferStoreError extends Schema.TaggedError<MissionManagerTransferStoreError>()(
  "MissionManagerTransferStoreError",
  {
    operation: Schema.Literals(["reserve"]),
    category: Schema.Literals(["scope_denied", "request_conflict", "persistence"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Mission manager reservation failed (${this.category}).`;
  }
}

/** Documented policy denial. Persisted as a rejected receipt: durable. */
export class MissionManagerTransferRejection extends Schema.TaggedError<MissionManagerTransferRejection>()(
  "MissionManagerTransferRejection",
  {
    operation: Schema.Literal("reserve"),
    code: Schema.Literals([
      "mission_inactive",
      "user_stop",
      "user_pause",
      "empty_retro_queue",
      "rotation_hold",
      "reservation_bound",
    ]),
    message: Schema.String,
  },
) {}

/**
 * Strict normalized reserve metadata. No caller-owned authority, safety
 * facts, snapshot, or path is accepted: excess fields are rejected, never
 * silently stripped. `structuredClone`-unsafe input becomes a finite
 * StoreError, never an uncaught defect.
 */
export interface ManagerReservationCommand {
  readonly commandId: CommandId;
  readonly missionId: string;
  readonly role: "delivery" | "retro";
  readonly expectedRevision: number;
  /** Explicit project IANA timezone. Required; never defaulted. */
  readonly projectTimezone: string;
  readonly currentThreadId: string;
  readonly currentEpoch: number;
  readonly localDate: string;
  readonly ordinal: number;
  readonly reason: "first_slot" | "new_local_day" | "context_pressure";
  /** Namespaced immutable handoff artifact reference `manager-handoff:<sha256>`. */
  readonly artifactRef: string;
}

/**
 * Required private ROLE authority. Binds the actual team, environment,
 * controller thread, and role from the trusted root context; a body-forged
 * role can never reserve the other role, even when one manager thread is
 * assigned to both canonical roles. `isCurrent` is a pure synchronous
 * check (no I/O): revocation after any yield denies with rollback.
 */
export class MissionManagerReservationAuthority extends Context.Service<
  MissionManagerReservationAuthority,
  {
    readonly teamId: string;
    readonly environmentId: string;
    readonly controllerThreadId: string;
    readonly role: "delivery" | "retro";
    readonly isCurrent: () => boolean;
  }
>()("t3/orchestration-v2/MissionManagerTransferStore/MissionManagerReservationAuthority") {}

/** Last durable slot observed by the trusted producer. Null means no slot yet; undefined (absent) means unknown. */
export interface ManagerReservationLastSlot {
  readonly localDate: string;
  readonly ordinal: number;
}

/**
 * Trusted captured facts. Produced ONLY by the required private producer,
 * bound to the actual scope, role, current mission manager, epoch,
 * canonical revision, and timezone. `fence` is the producer revision token
 * the synchronous currency check compares against; a producer clock change
 * alone is not new command bytes. Unknown facts are represented explicitly
 * (null/absent) and always deny: there are no implicit healthy facts.
 */
export interface ManagerTrustedFacts {
  readonly teamId: string;
  readonly environmentId: string;
  readonly missionId: string;
  readonly role: "delivery" | "retro";
  readonly currentThreadId: string;
  readonly currentEpoch: number;
  /** Canonical revision the producer captured against. */
  readonly observedRevision: number;
  readonly projectTimezone: string;
  /** Captured current instant, ISO-8601; null when unknown. */
  readonly nowIso: string | null;
  readonly lastSlot: ManagerReservationLastSlot | null | undefined;
  readonly contextPressure?: { readonly requested: boolean; readonly reason?: string | undefined } | undefined;
  /** Null when the safe boundary is unknown. */
  readonly safeBoundary: RotationSafeBoundary | null;
  /** Required (known) for role "retro"; ignored for "delivery". */
  readonly retroQueueDepth?: number | null | undefined;
  readonly userStopRequested: boolean | null;
  readonly userPauseRequested: boolean | null;
  readonly fence: string;
}

/**
 * Required trusted captured-facts producer port. No default producer.
 * `readFacts` runs OUTSIDE the owning SQL transaction; `isCurrent` is a
 * pure synchronous check (no I/O, no private filesystem reread) used
 * before and after every own-SQL yield so drift or revocation denies with
 * rollback. The parent supplies the actual production producer later.
 */
export class MissionManagerTrustedFactsPort extends Context.Service<
  MissionManagerTrustedFactsPort,
  {
    readonly readFacts: (request: {
      readonly missionId: string;
      readonly role: "delivery" | "retro";
    }) => Effect.Effect<ManagerTrustedFacts, MissionManagerTransferStoreError>;
    readonly isCurrent: (facts: ManagerTrustedFacts) => boolean;
  }
>()("t3/orchestration-v2/MissionManagerTransferStore/MissionManagerTrustedFactsPort") {}

/**
 * Private immutable handoff artifact read port. Returns the original bytes
 * for a `manager-handoff:<sha256>` reference only; the store verifies the
 * namespace, byte bound, SHA, UTF-8, schema, and canonical binding itself.
 * No default producer: a missing port fails closed.
 */
export class MissionManagerHandoffArtifactPort extends Context.Service<
  MissionManagerHandoffArtifactPort,
  {
    readonly readArtifact: (
      ref: string,
    ) => Effect.Effect<Uint8Array, MissionManagerTransferStoreError>;
  }
>()("t3/orchestration-v2/MissionManagerTransferStore/MissionManagerHandoffArtifactPort") {}

export interface ManagerReservationSuccess {
  readonly reservation: MissionManagerReservationValue;
  readonly receipt: Receipts.OrchestrationCommandReceipt;
  readonly recovered: boolean;
  /** True only when a fresh event, revision, and accepted receipt committed. */
  readonly committed: boolean;
  readonly eventSequence: number;
}

export type ManagerReservationResult = Result.Result<
  ManagerReservationSuccess,
  MissionManagerTransferRejection
>;

export class MissionManagerTransferStore extends Context.Service<
  MissionManagerTransferStore,
  {
    readonly reserve: (
      command: ManagerReservationCommand,
    ) => Effect.Effect<ManagerReservationResult, MissionManagerTransferStoreError>;
  }
>()("t3/orchestration-v2/MissionManagerTransferStore") {}

/** Receipt command type for manager reservations. */
export const MANAGER_RESERVE_COMMAND_TYPE = "mission.manager-reserve";

/** Largest handoff artifact the store binds, in UTF-8 bytes. */
export const MAX_HANDOFF_ARTIFACT_BYTES = 64 * 1024;

const COMMAND_KEYS: ReadonlySet<string> = new Set([
  "commandId",
  "missionId",
  "role",
  "expectedRevision",
  "projectTimezone",
  "currentThreadId",
  "currentEpoch",
  "localDate",
  "ordinal",
  "reason",
  "artifactRef",
]);

/** Strict local metadata reserve command schema. No caller-owned authority or facts accepted. */
const ManagerReservationCommandSchema = Schema.Struct({
  commandId: CommandId.check(Schema.isMaxLength(512)),
  missionId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  role: Schema.Literals(["delivery", "retro"]),
  expectedRevision: NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  projectTimezone: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  currentThreadId: ThreadId.check(Schema.isMaxLength(512)),
  currentEpoch: NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  localDate: ManagerReservationLocalDate,
  ordinal: ManagerReservationOrdinal,
  reason: ManagerReservationReason,
  artifactRef: ManagerHandoffArtifactRef,
});
type DecodedReserveCommand = typeof ManagerReservationCommandSchema.Type;

/**
 * Stable request hash over the canonical command bytes. Only normalized
 * metadata is hashed; the trusted producer clock and facts never enter the
 * hash, so a producer clock change is not new command bytes.
 */
export const requestHashFor = (command: DecodedReserveCommand): string =>
  NodeCrypto.createHash("sha256")
    .update(
      stableStringify({
        artifactRef: command.artifactRef,
        commandId: command.commandId,
        currentEpoch: command.currentEpoch,
        currentThreadId: command.currentThreadId,
        expectedRevision: command.expectedRevision,
        localDate: command.localDate,
        missionId: command.missionId,
        ordinal: command.ordinal,
        projectTimezone: command.projectTimezone,
        reason: command.reason,
        role: command.role,
      }),
    )
    .digest("hex");

/** Unique logical slot: canonical team/env/mission + role + timezone slot. */
export const slotKeyFor = (slot: {
  readonly teamId: string;
  readonly environmentId: string;
  readonly missionId: string;
  readonly role: "delivery" | "retro";
  readonly timezone: string;
  readonly localDate: string;
  readonly ordinal: number;
}): string => stableStringify(slot);

const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));
const encodeMission = Schema.encodeEffect(Schema.fromJsonString(Mission));
const decodeReservation = Schema.decodeUnknownEffect(MissionManagerReservation);
const decodeCommand = Schema.decodeUnknownEffect(ManagerReservationCommandSchema);
const decodeArtifactJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSavedRejection = Schema.decodeUnknownEffect(
  Schema.fromJsonString(MissionManagerTransferRejection),
);
const encodeRejection = Schema.encodeEffect(Schema.fromJsonString(MissionManagerTransferRejection));
const isStoreError = Schema.is(MissionManagerTransferStoreError);
const dispositionIs = Schema.is(MissionResultDisposition);

const isIanaTimezone = (value: string): boolean => {
  if (value.length === 0 || value.length > 128) return false;
  if (!/^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)*$/.test(value)) return false;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: value }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
};
const keysWithin = (value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean =>
  Object.keys(value).every((key) => keys.includes(key));
const isSafeCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isSha256Hex = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const sha256HexOf = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");

const COVERAGE_STATES: ReadonlySet<string> = new Set(["complete", "partial", "none", "unknown"]);
const CANDIDATE_STATES: ReadonlySet<string> = new Set(["none", "proposed", "validated", "unknown"]);
const RUNTIME_STATES: ReadonlySet<string> = new Set(["idle", "active", "quiesced", "unknown"]);
const PUBLISHER_REVISION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}#[0-9]{1,32}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const hasControl = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
};

/** Validate one bounded known/unknown list field; task membership enforced when a set is given. */
const validListField = (value: unknown, kind: "ownership" | "results" | "holds" | "idrefs", taskIds: ReadonlySet<string>): boolean => {
  if (!isRecord(value)) return false;
  if (value.state === "unknown") {
    return exactKeys(value, ["state", "reason"]) && typeof value.reason === "string" && value.reason.length >= 1 && value.reason.length <= 512 && !hasControl(value.reason);
  }
  if (value.state !== "known" || !exactKeys(value, ["state", "items"]) || !Array.isArray(value.items)) return false;
  if (value.items.length > HANDOFF_MAX_ARRAY_ITEMS) return false;
  for (const item of value.items) {
    if (!isRecord(item)) return false;
    if (kind === "ownership") {
      if (!keysWithin(item, ["taskId", "threadId", "runId", "attemptNumber"]) || !isHandoffSafeId(item.taskId) || !taskIds.has(item.taskId as string)) return false;
      if (item.threadId !== undefined && !isHandoffSafeId(item.threadId) && !isHandoffOpaqueThreadId(item.threadId)) return false;
      if (item.runId !== undefined && !isHandoffSafeId(item.runId) && !isHandoffOpaqueRunId(item.runId)) return false;
      if (item.attemptNumber !== undefined && !isSafeCount(item.attemptNumber)) return false;
    } else if (kind === "results") {
      if (!keysWithin(item, ["taskId", "dispatchKey", "resultRevision", "commandId", "disposition"]) || !isHandoffSafeId(item.taskId) || !taskIds.has(item.taskId as string)) return false;
      if (item.dispatchKey !== undefined && !isHandoffSafeId(item.dispatchKey)) return false;
      if (item.resultRevision !== undefined && !isSafeCount(item.resultRevision)) return false;
      if (item.commandId !== undefined && !isHandoffSafeId(item.commandId)) return false;
      if (item.disposition !== undefined && !dispositionIs(item.disposition)) return false;
    } else if (kind === "holds") {
      if (!keysWithin(item, ["holdId", "keepAliveRef"]) || !isHandoffSafeId(item.holdId)) return false;
      if (item.keepAliveRef !== undefined && !isHandoffSafeRef(item.keepAliveRef)) return false;
    } else {
      if (!keysWithin(item, ["id", "ref"]) || !isHandoffSafeId(item.id)) return false;
      if (item.ref !== undefined && !isHandoffSafeRef(item.ref)) return false;
    }
  }
  return true;
};

/** Validate one bounded known/unknown value field against its accepted shape. */
const validValueField = (value: unknown, kind: "integration" | "coverage" | "routePolicy" | "deadline" | "predecessor", ctx: { readonly missionId: string; readonly teamId: string; readonly environmentId: string; readonly role: string; readonly currentThreadId: string; readonly currentEpoch: number }): boolean => {
  if (!isRecord(value)) return false;
  if (value.state === "unknown") {
    return exactKeys(value, ["state", "reason"]) && typeof value.reason === "string" && value.reason.length >= 1 && value.reason.length <= 512 && !hasControl(value.reason);
  }
  if (value.state !== "known" || !exactKeys(value, ["state", "value"]) || !isRecord(value.value)) return false;
  const v = value.value;
  if (kind === "integration") {
    if (!keysWithin(v, ["branch", "buildRef", "commit"]) || (v.branch === undefined && v.buildRef === undefined && v.commit === undefined)) return false;
    if (v.branch !== undefined && !(typeof v.branch === "string" && BRANCH_PATTERN.test(v.branch) && !v.branch.includes("..") && !v.branch.endsWith("/") && !v.branch.endsWith(".") && !hasControl(v.branch))) return false;
    if (v.buildRef !== undefined && !isHandoffSafeRef(v.buildRef)) return false;
    if (v.commit !== undefined && !(typeof v.commit === "string" && COMMIT_PATTERN.test(v.commit))) return false;
    return true;
  }
  if (kind === "coverage") {
    if (!exactKeys(v, ["coverage", "candidate", "runtime"]) && !keysWithin(v, ["coverage", "reportRef", "candidate", "candidateRef", "runtime"])) return false;
    if (typeof v.coverage !== "string" || !COVERAGE_STATES.has(v.coverage)) return false;
    if (typeof v.candidate !== "string" || !CANDIDATE_STATES.has(v.candidate)) return false;
    if (typeof v.runtime !== "string" || !RUNTIME_STATES.has(v.runtime)) return false;
    if (v.reportRef !== undefined && !isHandoffSafeRef(v.reportRef)) return false;
    if (v.candidateRef !== undefined && !isHandoffSafeRef(v.candidateRef)) return false;
    return true;
  }
  if (kind === "routePolicy") {
    if (!keysWithin(v, ["ref", "revision"]) || !isHandoffSafeRef(v.ref)) return false;
    if (v.revision !== undefined && !(typeof v.revision === "string" && PUBLISHER_REVISION.test(v.revision))) return false;
    return true;
  }
  if (kind === "deadline") {
    if (!keysWithin(v, ["cursor", "ref"]) || (v.cursor === undefined && v.ref === undefined)) return false;
    if (v.cursor !== undefined && !isSafeCount(v.cursor)) return false;
    if (v.ref !== undefined && !isHandoffSafeRef(v.ref)) return false;
    return true;
  }
  // predecessor
  if (!keysWithin(v, ["missionId", "teamId", "environmentId", "role", "managerThreadId", "epoch", "localDate", "ordinal"])) return false;
  if (v.missionId !== ctx.missionId || v.teamId !== ctx.teamId || v.environmentId !== ctx.environmentId || v.role !== ctx.role) return false;
  if ((!isHandoffSafeId(v.managerThreadId) && !isHandoffOpaqueThreadId(v.managerThreadId)) || v.managerThreadId === ctx.currentThreadId) return false;
  if (!isSafeCount(v.epoch) || (v.epoch as number) >= ctx.currentEpoch) return false;
  if (v.localDate !== undefined && !(typeof v.localDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.localDate))) return false;
  if (v.ordinal !== undefined && (!isSafeCount(v.ordinal) || (v.ordinal as number) > 8)) return false;
  return true;
};

interface BoundArtifact {
  readonly sha256Hex: string;
}

/**
 * Decode and FULLY validate the accepted bounded handoff snapshot shape.
 * The serialize helper is never treated as validation: every required
 * category (scope count/digest, decisions with authority digests and
 * canonical pointers, acceptance, known/unknown fields, nested arrays,
 * counts, IDs, namespace refs, publisher `UUID#counter` revisions, and
 * finite result dispositions) must be present, well-typed, and bounded,
 * with no excess or raw private fields. Scope, decision, and acceptance
 * preimages are recomputed exactly from the canonical mission where
 * available. Returns null on any malformation.
 */
const validateSnapshotShape = (
  parsed: unknown,
  canonical: Mission,
  command: DecodedReserveCommand,
  teamId: string,
  environmentId: string,
): boolean => {
  if (!isRecord(parsed)) return false;
  if (!exactKeys(parsed, ["schemaVersion", "serialization", "mission", "manager", "boundary", "decisions", "scope", "acceptance", "ownership", "pendingResults", "integration", "coverage", "resourceHolds", "routePolicy", "blockers", "nextActions", "deadline", "predecessor"])) return false;
  if (parsed.schemaVersion !== HANDOFF_SNAPSHOT_SCHEMA_VERSION) return false;
  const serialization = parsed.serialization;
  if (!isRecord(serialization) || !exactKeys(serialization, ["encoding", "canonicalization"])) return false;
  if (serialization.encoding !== "utf8-json" || serialization.canonicalization !== "stable-stringify-v1") return false;
  const mission = parsed.mission;
  if (!isRecord(mission) || !exactKeys(mission, ["ref", "revision", "teamId", "environmentId"])) return false;
  if (mission.ref !== canonical.id || mission.teamId !== teamId || mission.environmentId !== environmentId) return false;
  if (!isSafeCount(mission.revision) || (mission.revision as number) > canonical.revision) return false;
  const snapshotRevision = mission.revision as number;
  const assignment = command.role === "delivery" ? canonical.managers.delivery : canonical.managers.retro;
  if (assignment?.threadId !== command.currentThreadId || assignment?.epoch !== command.currentEpoch) return false;
  const manager = parsed.manager;
  if (!isRecord(manager) || !exactKeys(manager, ["role", "threadId", "epoch"])) return false;
  if (manager.role !== command.role || manager.threadId !== command.currentThreadId || manager.epoch !== command.currentEpoch) return false;
  const boundary = parsed.boundary;
  if (!isRecord(boundary) || !exactKeys(boundary, ["timezone", "localDate", "ordinal", "reason"])) return false;
  if (boundary.timezone !== command.projectTimezone || boundary.localDate !== command.localDate || boundary.ordinal !== command.ordinal || boundary.reason !== command.reason) return false;
  // Decisions: exact canonical pointers and authority digests.
  const canonicalDecisions = canonical.intent.decisions ?? [];
  if (!Array.isArray(parsed.decisions) || parsed.decisions.length > HANDOFF_MAX_ARRAY_ITEMS) return false;
  if (parsed.decisions.length !== canonicalDecisions.length) return false;
  for (let i = 0; i < parsed.decisions.length; i += 1) {
    const entry: unknown = parsed.decisions[i];
    const source: unknown = canonicalDecisions[i];
    if (!isRecord(entry) || !exactKeys(entry, ["id", "canonicalRef", "authorityDigest"])) return false;
    if (!isRecord(source)) return false;
    if (entry.id !== source.id || !isHandoffSafeId(entry.id)) return false;
    if (entry.canonicalRef !== `${canonical.id}@${snapshotRevision}:decision:${i}`) return false;
    if (!isSha256Hex(entry.authorityDigest)) return false;
    const authority: unknown = source.authority;
    if (!isRecord(authority)) return false;
    if (entry.authorityDigest !== sha256HexOf(stableStringify({ ref: authority.ref, source: authority.source }))) return false;
  }
  // Scope: exact count and digest of the canonical scope list.
  const canonicalScope = canonical.intent.scope ?? [];
  if (!isRecord(parsed.scope) || !exactKeys(parsed.scope, ["count", "digest"])) return false;
  if (parsed.scope.count !== canonicalScope.length || !isSha256Hex(parsed.scope.digest)) return false;
  if (parsed.scope.digest !== sha256HexOf(stableStringify([...canonicalScope]))) return false;
  // Acceptance: exact canonical ids in order.
  const canonicalAcceptance = canonical.intent.acceptanceCriteria ?? [];
  if (!Array.isArray(parsed.acceptance) || parsed.acceptance.length > HANDOFF_MAX_ARRAY_ITEMS) return false;
  if (parsed.acceptance.length !== canonicalAcceptance.length) return false;
  for (let i = 0; i < parsed.acceptance.length; i += 1) {
    const entry: unknown = parsed.acceptance[i];
    if (!isRecord(entry) || !exactKeys(entry, ["id"]) || entry.id !== canonicalAcceptance[i]?.id) return false;
  }
  const taskIds = new Set<string>((canonical.tasks ?? []).map((task) => task.id));
  const ctx = { missionId: canonical.id, teamId, environmentId, role: command.role, currentThreadId: command.currentThreadId, currentEpoch: command.currentEpoch };
  if (!validListField(parsed.ownership, "ownership", taskIds)) return false;
  if (!validListField(parsed.pendingResults, "results", taskIds)) return false;
  if (!validListField(parsed.resourceHolds, "holds", taskIds)) return false;
  if (!validListField(parsed.blockers, "idrefs", taskIds)) return false;
  if (!validListField(parsed.nextActions, "idrefs", taskIds)) return false;
  if (!validValueField(parsed.integration, "integration", ctx)) return false;
  if (!validValueField(parsed.coverage, "coverage", ctx)) return false;
  if (!validValueField(parsed.routePolicy, "routePolicy", ctx)) return false;
  if (!validValueField(parsed.deadline, "deadline", ctx)) return false;
  if (!validValueField(parsed.predecessor, "predecessor", ctx)) return false;
  return true;
};

const decodeArtifactBytes = (
  bytes: Uint8Array,
  command: DecodedReserveCommand,
): BoundArtifact | null => {
  if (bytes.length === 0 || bytes.length > MAX_HANDOFF_ARTIFACT_BYTES) return null;
  const sha256Hex = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (`${MANAGER_HANDOFF_ARTIFACT_NAMESPACE}:${sha256Hex}` !== command.artifactRef) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return { sha256Hex };
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authoritySvc = yield* MissionManagerReservationAuthority;
  const factsPort = yield* MissionManagerTrustedFactsPort;
  const events = yield* EventStore.OrchestrationEventStore;
  const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
  const artifactPort = yield* MissionManagerHandoffArtifactPort;

  // Snapshot the private authority ONCE before any yield; keep only the
  // pure synchronous currency check by reference.
  const authority = Object.freeze({
    teamId: authoritySvc.teamId,
    environmentId: authoritySvc.environmentId,
    controllerThreadId: authoritySvc.controllerThreadId,
    role: authoritySvc.role,
  });
  const authorityIsCurrent: () => boolean = () => {
    try {
      return authoritySvc.isCurrent() === true;
    } catch {
      return false;
    }
  };
  const factsIsCurrent = (facts: ManagerTrustedFacts): boolean => {
    try {
      return factsPort.isCurrent(facts) === true;
    } catch {
      return false;
    }
  };

  const toStoreError = (cause: unknown): MissionManagerTransferStoreError =>
    isStoreError(cause)
      ? cause
      : new MissionManagerTransferStoreError({ operation: "reserve", category: "persistence", cause });
  const scopeDenied = (): MissionManagerTransferStoreError =>
    new MissionManagerTransferStoreError({ operation: "reserve", category: "scope_denied" });
  const requestConflict = (): MissionManagerTransferStoreError =>
    new MissionManagerTransferStoreError({ operation: "reserve", category: "request_conflict" });
  const deny = (
    code: MissionManagerTransferRejection["code"],
    message: string,
  ): MissionManagerTransferRejection =>
    new MissionManagerTransferRejection({ operation: "reserve", code, message });

  /** Facts must bind the actual authority tuple, role, and canonical manager. */
  const factsBindCanonical = (facts: ManagerTrustedFacts, canonical: Mission): boolean => {
    if (!isRecord(facts) || !isSafeCount(facts.observedRevision) || !isSafeCount(canonical.revision)) return false;
    const assignment = facts.role === "delivery" ? canonical.managers.delivery : canonical.managers.retro;
    return (
      facts.teamId === authority.teamId &&
      facts.environmentId === authority.environmentId &&
      facts.missionId === canonical.id &&
      facts.role === authority.role &&
      facts.currentThreadId === authority.controllerThreadId &&
      assignment?.threadId === facts.currentThreadId &&
      assignment?.epoch === facts.currentEpoch &&
      facts.projectTimezone === canonical.projectTimezone &&
      typeof facts.fence === "string" &&
      facts.fence.length >= 1 &&
      facts.fence.length <= 512
    );
  };

  /**
   * Current health gates from trusted facts only. Returns a rejection code
   * when a stable policy state denies, or "scope" for unknown/unsafe facts.
   * Runs BEFORE any receipt lookup on every branch.
   */
  const currentGate = (
    canonical: Mission,
    facts: ManagerTrustedFacts,
  ): "ok" | "scope" | MissionManagerTransferRejection["code"] => {
    if (canonical.status !== "active") return "mission_inactive";
    if (typeof facts.userStopRequested !== "boolean" || typeof facts.userPauseRequested !== "boolean") return "scope";
    if (facts.userStopRequested) return "user_stop";
    if (facts.userPauseRequested) return "user_pause";
    if (!isRecord(facts.safeBoundary)) return "scope";
    const b = facts.safeBoundary;
    if (
      typeof b.incumbentIntegrationRunning !== "boolean" ||
      typeof b.incumbentGuiOwned !== "boolean" ||
      typeof b.unresolvedShellWrite !== "boolean" ||
      typeof b.sharedWriteUnknown !== "boolean" ||
      typeof b.quiescenceUnknown !== "boolean" ||
      typeof b.childWorkersPending !== "boolean" ||
      typeof b.completionRoutingReady !== "boolean"
    ) {
      return "scope";
    }
    if (b.incumbentIntegrationRunning || b.incumbentGuiOwned || b.unresolvedShellWrite || b.sharedWriteUnknown || b.quiescenceUnknown || !b.completionRoutingReady) {
      return "rotation_hold";
    }
    if (facts.role === "retro") {
      if (facts.retroQueueDepth === undefined || facts.retroQueueDepth === null) return "scope";
      if (!Number.isSafeInteger(facts.retroQueueDepth) || facts.retroQueueDepth < 0) return "scope";
      if (facts.retroQueueDepth === 0) return "empty_retro_queue";
    }
    if (facts.nowIso === null || typeof facts.nowIso !== "string") return "scope";
    if (facts.lastSlot === undefined) return "scope";
    if (facts.contextPressure !== undefined) {
      if (typeof facts.contextPressure !== "object" || facts.contextPressure === null || typeof facts.contextPressure.requested !== "boolean") return "scope";
    }
    const shapeDecision = evaluateManagerRotation({ mission: canonical, role: facts.role, projectTimezone: facts.projectTimezone, nowIso: facts.nowIso, lastSlot: facts.lastSlot, contextPressure: facts.contextPressure, safeBoundary: facts.safeBoundary, retroQueueDepth: facts.retroQueueDepth ?? undefined, userStopRequested: facts.userStopRequested, userPauseRequested: facts.userPauseRequested });
    if (shapeDecision.kind === "hold") return "scope";
    return "ok";
  };

  // Recover immutable preparation context for an already-held artifact.
  // Generic mission changes must not change an exact command's identity.
  const preparationContext = Effect.fn("MissionManagerTransferStore.preparationContext")(function* (canonical: Mission, command: DecodedReserveCommand) {
    const held = missionManagerReservations(canonical.execution ?? emptyMissionExecution()).find((entry) => entry.role === command.role && entry.artifactRef === command.artifactRef && entry.observedRevision === command.expectedRevision && entry.currentEpoch === command.currentEpoch && entry.currentThreadId === command.currentThreadId);
    if (held === undefined) return canonical;
    const logged = yield* events.readMissionEvents(canonical.id);
    const original = logged.find((event) => event.type === "mission.manager-handoff-reserved" && event.payload.reservationId === held.reservationId);
    if (original === undefined || original.type !== "mission.manager-handoff-reserved") return yield* new MissionManagerTransferStoreError({ operation: "reserve", category: "persistence" });
    const persisted = missionManagerReservations(original.payload.mission.execution ?? emptyMissionExecution()).find((entry) => entry.reservationId === held.reservationId);
    // Lifecycle progress is layered onto a reservation after it is reserved;
    // the immutable reserved fields must still equal the original event.
    const { lifecycle: _progress, ...heldAsReserved } = held;
    if (persisted === undefined || stableStringify(persisted) !== stableStringify(heldAsReserved)) return yield* scopeDenied();
    return original.payload.mission;
  });

  const persistRejection = Effect.fn("MissionManagerTransferStore.persistRejection")(function* (
    command: DecodedReserveCommand,
    missionId: Mission["id"],
    requestHash: string,
    failure: MissionManagerTransferRejection,
  ) {
    const failedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    if (
      !(yield* receipts.insertIfAbsent({
        commandId: command.commandId,
        aggregateKind: "mission",
        aggregateId: missionId,
        commandType: MANAGER_RESERVE_COMMAND_TYPE,
        acceptedAt: failedAt,
        resultSequence: 0,
        status: "rejected",
        error: yield* encodeRejection(failure),
        requestHash,
      }))
    ) {
      return yield* requestConflict();
    }
    return Result.fail(failure);
  });

  const reserveTransaction = Effect.fn("MissionManagerTransferStore.reserveTransaction")(function* (
    command: DecodedReserveCommand,
    requestHash: string,
    artifactJson: unknown,
    facts: ManagerTrustedFacts,
  ) {
    // Synchronous currency checks before the first own-SQL yield result is used.
    if (!authorityIsCurrent() || !factsIsCurrent(facts)) return yield* scopeDenied();
    const rows = yield* sql<{ revision: number; snapshot_json: string }>`
      SELECT revision, snapshot_json FROM projection_missions
      WHERE mission_id = ${command.missionId}
        AND team_id = ${authority.teamId}
        AND authority_environment_id = ${authority.environmentId}
    `;
    if (rows[0] === undefined) return yield* scopeDenied();
    const canonical = yield* decodeMission(rows[0].snapshot_json).pipe(Effect.mapError(toStoreError));
    if (rows[0].revision !== canonical.revision) {
      return yield* new MissionManagerTransferStoreError({ operation: "reserve", category: "persistence" });
    }
    // Final current binding rechecked after the SQL yield.
    if (!authorityIsCurrent() || !factsIsCurrent(facts)) return yield* scopeDenied();
    if (!isIanaTimezone(command.projectTimezone)) return yield* scopeDenied();
    // Private ROLE authority: body role must be the actual private role, and
    // the canonical current manager for that role must be the authority thread.
    const assignment = command.role === "delivery" ? canonical.managers.delivery : canonical.managers.retro;
    if (
      command.role !== authority.role ||
      assignment?.threadId !== authority.controllerThreadId ||
      assignment?.threadId !== command.currentThreadId ||
      assignment?.epoch !== command.currentEpoch ||
      canonical.projectTimezone !== command.projectTimezone ||
      !factsBindCanonical(facts, canonical) ||
      facts.observedRevision !== canonical.revision ||
      facts.role !== command.role ||
      facts.currentThreadId !== command.currentThreadId ||
      facts.currentEpoch !== command.currentEpoch ||
      facts.projectTimezone !== command.projectTimezone
    ) {
      return yield* scopeDenied();
    }
    // Current ACTIVE + trusted health gates BEFORE any receipt lookup.
    const gate = currentGate(canonical, facts);
    if (gate === "scope") return yield* scopeDenied();
    if (gate !== "ok") {
      // Stable policy state: for a fresh command this persists below only
      // when no prior receipt exists; a prior accepted receipt is never
      // overwritten and never returns authorizing success under a bad gate.
      const priorPeek = yield* receipts.getByCommandId({ commandId: command.commandId });
      if (Option.isSome(priorPeek) && priorPeek.value.status === "accepted") {
        return yield* scopeDenied();
      }
      if (Option.isSome(priorPeek) && priorPeek.value.status === "rejected") {
        // Fall through to the rejected-replay handling below.
      } else if (Option.isSome(priorPeek)) {
        return yield* scopeDenied();
      } else {
        return yield* persistRejection(command, canonical.id, requestHash, deny(gate, `Reservation denied (${gate}); no successor intent is reserved.`));
      }
    }
    // Full snapshot revalidation against the reread canonical (no I/O here).
    if (!validateSnapshotShape(artifactJson, yield* preparationContext(canonical, command), command, authority.teamId, authority.environmentId)) {
      return yield* scopeDenied();
    }
    if (!authorityIsCurrent() || !factsIsCurrent(facts)) return yield* scopeDenied();

    const prior = yield* receipts.getByCommandId({ commandId: command.commandId });
    if (Option.isSome(prior)) {
      const saved = prior.value;
      if (
        saved.commandType !== MANAGER_RESERVE_COMMAND_TYPE ||
        saved.aggregateKind !== "mission" ||
        saved.aggregateId !== canonical.id ||
        saved.requestHash === null ||
        saved.requestHash === undefined ||
        saved.requestHash !== requestHash
      ) {
        return yield* requestConflict();
      }
      if (!authorityIsCurrent() || !factsIsCurrent(facts)) return yield* scopeDenied();
      if (saved.status === "rejected") {
        if (saved.error === null) {
          return yield* new MissionManagerTransferStoreError({ operation: "reserve", category: "persistence" });
        }
        // Final current binding already checked above (gate, authority, facts).
        return Result.fail(yield* decodeSavedRejection(saved.error).pipe(Effect.mapError(toStoreError)));
      }
      const logged = yield* events.readMissionEvents(canonical.id);
      const reserved = logged.find(
        (event) => event.type === "mission.manager-handoff-reserved" && event.sequence === saved.resultSequence,
      );
      if (reserved === undefined || reserved.type !== "mission.manager-handoff-reserved") {
        return yield* new MissionManagerTransferStoreError({ operation: "reserve", category: "persistence" });
      }
      const reservation = missionManagerReservations(
        reserved.payload.mission.execution ?? emptyMissionExecution(),
      ).find((entry) => entry.reservationId === reserved.payload.reservationId);
      if (reservation === undefined) {
        return yield* new MissionManagerTransferStoreError({ operation: "reserve", category: "persistence" });
      }
      if (
        reservation.role !== command.role ||
        reservation.currentThreadId !== authority.controllerThreadId ||
        reservation.currentThreadId !== command.currentThreadId ||
        reservation.currentEpoch !== command.currentEpoch ||
        reservation.timezone !== command.projectTimezone ||
        reservation.localDate !== command.localDate ||
        reservation.ordinal !== command.ordinal ||
        reservation.reason !== command.reason ||
        reservation.artifactRef !== command.artifactRef ||
        reservation.observedRevision !== command.expectedRevision
      ) {
        return yield* scopeDenied();
      }
      if (!authorityIsCurrent() || !factsIsCurrent(facts)) return yield* scopeDenied();
      return Result.succeed({ reservation, receipt: saved, recovered: true, committed: false, eventSequence: reserved.sequence });
    }

    const execution: MissionExecution = canonical.execution ?? emptyMissionExecution();
    const existing = missionManagerReservations(execution);
    const slotDuplicate = existing.find(
      (entry) =>
        entry.role === command.role &&
        entry.timezone === command.projectTimezone &&
        entry.localDate === command.localDate &&
        entry.ordinal === command.ordinal,
    );
    if (slotDuplicate !== undefined) {
      const sameSemantics =
        slotDuplicate.reason === command.reason &&
        slotDuplicate.artifactRef === command.artifactRef &&
        slotDuplicate.artifactSha256 === command.artifactRef.slice(MANAGER_HANDOFF_ARTIFACT_NAMESPACE.length + 1) &&
        slotDuplicate.currentThreadId === command.currentThreadId &&
        slotDuplicate.currentEpoch === command.currentEpoch &&
        slotDuplicate.role === command.role &&
        slotDuplicate.observedRevision === command.expectedRevision;
      if (!sameSemantics) return yield* requestConflict();
      const logged = yield* events.readMissionEvents(canonical.id);
      const captured = logged.find(
        (event) => event.type === "mission.manager-handoff-reserved" && event.payload.reservationId === slotDuplicate.reservationId,
      );
      if (captured === undefined || captured.type !== "mission.manager-handoff-reserved") {
        return yield* new MissionManagerTransferStoreError({ operation: "reserve", category: "persistence" });
      }
      if (!authorityIsCurrent() || !factsIsCurrent(facts)) return yield* scopeDenied();
      const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      const receipt: Receipts.OrchestrationCommandReceipt = {
        commandId: command.commandId,
        aggregateKind: "mission",
        aggregateId: canonical.id,
        commandType: MANAGER_RESERVE_COMMAND_TYPE,
        acceptedAt: now,
        resultSequence: captured.sequence,
        status: "accepted",
        error: null,
        requestHash,
      };
      if (!(yield* receipts.insertIfAbsent(receipt))) return yield* requestConflict();
      if (!authorityIsCurrent() || !factsIsCurrent(facts)) return yield* scopeDenied();
      return Result.succeed({ reservation: slotDuplicate, receipt, recovered: true, committed: false, eventSequence: captured.sequence });
    }
    // One unresolved intent per logical ROLE: a reservation stays unresolved
    // whatever its day, ordinal, or epoch until the lifecycle store records
    // trusted retirement. Retired records stay in the bounded history.
    if (existing.some((entry) => entry.role === command.role && managerReservationState(entry) !== "retired")) {
      return yield* requestConflict();
    }
    // Fresh CAS ordering: expectedRevision mismatch is a request conflict
    // FIRST; an artifact prepared against a stale revision is scope denied.
    if (command.expectedRevision !== canonical.revision) return yield* requestConflict();
    const artifactRevision = isRecord(artifactJson) && isRecord(artifactJson.mission) ? artifactJson.mission.revision : null;
    if (artifactRevision !== canonical.revision) return yield* scopeDenied();
    if (existing.length >= MAX_MANAGER_TRANSFER_RESERVATIONS) {
      return yield* persistRejection(
        command,
        canonical.id,
        requestHash,
        deny("reservation_bound", "Mission manager reservation bound reached; held intents are preserved and no further intents are accepted."),
      );
    }
    // Actual rotation decision from trusted facts only, compared exactly.
    const decision = evaluateManagerRotation({
      mission: canonical,
      role: command.role,
      projectTimezone: command.projectTimezone,
      nowIso: facts.nowIso as string,
      lastSlot: facts.lastSlot as ManagerReservationLastSlot | null,
      contextPressure: facts.contextPressure,
      safeBoundary: facts.safeBoundary as RotationSafeBoundary,
      retroQueueDepth: facts.role === "retro" ? (facts.retroQueueDepth as number) : undefined,
      userStopRequested: facts.userStopRequested as boolean,
      userPauseRequested: facts.userPauseRequested as boolean,
    });
    if (decision.kind !== "rotate") {
      const code = decision.kind === "noop" && decision.reason !== "same_day" ? decision.reason : ("rotation_hold" as const);
      return yield* persistRejection(command, canonical.id, requestHash, deny(code, `Rotation ${decision.kind} (${decision.reason}); no successor intent is reserved.`));
    }
    const intent: PreparedRotationIntent = decision.intent;
    if (
      intent.missionId !== canonical.id ||
      intent.observedRevision !== canonical.revision ||
      intent.role !== command.role ||
      intent.currentThreadId !== command.currentThreadId ||
      intent.currentEpoch !== command.currentEpoch ||
      intent.timezone !== command.projectTimezone ||
      intent.localDate !== command.localDate ||
      intent.ordinal !== command.ordinal ||
      intent.reason !== command.reason
    ) {
      return yield* requestConflict();
    }
    if (!authorityIsCurrent() || !factsIsCurrent(facts)) return yield* scopeDenied();
    const artifactSha256 = command.artifactRef.slice(MANAGER_HANDOFF_ARTIFACT_NAMESPACE.length + 1);
    const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    const reservation = yield* decodeReservation({
      reservationId: `mgr-${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 32)}`,
      successorThreadId: NodeCrypto.randomUUID(),
      role: command.role,
      currentThreadId: command.currentThreadId,
      currentEpoch: command.currentEpoch,
      observedRevision: canonical.revision,
      timezone: command.projectTimezone,
      localDate: command.localDate,
      ordinal: command.ordinal,
      reason: command.reason,
      artifactRef: command.artifactRef,
      artifactSha256,
      commandId: command.commandId,
      requestDigest: requestHash,
      reservedAt: now,
    }).pipe(Effect.mapError(toStoreError));
    const nextExecution: MissionExecution = { ...execution, managerReservations: [...existing, reservation] };
    const updated: Mission = { ...canonical, revision: canonical.revision + 1, execution: nextExecution, updatedAt: now };
    const event: MissionManagerHandoffReservedEvent = {
      sequence: 0,
      eventId: EventId.make(NodeCrypto.randomUUID()),
      aggregateKind: "mission",
      aggregateId: canonical.id,
      occurredAt: now,
      commandId: command.commandId,
      metadata: {},
      type: "mission.manager-handoff-reserved",
      payload: { mission: updated, reservationId: reservation.reservationId },
    };
    const stored = yield* events.appendMissionEvent(event);
    if (!authorityIsCurrent() || !factsIsCurrent(facts)) return yield* scopeDenied();
    const snapshot = yield* encodeMission(updated);
    const cas = yield* sql<{ mission_id: string }>`
      UPDATE projection_missions
      SET revision = ${updated.revision}, snapshot_json = ${snapshot}, updated_at = ${now}
      WHERE mission_id = ${canonical.id} AND revision = ${canonical.revision}
      RETURNING mission_id
    `;
    if (cas.length === 0) return yield* requestConflict();
    if (!authorityIsCurrent() || !factsIsCurrent(facts)) return yield* scopeDenied();
    const receipt: Receipts.OrchestrationCommandReceipt = {
      commandId: command.commandId,
      aggregateKind: "mission",
      aggregateId: canonical.id,
      commandType: MANAGER_RESERVE_COMMAND_TYPE,
      acceptedAt: now,
      resultSequence: stored.sequence,
      status: "accepted",
      error: null,
      requestHash,
    };
    if (!(yield* receipts.insertIfAbsent(receipt))) return yield* requestConflict();
    // Final revocation check: rolling back here undoes event, CAS, and receipt.
    if (!authorityIsCurrent() || !factsIsCurrent(facts)) return yield* scopeDenied();
    return Result.succeed({ reservation, receipt, recovered: false, committed: true, eventSequence: stored.sequence });
  });

  const reserve = Effect.fn("MissionManagerTransferStore.reserve")(function* (input: ManagerReservationCommand) {
    // Detach exactly once; clone-unsafe input is a finite error, not a defect.
    let detached: ManagerReservationCommand;
    try {
      detached = structuredClone(input);
    } catch (cause) {
      return yield* new MissionManagerTransferStoreError({ operation: "reserve", category: "request_conflict", cause });
    }
    if (!isRecord(detached) || !Object.keys(detached).every((key) => COMMAND_KEYS.has(key))) {
      return yield* requestConflict();
    }
    const command = yield* decodeCommand(detached).pipe(
      Effect.mapError((): MissionManagerTransferStoreError => requestConflict()),
    );
    if (!authorityIsCurrent()) return yield* scopeDenied();
    if (command.role !== authority.role) return yield* scopeDenied();
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
      return yield* new MissionManagerTransferStoreError({ operation: "reserve", category: "persistence" });
    }
    // Trusted facts are read OUTSIDE the owning SQL transaction. The port
    // return is deep-detached once so later caller/port mutation cannot
    // alter the hash, scope, or bindings used below.
    let facts: ManagerTrustedFacts;
    try {
      const rawFacts = yield* factsPort.readFacts({ missionId: command.missionId, role: command.role });
      facts = structuredClone(rawFacts);
      const freezeFacts = (value: unknown): void => { if (isRecord(value) || Array.isArray(value)) { for (const nested of Object.values(value)) freezeFacts(nested); Object.freeze(value); } };
      freezeFacts(facts);
    } catch (cause) {
      if (isStoreError(cause)) return yield* cause;
      return yield* new MissionManagerTransferStoreError({ operation: "reserve", category: "persistence", cause });
    }
    if (!authorityIsCurrent() || !factsIsCurrent(facts)) return yield* scopeDenied();
    // Pre-read canonical scope (plain read, outside the transaction) so the
    // artifact can be bound before the owning transaction; the transaction
    // rereads and revalidates everything.
    const preRows = yield* sql<{ revision: number; snapshot_json: string }>`
      SELECT revision, snapshot_json FROM projection_missions
      WHERE mission_id = ${command.missionId}
        AND team_id = ${authority.teamId}
        AND authority_environment_id = ${authority.environmentId}
    `;
    if (preRows[0] === undefined) return yield* scopeDenied();
    const preCanonical = yield* decodeMission(preRows[0].snapshot_json).pipe(Effect.mapError(toStoreError));
    if (!isIanaTimezone(command.projectTimezone)) return yield* scopeDenied();
    const preAssignment = command.role === "delivery" ? preCanonical.managers.delivery : preCanonical.managers.retro;
    if (
      preAssignment?.threadId !== authority.controllerThreadId ||
      preAssignment?.threadId !== command.currentThreadId ||
      preAssignment?.epoch !== command.currentEpoch ||
      preCanonical.projectTimezone !== command.projectTimezone ||
      !factsBindCanonical(facts, preCanonical) ||
      facts.observedRevision !== preCanonical.revision ||
      facts.role !== command.role ||
      facts.currentThreadId !== command.currentThreadId ||
      facts.currentEpoch !== command.currentEpoch ||
      facts.projectTimezone !== command.projectTimezone
    ) {
      return yield* scopeDenied();
    }
    if (!authorityIsCurrent() || !factsIsCurrent(facts) || currentGate(preCanonical, facts) === "scope") return yield* scopeDenied();
    const artifactBytes = new Uint8Array(yield* artifactPort.readArtifact(command.artifactRef));
    if (!authorityIsCurrent() || !factsIsCurrent(facts)) return yield* scopeDenied();
    const bound = decodeArtifactBytes(artifactBytes, command);
    if (bound === null) return yield* scopeDenied();
    const artifactJson = yield* decodeArtifactJson(new TextDecoder("utf-8", { fatal: true }).decode(artifactBytes)).pipe(Effect.mapError(() => scopeDenied()));
    if (!validateSnapshotShape(artifactJson, yield* preparationContext(preCanonical, command), command, authority.teamId, authority.environmentId)) {
      return yield* scopeDenied();
    }
    if (!authorityIsCurrent() || !factsIsCurrent(facts)) return yield* scopeDenied();
    const requestHash = requestHashFor(command);
    const runOnce = () =>
      sql.withTransaction(Effect.gen(function* () {
        const outcome = yield* reserveTransaction(command, requestHash, artifactJson, facts);
        // Every branch, including rejected receipts, aliases and replay, is
        // fenced at the owning transaction boundary.
        if (!authorityIsCurrent() || !factsIsCurrent(facts)) return yield* scopeDenied();
        return outcome;
      })).pipe(Effect.mapError(toStoreError));
    const first = yield* runOnce().pipe(Effect.result);
    if (Result.isFailure(first)) {
      if (first.failure.category !== "request_conflict") return yield* first.failure;
      const second = yield* runOnce().pipe(Effect.result);
      if (Result.isFailure(second)) return yield* second.failure;
      return second.success;
    }
    return first.success;
  });

  return MissionManagerTransferStore.of({
    reserve: (command) => reserve(command).pipe(Effect.mapError(toStoreError)),
  });
});

export const layer = Layer.effect(MissionManagerTransferStore, make);

import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { Sha256Hex } from "./missionRetro.ts";

/**
 * Bounded durable manager-successor intent reservations for the canonical
 * mission aggregate.
 *
 * Reservation only: the incumbent manager stays authoritative while a
 * successor intent is held. No thread is launched, no epoch is switched, and
 * no session is retired in this slice. Leaf schemas only: one reserved
 * successor identity per logical role, metadata only (no snapshots, prompts,
 * credentials, session handles, or filesystem paths).
 *
 * Durable writes live in the server
 * (`apps/server/src/orchestration-v2/MissionManagerTransferStore.ts`); this
 * module stays free of runtime logic per the contracts rule against heavy
 * runtime in leaf modules.
 */

/** Maximum persisted manager reservations per mission snapshot. */
export const MAX_MANAGER_TRANSFER_RESERVATIONS = 64;

/**
 * Largest same-day ordinal a reservation may carry. Mirrors the pure
 * rotation boundary evaluator bound; reservations never invent ordinals
 * beyond what that evaluator can prepare.
 */
export const MAX_MANAGER_RESERVATION_ORDINAL = 8;

/** Namespace of the immutable handoff artifact a reservation binds. */
export const MANAGER_HANDOFF_ARTIFACT_NAMESPACE = "manager-handoff";

/** Logical manager role a reservation holds a successor intent for. */
export const ManagerReservationRole = Schema.Literals(["delivery", "retro"]);
export type ManagerReservationRole = typeof ManagerReservationRole.Type;

/** Rotation reason the reserved slot was prepared for. */
export const ManagerReservationReason = Schema.Literals([
  "first_slot",
  "new_local_day",
  "context_pressure",
]);
export type ManagerReservationReason = typeof ManagerReservationReason.Type;

const atMost =
  (limit: number) =>
  (values: ReadonlyArray<unknown>): boolean =>
    values.length <= limit;

/** Calendar day in project time, YYYY-MM-DD. DST-safe day arithmetic lives in the store. */
export const ManagerReservationLocalDate = Schema.String.check(
  Schema.makeFilter((value) => {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (parts === null) return false;
    const year = Number(parts[1]);
    const month = Number(parts[2]);
    const day = Number(parts[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
  }, { expected: "a real calendar date YYYY-MM-DD" }),
);
export type ManagerReservationLocalDate = typeof ManagerReservationLocalDate.Type;

/** Namespaced immutable handoff artifact reference `manager-handoff:<sha256>`. No paths. */
export const ManagerHandoffArtifactRef = Schema.String.check(
  Schema.makeFilter((value) => /^manager-handoff:[0-9a-f]{64}$/.test(value), {
    expected: "a manager-handoff:<sha256> artifact reference",
  }),
);
export type ManagerHandoffArtifactRef = typeof ManagerHandoffArtifactRef.Type;

/** Same-day rotation ordinal, finite and bounded. */
export const ManagerReservationOrdinal = NonNegativeInt.check(
  Schema.makeFilter((value) => value <= MAX_MANAGER_RESERVATION_ORDINAL, {
    expected: `at most ${MAX_MANAGER_RESERVATION_ORDINAL} same-day rotations`,
  }),
);
export type ManagerReservationOrdinal = typeof ManagerReservationOrdinal.Type;

/**
 * One durable reserved successor intent. Stores only identity and boundary
 * metadata: the reserved (never created) successor thread id, the
 * authoritative incumbent it was prepared against, the observed canonical
 * revision, the explicit project timezone slot, and the immutable handoff
 * artifact reference plus SHA the bytes verified against.
 */
export const ManagerProjectTimezone = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const BoundedManagerId = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const ManagerCounter = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));

export const MissionManagerReservation = Schema.Struct({
  reservationId: BoundedManagerId,
  /** Reserved successor identifier ONLY; never an actually created thread. */
  successorThreadId: ThreadId.check(Schema.isMaxLength(512)),
  role: ManagerReservationRole,
  currentThreadId: ThreadId.check(Schema.isMaxLength(512)),
  currentEpoch: ManagerCounter,
  observedRevision: ManagerCounter,
  /** Explicit project IANA timezone. Never defaulted; absence denies reservation. */
  timezone: ManagerProjectTimezone,
  localDate: ManagerReservationLocalDate,
  ordinal: ManagerReservationOrdinal,
  reason: ManagerReservationReason,
  artifactRef: ManagerHandoffArtifactRef,
  artifactSha256: Sha256Hex,
  commandId: CommandId.check(Schema.isMaxLength(512)),
  requestDigest: Sha256Hex,
  reservedAt: IsoDateTime,
}).check(Schema.makeFilter((value) => value.artifactRef === `manager-handoff:${value.artifactSha256}`, { expected: "handoff reference bound to its exact SHA-256" }));
export type MissionManagerReservation = typeof MissionManagerReservation.Type;

/** Bounded reservation history. The owning store denies writes at the bound. */
export const MissionManagerReservations = Schema.Array(MissionManagerReservation).check(
  Schema.makeFilter(atMost(MAX_MANAGER_TRANSFER_RESERVATIONS), {
    expected: `at most ${MAX_MANAGER_TRANSFER_RESERVATIONS} manager reservations`,
  }),
);
export type MissionManagerReservations = typeof MissionManagerReservations.Type;

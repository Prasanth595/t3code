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
 * A reservation holds one successor identity per logical role while the
 * incumbent stays authoritative. Its optional `lifecycle` metadata records
 * how far the trusted transition got (standby, quiesce, owner switch,
 * routing confirmation, retirement); an absent `lifecycle` means the
 * reservation is still only `reserved`, which keeps older snapshots valid.
 * Leaf schemas only, metadata only: digests and counters, never snapshots,
 * prompts, credentials, session handles, or filesystem paths.
 *
 * Durable writes live in the server
 * (`apps/server/src/orchestration-v2/MissionManagerTransferStore.ts` reserves,
 * `MissionManagerLifecycleStore.ts` advances); this module stays free of
 * runtime logic per the contracts rule against heavy runtime in leaf modules.
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

/** Every reservation lifecycle state in order; `reserved` is the absence of `lifecycle`. */
export const ManagerLifecycleState = Schema.Literals([
  "reserved",
  "standby_ready",
  "quiesced",
  "transferred",
  "routing_confirmed",
  "retired",
]);
export type ManagerLifecycleState = typeof ManagerLifecycleState.Type;

/** States a stored `lifecycle` record can name. */
export const ManagerLifecycleProgress = Schema.Literals([
  "standby_ready",
  "quiesced",
  "transferred",
  "routing_confirmed",
  "retired",
]);
export type ManagerLifecycleProgress = typeof ManagerLifecycleProgress.Type;

const LIFECYCLE_RANK: Record<ManagerLifecycleProgress, number> = {
  standby_ready: 1,
  quiesced: 2,
  transferred: 3,
  routing_confirmed: 4,
  retired: 5,
};

/**
 * One committed lifecycle milestone: the stable command that committed it,
 * the digest of the trusted evidence it was decided on (evidence itself is
 * never stored), the canonical revision it produced, and its instant.
 */
const ManagerLifecycleMilestone = Schema.Struct({
  commandId: CommandId.check(Schema.isMaxLength(512)),
  evidenceDigest: Sha256Hex,
  revision: ManagerCounter,
  confirmedAt: IsoDateTime,
});

/** The canonical role-owner switch: the old role epoch advanced exactly once. */
const ManagerLifecycleTransfer = Schema.Struct({
  ...ManagerLifecycleMilestone.fields,
  previousEpoch: ManagerCounter,
  newEpoch: ManagerCounter,
});

/** Routing confirmed against the exact new role epoch. */
const ManagerLifecycleRouting = Schema.Struct({
  ...ManagerLifecycleMilestone.fields,
  epoch: ManagerCounter,
});

/**
 * Bounded lifecycle progress for one reservation. Each milestone is present
 * exactly when the state has reached it, so a record can never claim a later
 * state without the earlier trusted evidence.
 */
export const ManagerReservationLifecycle = Schema.Struct({
  state: ManagerLifecycleProgress,
  standby: ManagerLifecycleMilestone,
  quiesce: Schema.optional(ManagerLifecycleMilestone),
  transfer: Schema.optional(ManagerLifecycleTransfer),
  routing: Schema.optional(ManagerLifecycleRouting),
  retirement: Schema.optional(ManagerLifecycleMilestone),
}).check(
  Schema.makeFilter(
    (value) => {
      const rank = LIFECYCLE_RANK[value.state];
      const present = [value.quiesce, value.transfer, value.routing, value.retirement].map(
        (milestone) => milestone !== undefined,
      );
      const expected = [rank >= 2, rank >= 3, rank >= 4, rank >= 5];
      if (present.some((has, index) => has !== expected[index])) return false;
      if (
        value.transfer !== undefined &&
        value.transfer.newEpoch !== value.transfer.previousEpoch + 1
      ) {
        return false;
      }
      return value.routing === undefined || value.routing.epoch === value.transfer?.newEpoch;
    },
    {
      expected:
        "lifecycle milestones matching the stated state, with the epoch advanced exactly once",
    },
  ),
);
export type ManagerReservationLifecycle = typeof ManagerReservationLifecycle.Type;

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
  /** Absent means `reserved`. Only the lifecycle store writes it. */
  lifecycle: Schema.optional(ManagerReservationLifecycle),
}).check(Schema.makeFilter((value) => value.artifactRef === `manager-handoff:${value.artifactSha256}`, { expected: "handoff reference bound to its exact SHA-256" }));
export type MissionManagerReservation = typeof MissionManagerReservation.Type;

/** Lifecycle state of a reservation; older records without `lifecycle` are `reserved`. */
export const managerReservationState = (
  reservation: Pick<MissionManagerReservation, "lifecycle">,
): ManagerLifecycleState => reservation.lifecycle?.state ?? "reserved";

/** Bounded reservation history. The owning store denies writes at the bound. */
export const MissionManagerReservations = Schema.Array(MissionManagerReservation).check(
  Schema.makeFilter(atMost(MAX_MANAGER_TRANSFER_RESERVATIONS), {
    expected: `at most ${MAX_MANAGER_TRANSFER_RESERVATIONS} manager reservations`,
  }),
);
export type MissionManagerReservations = typeof MissionManagerReservations.Type;

import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Bounded optional execution state for the canonical mission aggregate.
 *
 * Holds admission/reservation receipts, normalized writer scope claims, and
 * consumed one-use exception IDs. Only the dedicated admission-reserved
 * event may append here; generic create/replace cannot forge or erase it.
 * Arrays stay small (no transcripts); when a bound is reached the admission
 * store denies further admissions rather than dropping history.
 */

/** Maximum persisted admission receipts per mission snapshot. */
export const MAX_MISSION_EXECUTION_ADMISSIONS = 64;
/** Maximum persisted writer scope claims per mission snapshot. */
export const MAX_MISSION_EXECUTION_WRITER_CLAIMS = 64;
/** Maximum persisted consumed exception IDs per mission snapshot. */
export const MAX_MISSION_EXECUTION_CONSUMED_EXCEPTIONS = 64;
/** Maximum rejected routes carried on one persisted admission receipt. */
export const MAX_MISSION_EXECUTION_REJECTED_ROUTES = 32;

const ObservedMillis = Schema.Number.check(Schema.makeFilter((v) => Number.isFinite(v) && v >= 0, { expected: "finite nonnegative milliseconds" }));

const atMost =
  (limit: number) =>
  (values: ReadonlyArray<unknown>): boolean =>
    values.length <= limit;

export const MissionExecutionOperation = Schema.Literals(["read", "test", "write"]);
export type MissionExecutionOperation = typeof MissionExecutionOperation.Type;

/** Server-verified route that won the admission, as persisted. */
export const MissionExecutionRoute = Schema.Struct({
  providerInstanceId: TrimmedNonEmptyString,
  modelId: TrimmedNonEmptyString,
  profile: TrimmedNonEmptyString,
});
export type MissionExecutionRoute = typeof MissionExecutionRoute.Type;

export const MissionExecutionRejectedRoute = Schema.Struct({
  providerInstanceId: TrimmedNonEmptyString,
  modelId: TrimmedNonEmptyString,
  reason: TrimmedNonEmptyString,
  observedAtMs: ObservedMillis,
});
export type MissionExecutionRejectedRoute = typeof MissionExecutionRejectedRoute.Type;

/**
 * One durable admission receipt. Mirrors the server admission receipt field
 * for field so an exact replay returns the same committed receipt.
 */
export const MissionExecutionAdmission = Schema.Struct({
  dispatchKey: TrimmedNonEmptyString,
  teamId: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
  missionId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  attemptNumber: NonNegativeInt,
  operation: MissionExecutionOperation,
  requestDigest: TrimmedNonEmptyString,
  admittedAtMs: ObservedMillis,
  chosenRoute: MissionExecutionRoute,
  rejectedRoutes: Schema.Array(MissionExecutionRejectedRoute).check(
    Schema.makeFilter(atMost(MAX_MISSION_EXECUTION_REJECTED_ROUTES), {
      expected: `at most ${MAX_MISSION_EXECUTION_REJECTED_ROUTES} rejected routes`,
    }),
  ),
  accountVerifiedAtMs: ObservedMillis,
  hostObservedAtMs: ObservedMillis,
  repositoryObservedAtMs: ObservedMillis,
  accountId: TrimmedNonEmptyString,
  billingMode: TrimmedNonEmptyString,
  hostId: TrimmedNonEmptyString,
  bootId: TrimmedNonEmptyString,
  hostThreadId: TrimmedNonEmptyString,
  hostEpoch: NonNegativeInt,
  unknownUsageException: Schema.Boolean,
  unknownUsageExceptionId: Schema.NullOr(TrimmedNonEmptyString),
  exceptionConsumptionRef: Schema.NullOr(TrimmedNonEmptyString),
});
export type MissionExecutionAdmission = typeof MissionExecutionAdmission.Type;

/** Normalized absolute server realpath claimed by one write admission. */
export const MissionExecutionScopeClaim = Schema.Struct({
  scope: TrimmedNonEmptyString,
  dispatchKey: TrimmedNonEmptyString,
  missionId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  attemptNumber: NonNegativeInt,
  operation: MissionExecutionOperation,
});
export type MissionExecutionScopeClaim = typeof MissionExecutionScopeClaim.Type;

export const MissionExecution = Schema.Struct({
  admissions: Schema.Array(MissionExecutionAdmission).check(
    Schema.makeFilter(atMost(MAX_MISSION_EXECUTION_ADMISSIONS), {
      expected: `at most ${MAX_MISSION_EXECUTION_ADMISSIONS} admissions`,
    }),
  ),
  writerClaims: Schema.Array(MissionExecutionScopeClaim).check(
    Schema.makeFilter(atMost(MAX_MISSION_EXECUTION_WRITER_CLAIMS), {
      expected: `at most ${MAX_MISSION_EXECUTION_WRITER_CLAIMS} writer claims`,
    }),
  ),
  consumedExceptionIds: Schema.Array(TrimmedNonEmptyString).check(
    Schema.makeFilter(atMost(MAX_MISSION_EXECUTION_CONSUMED_EXCEPTIONS), {
      expected: `at most ${MAX_MISSION_EXECUTION_CONSUMED_EXCEPTIONS} consumed exception ids`,
    }),
  ),
});
export type MissionExecution = typeof MissionExecution.Type;

/** Fresh empty execution state for a mission with no admissions yet. */
export const emptyMissionExecution = (): MissionExecution => ({
  admissions: [],
  writerClaims: [],
  consumedExceptionIds: [],
});

/** True when no admission, claim, or consumption is recorded. */
export const isEmptyMissionExecution = (execution: MissionExecution): boolean =>
  execution.admissions.length === 0 &&
  execution.writerClaims.length === 0 &&
  execution.consumedExceptionIds.length === 0;

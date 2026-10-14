import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Bounded Retro checkpoint descriptors for the canonical mission aggregate.
 *
 * Leaf schemas only: descriptors store bounded source references, hashes,
 * covered ranges, and omission notes so later audit can rebind the exact
 * originating evidence boundary. No transcripts, no raw report text, no
 * secrets, and no process arguments are persisted here.
 *
 * Capture and queueing live in the server
 * (`apps/server/src/orchestration-v2/MissionRetroCheckpointStore.ts`); this
 * module stays free of runtime logic per the contracts rule against heavy
 * runtime in leaf modules.
 */

/** Maximum persisted retro checkpoint descriptors per mission snapshot. */
export const MAX_MISSION_RETRO_CHECKPOINTS = 64;
/** Maximum bounded source refs carried on one checkpoint descriptor. */
export const MAX_MISSION_RETRO_SOURCE_REFS = 16;
/** Maximum omission notes carried on one checkpoint descriptor. */
export const MAX_MISSION_RETRO_OMISSIONS = 16;

/** Owner-requested reporter identity for queued retro analysis. */
export const REQUESTED_RETRO_REPORTER = "muse-spark-1.3-contributor";
/** Company allowlist value that may confirm a queued-ready reporter. */
export const ELIGIBLE_RETRO_COMPANY = "No Fun";

const maxLength = (limit: number) =>
  Schema.makeFilter((value: string) => value.length <= limit, {
    expected: `at most ${limit} characters`,
  });

/** Bounded identifier or reference (256 chars). */
export const RetroId = TrimmedNonEmptyString.check(maxLength(256));
export type RetroId = typeof RetroId.Type;

/** Lowercase SHA-256 hex digest pattern for chunk hashes and fingerprints. */
export const Sha256Hex = Schema.String.check(
  Schema.makeFilter((value) => /^[0-9a-f]{64}$/.test(value), {
    expected: "a lowercase SHA-256 hex digest",
  }),
);
export type Sha256Hex = typeof Sha256Hex.Type;

/** Eligible capture triggers. Routine tool/status/ACK work never qualifies. */
export const RetroTrigger = Schema.Literals([
  "milestone",
  "settled",
  "complete",
  "new_blocker",
  "compaction",
]);
export type RetroTrigger = typeof RetroTrigger.Type;

/** Queue status. Capacity or identity gaps persist as capacity, never dropped. */
export const RetroCheckpointStatus = Schema.Literals(["queued_capacity", "queued_ready"]);
export type RetroCheckpointStatus = typeof RetroCheckpointStatus.Type;

/**
 * Explicit capture dimension. A partial snapshot read stays unknown: absent
 * findings never imply clean coverage.
 */
export const RetroCoverage = Schema.Literals(["full", "unknown"]);
export type RetroCoverage = typeof RetroCoverage.Type;

/**
 * One bounded source reference inside a checkpoint descriptor. The chunk
 * ref plus hash plus covered range lets later audit rebind the exact
 * authorized log slice without persisting its contents.
 */
export const MissionRetroSourceRef = Schema.Struct({
  rootRef: RetroId,
  chunkRef: RetroId,
  chunkHash: Sha256Hex,
  coveredFromInclusive: NonNegativeInt,
  coveredToExclusive: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (ref) => ref.coveredFromInclusive < ref.coveredToExclusive,
    { expected: "an ascending non-empty event range" },
  ),
);
export type MissionRetroSourceRef = typeof MissionRetroSourceRef.Type;

const atMost =
  (limit: number) =>
  (values: ReadonlyArray<unknown>): boolean =>
    values.length <= limit;

/** Bounded omission note (512 chars). */
export const RetroOmission = TrimmedNonEmptyString.check(maxLength(512));
export type RetroOmission = typeof RetroOmission.Type;

/**
 * One durable retro checkpoint descriptor. The originating source thread is
 * recorded here; it is never the reporter child that later analyzes the
 * queued boundary, and no report-of-report is derived from it in this slice.
 */
export const MissionRetroCheckpoint = Schema.Struct({
  checkpointId: RetroId,
  teamId: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
  missionId: TrimmedNonEmptyString,
  /** Originating source thread whose evidence boundary was captured. */
  sourceThreadId: TrimmedNonEmptyString,
  /** Authorized log root the snapshot was read from. */
  sourceRoot: RetroId,
  trigger: RetroTrigger,
  requestedReporter: Schema.Literal(REQUESTED_RETRO_REPORTER),
  status: RetroCheckpointStatus,
  coverage: RetroCoverage,
  snapshotFingerprint: Sha256Hex,
  coveredFromInclusive: NonNegativeInt,
  coveredToExclusive: NonNegativeInt,
  sourceRefs: Schema.Array(MissionRetroSourceRef).check(
    Schema.makeFilter(atMost(MAX_MISSION_RETRO_SOURCE_REFS), {
      expected: `at most ${MAX_MISSION_RETRO_SOURCE_REFS} source refs`,
    }),
  ),
  omissions: Schema.Array(RetroOmission).check(
    Schema.makeFilter(atMost(MAX_MISSION_RETRO_OMISSIONS), {
      expected: `at most ${MAX_MISSION_RETRO_OMISSIONS} omissions`,
    }),
  ),
  capturedAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (checkpoint) => checkpoint.coveredFromInclusive < checkpoint.coveredToExclusive,
    { expected: "an ascending non-empty covered range" },
  ),
);
export type MissionRetroCheckpoint = typeof MissionRetroCheckpoint.Type;

/** Bounded checkpoint descriptors. Only the retro-captured event appends here. */
export const MissionRetroCheckpoints = Schema.Array(MissionRetroCheckpoint).check(
  Schema.makeFilter(atMost(MAX_MISSION_RETRO_CHECKPOINTS), {
    expected: `at most ${MAX_MISSION_RETRO_CHECKPOINTS} retro checkpoints`,
  }),
);
export type MissionRetroCheckpoints = typeof MissionRetroCheckpoints.Type;

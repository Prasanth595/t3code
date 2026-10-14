import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";
import {
  MAX_MISSION_RETRO_OMISSIONS,
  MAX_MISSION_RETRO_SOURCE_REFS,
  MissionRetroSourceRef,
  RetroId,
  RetroOmission,
  Sha256Hex,
} from "./missionRetro.ts";

/**
 * Bounded source-report envelope for one retro checkpoint analysis.
 *
 * Leaf schemas only: the descriptor anchors the originating evidence
 * boundary (checkpoint/team/env/mission/source thread/fingerprint/range),
 * the reporter identity (child thread/run/revision/hash/token/epoch), the
 * manifest source refs as seen by the worker, read-coverage receipt refs,
 * explicit omissions, a bounded summary, a severity-ordered shortlist, and
 * a linked evidence index of every distinct material incident.
 *
 * No transcripts, raw stdout, process arguments, or full model text are
 * stored here. Coverage is never self-certified: the worker's verdict and
 * claimed receipts are claims only. Trusted coverage is recomputed by the
 * server's pure reconciliation (`MissionRetroReportReconciliation.ts`)
 * from immutable manifest refs and actual read receipts, which this module
 * never sees.
 */

const maxLength = (limit: number) =>
  Schema.makeFilter((value: string) => value.length <= limit, {
    expected: `at most ${limit} characters`,
  });

const atMost =
  (limit: number) =>
  (values: ReadonlyArray<unknown>): boolean =>
    values.length <= limit;

/** Maximum shortlist candidates: normally zero to three, never truncated silently. */
export const MAX_MISSION_RETRO_REPORT_SHORTLIST = 3;
/** Maximum distinct incidents in the linked evidence index. Excess is denied. */
export const MAX_MISSION_RETRO_REPORT_INCIDENTS = 128;
/** Maximum claimed read-receipt refs carried on one report. */
export const MAX_MISSION_RETRO_REPORT_READ_REFS = 64;
/** Maximum skill-evidence entries carried on one report. */
export const MAX_MISSION_RETRO_REPORT_SKILLS = 16;
/** Maximum incident refs linked from one shortlist candidate. */
export const MAX_MISSION_RETRO_REPORT_CANDIDATE_INCIDENTS = 8;
/** Maximum bounded report summary characters. */
export const MAX_MISSION_RETRO_REPORT_SUMMARY = 2048;
/** Maximum bounded incident/candidate summary characters. */
export const MAX_MISSION_RETRO_REPORT_ITEM_SUMMARY = 512;

/** Owner-requested reporter model for retro analysis. */
export const REQUESTED_RETRO_REPORTER_MODEL = "muse-spark-1.3-contributor";
/** Read-only analysis profile the reporter runs under. */
export const EXPECTED_RETRO_REPORTER_PROFILE = "muse-review";

/** Worker-claimed verdict. Trusted coverage always overrides toward partial. */
export const RetroReportVerdict = Schema.Literals([
  "no_change",
  "candidates",
  "partial_coverage",
]);
export type RetroReportVerdict = typeof RetroReportVerdict.Type;

/** Destination owner classification for one incident or candidate. */
export const RetroReportDestination = Schema.Literals([
  "runtime_tool",
  "catalog_pointer",
  "project_guidance",
  "skill_reference",
  "task_recovery",
  "no_change",
]);
export type RetroReportDestination = typeof RetroReportDestination.Type;

/**
 * One distinct material incident in the linked evidence index. At least one
 * source event/run/task ref is required: an incident without provenance is
 * malformed. Summaries stay bounded; no effectiveness is self-certified.
 */
export const MissionRetroReportIncident = Schema.Struct({
  incidentId: RetroId,
  concernId: RetroId,
  sourceEventRef: Schema.optional(RetroId),
  sourceRunRef: Schema.optional(RetroId),
  sourceTaskRef: Schema.optional(RetroId),
  summary: Schema.String.check(maxLength(MAX_MISSION_RETRO_REPORT_ITEM_SUMMARY)),
  destinationOwner: RetroReportDestination,
}).check(
  Schema.makeFilter(
    (incident) =>
      incident.sourceEventRef !== undefined ||
      incident.sourceRunRef !== undefined ||
      incident.sourceTaskRef !== undefined,
    { expected: "at least one source event, run, or task ref" },
  ),
);
export type MissionRetroReportIncident = typeof MissionRetroReportIncident.Type;

/**
 * One severity-ordered shortlist candidate. Every linked incident ref must
 * resolve into the report's own evidence index; the shortlist never
 * discards index entries.
 */
export const MissionRetroReportCandidate = Schema.Struct({
  candidateId: RetroId,
  concernId: RetroId,
  incidentRefs: Schema.Array(RetroId).check(
    Schema.makeFilter(
      (refs) => refs.length >= 1 && refs.length <= MAX_MISSION_RETRO_REPORT_CANDIDATE_INCIDENTS,
      {
        expected: `one to ${MAX_MISSION_RETRO_REPORT_CANDIDATE_INCIDENTS} linked incident refs`,
      },
    ),
  ),
  summary: Schema.String.check(maxLength(MAX_MISSION_RETRO_REPORT_ITEM_SUMMARY)),
  destinationOwner: RetroReportDestination,
  alreadyFixed: Schema.Boolean,
});
export type MissionRetroReportCandidate = typeof MissionRetroReportCandidate.Type;

/**
 * Independent skill-use evidence dimensions. A filename alone never proves
 * installation: any non-unknown invocation must carry the observed
 * resolution path plus the observed source revision SHA. A skill with no
 * resolution evidence is absent here, which reads as unknown, never as
 * native invocation.
 */
export const MissionRetroReportSkillEvidence = Schema.Struct({
  skillPath: RetroId,
  observedRevision: Schema.optional(Sha256Hex),
  expectedApplicability: Schema.Literals(["applicable", "not_applicable", "unknown"]),
  discovery: Schema.Literals([
    "installed",
    "advertised",
    "omitted",
    "truncated",
    "collision",
    "unknown",
  ]),
  invocation: Schema.Literals(["native_invoked", "reference_loaded", "failed_load", "unknown"]),
  application: Schema.Literals(["applied", "skipped", "not_followed", "unknown"]),
  outcome: Schema.Literals([
    "failure_original",
    "success_behavior",
    "untested",
    "no_change",
    "unknown",
  ]),
  outcomeRef: Schema.optional(RetroId),
}).check(
  Schema.makeFilter(
    (entry) =>
      entry.invocation === "unknown" ||
      entry.invocation === "failed_load" ||
      entry.observedRevision !== undefined,
    { expected: "an observed source revision for a loaded or invoked resolution" },
  ),
);
export type MissionRetroReportSkillEvidence = typeof MissionRetroReportSkillEvidence.Type;

/**
 * One bounded source report. The descriptor anchors the originating
 * evidence boundary; the reporter block echoes the exact server-issued
 * assignment (child thread/run/revision/token/epoch) plus the model and
 * profile the worker ran under. Claimed read refs are informational only:
 * only trusted receipts establish coverage.
 */
export const MissionRetroReport = Schema.Struct({
  checkpointId: RetroId,
  teamId: RetroId,
  environmentId: RetroId,
  missionId: RetroId,
  /** Originating source thread. Never the reporter child analyzing it. */
  sourceThreadId: RetroId,
  sourceRoot: RetroId,
  snapshotFingerprint: Sha256Hex,
  coveredFromInclusive: NonNegativeInt,
  coveredToExclusive: NonNegativeInt,
  reporterChildThreadId: RetroId,
  reporterRunId: RetroId,
  reportRevision: NonNegativeInt,
  reportHash: Sha256Hex,
  assignmentToken: RetroId,
  managerEpoch: NonNegativeInt,
  model: RetroId,
  profile: RetroId,
  /** Manifest source refs as seen by the worker (subset allowed). */
  sourceRefs: Schema.Array(MissionRetroSourceRef).check(
    Schema.makeFilter(atMost(MAX_MISSION_RETRO_SOURCE_REFS), {
      expected: `at most ${MAX_MISSION_RETRO_SOURCE_REFS} source refs`,
    }),
  ),
  /** Worker-claimed read-coverage receipt refs. Informational, never trusted. */
  claimedReadRefs: Schema.Array(RetroId).check(
    Schema.makeFilter(atMost(MAX_MISSION_RETRO_REPORT_READ_REFS), {
      expected: `at most ${MAX_MISSION_RETRO_REPORT_READ_REFS} claimed read refs`,
    }),
  ),
  summary: Schema.String.check(maxLength(MAX_MISSION_RETRO_REPORT_SUMMARY)),
  verdict: RetroReportVerdict,
  shortlist: Schema.Array(MissionRetroReportCandidate).check(
    Schema.makeFilter(atMost(MAX_MISSION_RETRO_REPORT_SHORTLIST), {
      expected: `at most ${MAX_MISSION_RETRO_REPORT_SHORTLIST} shortlist candidates`,
    }),
  ),
  incidents: Schema.Array(MissionRetroReportIncident).check(
    Schema.makeFilter(atMost(MAX_MISSION_RETRO_REPORT_INCIDENTS), {
      expected: `at most ${MAX_MISSION_RETRO_REPORT_INCIDENTS} evidence incidents`,
    }),
  ),
  skillEvidence: Schema.Array(MissionRetroReportSkillEvidence).check(
    Schema.makeFilter(atMost(MAX_MISSION_RETRO_REPORT_SKILLS), {
      expected: `at most ${MAX_MISSION_RETRO_REPORT_SKILLS} skill evidence entries`,
    }),
  ),
  /** Explicit worker omissions. Any entry keeps the verdict partial. */
  omissions: Schema.Array(RetroOmission).check(
    Schema.makeFilter(atMost(MAX_MISSION_RETRO_OMISSIONS), {
      expected: `at most ${MAX_MISSION_RETRO_OMISSIONS} omissions`,
    }),
  ),
}).check(
  Schema.makeFilter(
    (report) => report.coveredFromInclusive < report.coveredToExclusive,
    { expected: "an ascending non-empty covered range" },
  ),
);
export type MissionRetroReport = typeof MissionRetroReport.Type;

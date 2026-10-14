// @effect-diagnostics nodeBuiltinImport:off -- deterministic report SHA binds evidence and receipts.
// Pure P2 source-report reconciliation: decide what one reporter child's
// source report means for its retro checkpoint's analysis coverage.
//
// The canonical mission caller owns persistence: it supplies the trusted
// context (expected checkpoint, current analysis assignment, immutable
// manifest/source refs, actual read receipts), persists the returned
// validated report alongside existing mission events, and routes triage
// later. This module performs no I/O, Effect, database, CLI, model, outbox,
// lease, or skill work of any kind: `reconcileRetroReport` decodes the
// unknown worker input fail-closed and decides purely from the trusted
// context.
//
// Contract: a report advances to root/manager triage only against the
// active exact assignment (reporter child/run/revision/token/epoch, exact
// model and profile, verified No Fun account) with trusted full coverage.
// Everything else is held, quarantined, or denied. An accepted report is
// only queued for triage: no candidate evaluation, skill edit, or
// installation authority is granted here.
import * as NodeCrypto from "node:crypto";

import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { ELIGIBLE_RETRO_COMPANY } from "../../../../packages/contracts/src/missionRetro.ts";
import {
  EXPECTED_RETRO_REPORTER_PROFILE,
  MissionRetroReport,
  REQUESTED_RETRO_REPORTER_MODEL,
  type MissionRetroReport as MissionRetroReportValue,
  type MissionRetroReportCandidate as MissionRetroReportCandidateValue,
  type MissionRetroReportIncident as MissionRetroReportIncidentValue,
  type MissionRetroReportSkillEvidence as MissionRetroReportSkillEvidenceValue,
  type RetroReportVerdict,
} from "../../../../packages/contracts/src/missionRetroReport.ts";
import type { MissionRetroSourceRef as MissionRetroSourceRefValue } from "../../../../packages/contracts/src/missionRetro.ts";

/**
 * Leaf schemas and types live in contracts (`missionRetroReport.ts`) and
 * are re-exported here so importers of this policy module keep working.
 * This module keeps only the pure reconciliation function.
 */
export * from "../../../../packages/contracts/src/missionRetroReport.ts";

/** Actual origins that never produce automatic source capture. */
export const RECURSIVE_RETRO_REPORT_ORIGINS: ReadonlySet<string> = new Set([
  "reporter",
  "retro_pipeline",
  "replay",
  "triage",
  "housekeeping",
]);

/** Server-trusted immutable expected checkpoint the report must anchor. */
export interface MissionRetroReportExpectedCheckpoint {
  readonly checkpointId: string;
  readonly teamId: string;
  readonly environmentId: string;
  readonly missionId: string;
  readonly sourceThreadId: string;
  readonly sourceRoot: string;
  readonly snapshotFingerprint: string;
  readonly fromInclusive: number;
  readonly toExclusive: number;
}

/**
 * Server-trusted current analysis assignment. The report echoes these
 * exact values; worker assertions can never manufacture them.
 */
export interface MissionRetroReportAssignment {
  readonly reporterChildThreadId: string;
  readonly reporterRunId: string;
  readonly reportRevision: number;
  readonly assignmentToken: string;
  readonly managerEpoch: number;
  readonly requestedModel: string;
  readonly requestedProfile: string;
  readonly verifiedCompany: string | null;
  /** Trusted verified account/provider facts; company alone never verifies an account. */
  readonly verifiedAccountRef: string;
  readonly verifiedProviderRef: string;
  readonly status: "active" | "superseded" | "revoked";
  /** Trusted actual origin of the source work, never the caller's label. */
  readonly actualOrigin: string;
}

/** One trusted skill load/resolution receipt matching an observed revision. */
export interface MissionRetroReportTrustedSkillLoad {
  readonly skillPath: string;
  readonly observedRevision: string;
  readonly discovery?: MissionRetroReportSkillEvidenceValue["discovery"];
  readonly invocation?: MissionRetroReportSkillEvidenceValue["invocation"];
  readonly application?: MissionRetroReportSkillEvidenceValue["application"];
  readonly outcome?: MissionRetroReportSkillEvidenceValue["outcome"];
  readonly outcomeRef?: string;
}

/** Trusted coverage facts: immutable manifest plus actual read receipts. */
export interface MissionRetroReportTrustedCoverage {
  readonly manifestSourceRefs: ReadonlyArray<MissionRetroSourceRefValue>;
  readonly readReceipts: ReadonlyArray<MissionRetroSourceRefValue>;
  readonly apiCoverage: "full" | "partial" | "unknown";
  readonly childLogCoverage: "full" | "partial" | "unknown";
  readonly rawStdoutCoverage: "full" | "partial" | "unknown";
  readonly pendingChildRuns: boolean;
  /** Trusted skill load receipts; reporter skill claims alone never prove a load. */
  readonly trustedSkillLoads?: ReadonlyArray<MissionRetroReportTrustedSkillLoad> | undefined;
}

/**
 * Server-trusted immutable reconciliation context. Every field is supplied
 * by the runtime, never by the reporter.
 */
export interface MissionRetroReportContext {
  readonly expectedCheckpoint: MissionRetroReportExpectedCheckpoint;
  readonly assignment: MissionRetroReportAssignment;
  readonly coverage: MissionRetroReportTrustedCoverage;
  /** Latest recorded disposition for replay/conflict detection. */
  readonly priorAccepted?:
    | { readonly reportRevision: number; readonly reportHash: string }
    | undefined;
}

export const MissionRetroReportDisposition = Schema.Literals([
  "queued_for_triage",
  "held_partial",
  "held_quarantined",
  "held_conflict",
  "recovered_duplicate",
]);
export type MissionRetroReportDisposition = typeof MissionRetroReportDisposition.Type;

export interface MissionRetroReportCoverage {
  readonly full: boolean;
  readonly reasons: ReadonlyArray<string>;
}

export interface MissionRetroReportDecision {
  readonly report: MissionRetroReportValue;
  /** Original decoded input hash for command idempotency, before normalization. */
  readonly sourceReportHash: string;
  readonly submittedReportHash: string;
  readonly disposition: MissionRetroReportDisposition;
  readonly verdict: RetroReportVerdict;
  readonly coverage: MissionRetroReportCoverage;
  readonly detail: string;
}

export class MissionRetroReportReconciliationError extends Schema.TaggedError<MissionRetroReportReconciliationError>()(
  "MissionRetroReportReconciliationError",
  {
    operation: Schema.Literal("reconcile"),
    category: Schema.Literals([
      "malformed",
      "out_of_bounds",
      "unknown_source_ref",
      "invalid_shortlist_ref",
      "conflicting_incidents",
      "recursive_origin",
      "coverage_denied",
      "skill_evidence_invalid",
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Mission retro report reconcile failed (${this.category}).`;
  }
}
export type MissionRetroReportReconciliationResult = Result.Result<
  MissionRetroReportDecision,
  MissionRetroReportReconciliationError
>;

const decide = (
  report: MissionRetroReportValue,
  disposition: MissionRetroReportDisposition,
  verdict: RetroReportVerdict,
  coverage: MissionRetroReportCoverage,
  detail: string,
  sourceReportHash = computeRetroReportHash(report),
): MissionRetroReportReconciliationResult =>
  Result.succeed({ report: withActualReportHash(report), sourceReportHash,
    submittedReportHash: report.reportHash, disposition, verdict, coverage, detail });
const refuse = (
  category: MissionRetroReportReconciliationError["category"],
  detail: string,
): MissionRetroReportReconciliationResult =>
  Result.fail(new MissionRetroReportReconciliationError({ operation: "reconcile", category, detail }));

const decodeReportSchema = Schema.decodeUnknownSync(MissionRetroReport, { onExcessProperty: "error" });

const decodeReport = (input: unknown): MissionRetroReportValue | null => {
  try {
    // Excess wire properties are errors, never silently ignored semantic fields.
    return decodeReportSchema(input);
  } catch {
    return null;
  }
};

/**
 * Authoritative server hash over the schema-decoded canonical full report
 * excluding `reportHash`. The reporter's claimed hash never attests bytes.
 */
export const computeRetroReportHash = (report: MissionRetroReportValue): string => {
  const { reportHash: _claimed, ...canonical } = report;
  return NodeCrypto.createHash("sha256").update(stableStringify(canonical)).digest("hex");
};

/** Construct a report whose claimed hash equals its actual canonical hash. */
export const withActualReportHash = (
  report: Omit<MissionRetroReportValue, "reportHash"> & { readonly reportHash?: string },
): MissionRetroReportValue => {
  const base = { ...report, reportHash: "0".repeat(64) } as MissionRetroReportValue;
  return { ...base, reportHash: computeRetroReportHash(base) };
};

/** Normalized dedup key: stable encoding of the source/concern tuple, never a delimiter join. */
const incidentKeyFor = (incident: MissionRetroReportIncidentValue): string =>
  stableStringify([
    incident.sourceEventRef ?? null,
    incident.sourceRunRef ?? null,
    incident.sourceTaskRef ?? null,
    incident.concernId,
  ]);

/**
 * Reconcile one source report against the server-trusted context. Pure:
 * no Effect, database, CLI, or model work. Worker-claimed coverage never
 * establishes full coverage; only trusted receipts do.
 */
export const reconcileRetroReport = (input: {
  readonly context: MissionRetroReportContext;
  readonly report: unknown;
}): MissionRetroReportReconciliationResult => {
  const { context } = input;
  const expected = context.expectedCheckpoint;
  const assignment = context.assignment;
  const trusted = context.coverage;

  const report = decodeReport(input.report);
  if (report === null) {
    return refuse("malformed", "The report input does not decode as a bounded retro report.");
  }

  // Recursive actual origins never produce automatic source capture. The
  // trusted actual origin gates here; the caller's label is never used.
  if (RECURSIVE_RETRO_REPORT_ORIGINS.has(assignment.actualOrigin)) {
    return refuse(
      "recursive_origin",
      `Actual origin '${assignment.actualOrigin}' is never auto-captured for retro analysis.`,
    );
  }

  // A stale, superseded, or revoked assignment cannot advance the report.
  if (assignment.status !== "active") {
    return decide(
      report,
      "held_quarantined",
      "partial_coverage",
      { full: false, reasons: ["assignment not active"] },
      `Stale assignment (${assignment.status}): the report cannot advance.`,
    );
  }

  // Scope and identity: every mismatch quarantines with a fixed reason.
  // The originating source thread is never substituted with the reporter child.
  const mismatch = (
    actual: unknown,
    wanted: unknown,
    name: string,
  ): MissionRetroReportReconciliationResult | null =>
    actual === wanted
      ? null
      : decide(
          report,
          "held_quarantined",
          "partial_coverage",
          { full: false, reasons: [`scope mismatch: ${name}`] },
          `Held: report ${name} does not match the trusted assignment.`,
        );
  if (report.sourceThreadId === assignment.reporterChildThreadId) {
    return decide(
      report,
      "held_quarantined",
      "partial_coverage",
      { full: false, reasons: ["origin substituted with reporter child"] },
      "Held: the originating source thread is never the reporter child.",
    );
  }
  const scopeChecks: ReadonlyArray<MissionRetroReportReconciliationResult | null> = [
    mismatch(report.teamId, expected.teamId, "team"),
    mismatch(report.environmentId, expected.environmentId, "environment"),
    mismatch(report.missionId, expected.missionId, "mission"),
    mismatch(report.sourceThreadId, expected.sourceThreadId, "source thread"),
    mismatch(report.sourceRoot, expected.sourceRoot, "origin"),
    mismatch(report.checkpointId, expected.checkpointId, "checkpoint"),
    mismatch(report.snapshotFingerprint, expected.snapshotFingerprint, "fingerprint"),
    mismatch(report.coveredFromInclusive, expected.fromInclusive, "range start"),
    mismatch(report.coveredToExclusive, expected.toExclusive, "range end"),
    mismatch(report.reporterChildThreadId, assignment.reporterChildThreadId, "reporter child"),
    mismatch(report.reporterRunId, assignment.reporterRunId, "reporter run"),
    mismatch(report.reportRevision, assignment.reportRevision, "report revision"),
    mismatch(report.assignmentToken, assignment.assignmentToken, "assignment token"),
    mismatch(report.managerEpoch, assignment.managerEpoch, "manager epoch"),
    mismatch(report.model, assignment.requestedModel, "reporter model"),
    mismatch(report.model, REQUESTED_RETRO_REPORTER_MODEL, "reporter model"),
    mismatch(report.profile, assignment.requestedProfile, "reporter profile"),
    mismatch(report.profile, EXPECTED_RETRO_REPORTER_PROFILE, "reporter profile"),
    mismatch(assignment.verifiedCompany, ELIGIBLE_RETRO_COMPANY, "verified company"),
    mismatch(
      typeof assignment.verifiedAccountRef === "string" && assignment.verifiedAccountRef.trim().length > 0,
      true,
      "verified account",
    ),
    mismatch(
      typeof assignment.verifiedProviderRef === "string" && assignment.verifiedProviderRef.trim().length > 0,
      true,
      "verified provider",
    ),
  ];
  for (const held of scopeChecks) {
    if (held !== null) return held;
  }

  // Evidence binding: the authoritative hash is computed over the actual
  // decoded bytes. A claimed hash that does not match its own bytes can
  // never recover an accepted receipt, whatever field was tampered with.
  const actualHash = computeRetroReportHash(report);
  if (report.reportHash !== actualHash) {
    return decide(
      report,
      "held_conflict",
      "partial_coverage",
      { full: false, reasons: ["claimed hash does not match actual report bytes"] },
      "Held: the claimed report hash does not attest the submitted bytes.",
    );
  }

  // Exact accepted repeat recovers with no second disposition. The prior
  // recorded hash is compared against the ACTUAL bytes before any return.
  const prior = context.priorAccepted;
  if (prior !== undefined && prior.reportRevision === report.reportRevision) {
    if (prior.reportHash === actualHash) {
      return decide(
        report,
        "recovered_duplicate",
        "partial_coverage",
        { full: false, reasons: ["exact replay of recorded report"] },
        "Recovered: the exact accepted report repeats; no second disposition.",
      );
    }
    return decide(
      report,
      "held_conflict",
      "partial_coverage",
      { full: false, reasons: ["same revision with changed hash"] },
      "Held: the same report revision carries a changed hash.",
    );
  }

  // Worker-claimed source refs are sanity-checked against the trusted
  // manifest: unknown chunk refs and out-of-range or mismatched refs are
  // denied, never counted as coverage.
  // Bounded trusted collections with finite integer bounds; duplicate
  // chunk refs carrying differing hash/root/range fail closed.
  const validBound = (n: number): boolean => Number.isInteger(n) && n >= 0;
  if (
    trusted.manifestSourceRefs.length > 1024 ||
    trusted.readReceipts.length > 4096 ||
    trusted.manifestSourceRefs.some(
      (ref) => !validBound(ref.coveredFromInclusive) || !validBound(ref.coveredToExclusive),
    ) ||
    trusted.readReceipts.some(
      (ref) => !validBound(ref.coveredFromInclusive) || !validBound(ref.coveredToExclusive),
    )
  ) {
    return refuse("coverage_denied", "Trusted coverage collections are unbounded or non-integer.");
  }
  const manifestByChunk = new Map<string, MissionRetroSourceRefValue>();
  for (const ref of trusted.manifestSourceRefs) {
    const seen = manifestByChunk.get(ref.chunkRef);
    if (
      seen !== undefined &&
      (seen.chunkHash !== ref.chunkHash ||
        seen.rootRef !== ref.rootRef ||
        seen.coveredFromInclusive !== ref.coveredFromInclusive ||
        seen.coveredToExclusive !== ref.coveredToExclusive)
    ) {
      return refuse(
        "coverage_denied",
        `Trusted manifest chunk '${ref.chunkRef}' repeats with differing hash, root, or range.`,
      );
    }
    manifestByChunk.set(ref.chunkRef, ref);
  }
  for (const claimed of report.sourceRefs) {
    const known = manifestByChunk.get(claimed.chunkRef);
    if (known === undefined) {
      return refuse(
        "unknown_source_ref",
        `Claimed source ref '${claimed.chunkRef}' is not in the trusted manifest.`,
      );
    }
    if (
      claimed.rootRef !== expected.sourceRoot ||
      claimed.chunkHash !== known.chunkHash ||
      claimed.coveredFromInclusive < known.coveredFromInclusive ||
      claimed.coveredToExclusive > known.coveredToExclusive ||
      claimed.coveredFromInclusive >= claimed.coveredToExclusive
    ) {
      return refuse(
        "out_of_bounds",
        `Claimed source ref '${claimed.chunkRef}' falls outside its trusted manifest bound.`,
      );
    }
  }

  // Trusted manifest and receipt refs must sit inside the captured range
  // under the expected root; anything else denies rather than faking coverage.
  const withinCaptured = (ref: MissionRetroSourceRefValue): boolean =>
    ref.rootRef === expected.sourceRoot &&
    ref.coveredFromInclusive >= expected.fromInclusive &&
    ref.coveredToExclusive <= expected.toExclusive &&
    ref.coveredFromInclusive < ref.coveredToExclusive;
  for (const ref of trusted.manifestSourceRefs) {
    if (!withinCaptured(ref)) {
      return refuse(
        "coverage_denied",
        `Trusted manifest ref '${ref.chunkRef}' falls outside the captured range.`,
      );
    }
  }
  for (const receipt of trusted.readReceipts) {
    if (!withinCaptured(receipt)) {
      return refuse(
        "coverage_denied",
        `Trusted read receipt '${receipt.chunkRef}' falls outside the captured range.`,
      );
    }
    const known = manifestByChunk.get(receipt.chunkRef);
    if (
      known === undefined ||
      known.chunkHash !== receipt.chunkHash ||
      known.rootRef !== receipt.rootRef ||
      receipt.coveredFromInclusive < known.coveredFromInclusive ||
      receipt.coveredToExclusive > known.coveredToExclusive
    ) {
      return refuse(
        "coverage_denied",
        `Trusted read receipt '${receipt.chunkRef}' does not match a known manifest chunk.`,
      );
    }
  }

  // Evidence index: normalized duplicates dedup (never counted as
  // recurrence); conflicting incident ids are denied. The shortlist keeps
  // its own entries while every distinct incident stays indexed.
  // ID association is validated for every incident BEFORE any dedup, and
  // every alias id is registered, so a reused id can never hide behind an
  // already-seen normalized key.
  const idToKey = new Map<string, string>();
  for (const incident of report.incidents) {
    const key = incidentKeyFor(incident);
    const seen = idToKey.get(incident.incidentId);
    if (seen !== undefined && seen !== key) {
      return refuse(
        "conflicting_incidents",
        `Incident id '${incident.incidentId}' carries conflicting normalized references.`,
      );
    }
    idToKey.set(incident.incidentId, key);
  }
  const keptIncidents: Array<MissionRetroReportIncidentValue> = [];
  const keptByKey = new Map<string, MissionRetroReportIncidentValue>();
  const remappedId = new Map<string, string>();
  for (const incident of report.incidents) {
    const key = incidentKeyFor(incident);
    const seenKey = keptByKey.get(key);
    if (seenKey !== undefined) {
      if (
        seenKey.summary !== incident.summary ||
        seenKey.destinationOwner !== incident.destinationOwner
      ) {
        return refuse(
          "conflicting_incidents",
          `Incident id '${incident.incidentId}' changes content under a seen normalized key.`,
        );
      }
      remappedId.set(incident.incidentId, seenKey.incidentId);
      continue;
    }
    keptByKey.set(key, incident);
    keptIncidents.push(incident);
  }
  const resolveIncidentId = (id: string): string => remappedId.get(id) ?? id;
  const indexedIds = new Set(keptIncidents.map((incident) => incident.incidentId));
  const dedupedShortlist: Array<MissionRetroReportCandidateValue> = [];
  const seenCandidateIds = new Map<string, MissionRetroReportCandidateValue>();
  for (const candidate of report.shortlist) {
    const resolvedRefs = candidate.incidentRefs.map(resolveIncidentId);
    for (const ref of resolvedRefs) {
      if (!indexedIds.has(ref)) {
        return refuse(
          "invalid_shortlist_ref",
          `Shortlist candidate '${candidate.candidateId}' links an unknown incident '${ref}'.`,
        );
      }
    }
    const dedupedRefs = [...new Set(resolvedRefs)];
    const normalized = { ...candidate, incidentRefs: dedupedRefs };
    const seen = seenCandidateIds.get(candidate.candidateId);
    if (seen !== undefined) {
      const sameCandidate =
        seen.concernId === normalized.concernId &&
        seen.summary === normalized.summary &&
        seen.destinationOwner === normalized.destinationOwner &&
        seen.alreadyFixed === normalized.alreadyFixed &&
        seen.incidentRefs.length === normalized.incidentRefs.length &&
        seen.incidentRefs.every((ref, i) => ref === normalized.incidentRefs[i]);
      if (!sameCandidate) {
        return refuse(
          "conflicting_incidents",
          `Shortlist candidate id '${candidate.candidateId}' carries conflicting content.`,
        );
      }
      continue;
    }
    seenCandidateIds.set(candidate.candidateId, normalized);
    dedupedShortlist.push(normalized);
  }

  // Each dimension needs its own trusted receipt. Resolving a path/hash
  // proves neither native invocation nor application or behavioral effect.
  const skillLoads = trusted.trustedSkillLoads ?? [];
  if (skillLoads.length > 64) {
    return refuse("skill_evidence_invalid", "Trusted skill receipt bound exceeded.");
  }
  const skills = report.skillEvidence.map((entry) => {
    const matching = skillLoads.filter((receipt) =>
      receipt.skillPath === entry.skillPath && receipt.observedRevision === entry.observedRevision);
    return {
      ...entry,
      discovery: matching.some((receipt) => receipt.discovery === entry.discovery) ? entry.discovery : "unknown" as const,
      invocation: matching.some((receipt) => receipt.invocation === entry.invocation) ? entry.invocation : "unknown" as const,
      application: matching.some((receipt) => receipt.application === entry.application) ? entry.application : "unknown" as const,
      outcome: matching.some((receipt) => receipt.outcome === entry.outcome && receipt.outcomeRef === entry.outcomeRef) ? entry.outcome : "unknown" as const,
    };
  });

  const validated: MissionRetroReportValue = {
    ...report,
    shortlist: dedupedShortlist,
    incidents: keptIncidents,
    skillEvidence: [...skills],
  };

  // Trusted coverage: full only with receipts for EVERY required immutable
  // chunk (overlaps merge, gaps stay unknown), full API/child/raw-stdout
  // dimensions, no omissions, and no pending children. Worker-claimed read
  // refs can never manufacture full coverage. Coverage is computed here
  // from trusted receipts alone.
  const reasons: Array<string> = [];
  // A non-empty captured interval needs an actual manifest; empty is never full.
  if (trusted.manifestSourceRefs.length === 0) {
    reasons.push("no trusted manifest coverage for a non-empty captured interval");
  }
  // Union coverage across every required manifest interval (overlaps
  // allowed) must prove the ENTIRE captured range, gaps included.
  {
    const spans = trusted.readReceipts
      .map((receipt) => [receipt.coveredFromInclusive, receipt.coveredToExclusive] as const)
      .sort((a, b) => a[0] - b[0]);
    let cursor = expected.fromInclusive;
    for (const [from, to] of spans) {
      if (from > cursor) break;
      if (to > cursor) cursor = to;
    }
    if (cursor < expected.toExclusive) {
      reasons.push("trusted read coverage does not span the entire captured range");
    }
  }
  for (const required of trusted.manifestSourceRefs) {
    const spans = trusted.readReceipts
      .filter(
        (receipt) =>
          receipt.chunkRef === required.chunkRef && receipt.chunkHash === required.chunkHash,
      )
      .map(
        (receipt) =>
          [receipt.coveredFromInclusive, receipt.coveredToExclusive] as const,
      )
      .sort((a, b) => a[0] - b[0]);
    let cursor = required.coveredFromInclusive;
    for (const [from, to] of spans) {
      if (from > cursor) break;
      if (to > cursor) cursor = to;
    }
    if (cursor < required.coveredToExclusive) {
      reasons.push(`missing trusted read coverage for chunk '${required.chunkRef}'`);
    }
  }
  if (trusted.apiCoverage !== "full") reasons.push(`api coverage is ${trusted.apiCoverage}`);
  if (trusted.childLogCoverage !== "full")
    reasons.push(`child log coverage is ${trusted.childLogCoverage}`);
  if (trusted.rawStdoutCoverage !== "full")
    reasons.push(`raw stdout coverage is ${trusted.rawStdoutCoverage}`);
  if (report.omissions.length > 0) reasons.push("explicit worker omissions declared");
  if (trusted.pendingChildRuns) reasons.push("child runs still pending");
  const fullyCovered = reasons.length === 0;

  // Partial trusted coverage always yields partial_coverage, even when the
  // worker claims no_change or candidates; zero findings never imply
  // clean. A fully covered zero-findings report is no_change; a fully
  // covered report with a shortlist or indexed incidents is candidates.
  const hasFindings = dedupedShortlist.length > 0 || keptIncidents.length > 0;
  const verdict: RetroReportVerdict =
    fullyCovered && report.omissions.length === 0 && report.verdict !== "partial_coverage"
      ? hasFindings
        ? "candidates"
        : "no_change"
      : "partial_coverage";
  const coverage: MissionRetroReportCoverage = { full: fullyCovered, reasons };
  if (!fullyCovered || report.omissions.length > 0 || report.verdict === "partial_coverage") {
    return decide(
      validated,
      "held_partial",
      verdict,
      coverage,
      fullyCovered
        ? "Held: the report stays partial despite full trusted coverage."
        : `Held: trusted coverage is partial (${reasons.length} reason${reasons.length === 1 ? "" : "s"}).`,
      actualHash,
    );
  }
  return decide(
    validated,
    "queued_for_triage",
    verdict,
    coverage,
    verdict === "no_change"
      ? "Accepted: fully covered with zero findings; queued for root/manager triage."
      : "Accepted: fully covered with candidates; queued for root/manager triage.",
    actualHash,
  );
};

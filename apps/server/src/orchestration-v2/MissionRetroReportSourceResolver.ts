// @effect-diagnostics nodeBuiltinImport:off -- content hashes bind immutable source evidence.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { Mission } from "../../../../packages/contracts/src/mission.ts";
import { MissionRetroCheckpoint } from "../../../../packages/contracts/src/missionRetro.ts";
import { MissionRetroReport } from "../../../../packages/contracts/src/missionRetroReport.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { MissionAuthority } from "./MissionService.ts";
import * as Artifacts from "./MissionRetroReportArtifacts.ts";
import { MissionRetroReportStoreError } from "./MissionRetroReportStore.ts";

/**
 * Real canonical checkpoint/immutable source metadata resolver for the
 * existing `ReportArtifacts -> ReportStore` ingestion path.
 *
 * This factory implements the EXISTING `MissionRetroReportTrustedResolver`
 * over the SAME ambient `SqlClient` and the SAME trusted `MissionAuthority`
 * as `ReportStore`, with the private `artifactDirectory` supplied by root
 * configuration (absolute `0700`, no default). The existing root owns
 * composition: this module performs no registration, default configuration,
 * or activation, and never runs inside a worker.
 *
 * Conservatively returns NO trusted read receipts: `readReceipts` and
 * `trustedSkillLoads` are always empty, so ingested reports stay partial
 * until a root-observed transport ACK exists elsewhere. Prepared
 * `retro-source-read` refs carried in worker report claims are never read,
 * promoted, or treated as trusted.
 *
 * Every denial is one fixed bounded `scope_denied` store error with no
 * cause, SQL, path, or body attached. Authority, config, and command checks
 * run before any SQL; canonical SQL reads run before any filesystem read;
 * and the canonical snapshot is reauthorized after external filesystem work
 * before anything is returned.
 */

export interface MissionRetroReportSourceResolverConfig {
  readonly artifactDirectory: string;
}

const COVERAGE_POLICY = "explicit-activity-window-v1";
const SOURCE_NOTE_PREFIX = "source-manifest:";
const BINDING_NOTE_PREFIX = "source-binding:";
const MAX_SOURCE_BYTES = 2_097_152;
const SHA_HEX = /^[0-9a-f]{64}$/;

const deny = (): MissionRetroReportStoreError =>
  new MissionRetroReportStoreError({ operation: "receive", category: "scope_denied" });

const sha256Hex = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1024;

const isSafeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

const hasExactKeys = (record: Record<string, unknown>, keys: ReadonlyArray<string>): boolean => {
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
};

const isNullableString = (value: unknown): boolean =>
  value === null || (typeof value === "string" && value.length <= 200_000);

const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));
const decodeCheckpoint = Schema.decodeUnknownEffect(MissionRetroCheckpoint);
const decodeCheckpointJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(MissionRetroCheckpoint),
);
const decodeJsonUnknown = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const isStoreError = Schema.is(MissionRetroReportStoreError);
const decodeReport = Schema.decodeUnknownEffect(MissionRetroReport, {
  onExcessProperty: "error",
});

interface CanonicalSnapshot {
  readonly revision: number;
  readonly retroThreadId: string;
  readonly retroEpoch: number;
  readonly checkpointJson: string;
  readonly analysisJson: string;
}

interface ValidChunk {
  readonly chunkRef: string;
  readonly chunkHash: string;
  readonly threadId: string;
  readonly coveredFromInclusive: number;
  readonly coveredToExclusive: number;
}

interface ValidManifest {
  readonly scope: {
    readonly teamId: string;
    readonly environmentId: string;
    readonly missionId: string;
    readonly captureBoundaryId: string;
    readonly sourceRoot: string;
    readonly sourceThreadId: string;
    readonly fromInclusive: number;
    readonly toExclusive: number;
  };
  readonly captureBoundaryId: string;
  readonly threadsRead: ReadonlyArray<string>;
  readonly chunks: ReadonlyArray<ValidChunk>;
  readonly omissions: ReadonlyArray<string>;
  readonly uncoveredRanges: ReadonlyArray<{ readonly fromInclusive: number; readonly toExclusive: number }>;
  readonly apiCoverage: "full" | "partial" | "unknown";
  readonly pendingChildRuns: boolean;
  readonly pendingChildRunsKnown: boolean;
  readonly artifactSha256: string;
}

const make = (configuration: MissionRetroReportSourceResolverConfig) =>
  Effect.gen(function* () {
    // Optional authority with no default success: a missing authority denies
    // every resolution instead of manufacturing metadata. The SQL client is
    // the ambient one shared with ReportStore, never a new connection.
    const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
    const originalAuthority = yield* Effect.serviceOption(MissionAuthority);
    const authorityOption = Option.map(originalAuthority, (authority) => Object.freeze({
      teamId: authority.teamId,
      environmentId: authority.environmentId,
      controllerThreadId: authority.controllerThreadId,
    }));
    const artifactDirectory = configuration?.artifactDirectory;

    const readCanonical = Effect.fn("MissionRetroReportSourceResolver.readCanonical")(
      function* (command: {
        readonly missionId: string;
        readonly checkpointId: string;
        readonly expectedRevision: number;
        readonly retroEpoch: number;
      }): Effect.fn.Return<CanonicalSnapshot, MissionRetroReportStoreError> {
        if (Option.isNone(sqlOption) || Option.isNone(authorityOption)) return yield* deny();
        const sql = sqlOption.value;
        const authority = authorityOption.value;
        const snapshot = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql<{
                mission_id: string;
                revision: number;
                snapshot_json: string;
              }>`SELECT mission_id, revision, snapshot_json FROM projection_missions WHERE mission_id = ${command.missionId} AND team_id = ${authority.teamId} AND authority_environment_id = ${authority.environmentId}`;
              if (rows[0] === undefined) return yield* deny();
              const mission = yield* decodeMission(rows[0].snapshot_json).pipe(
                Effect.mapError(() => deny()),
              );
              if (
                mission.id !== rows[0].mission_id ||
                mission.revision !== rows[0].revision ||
                mission.teamId !== authority.teamId ||
                mission.authorityEnvironmentId !== authority.environmentId ||
                mission.id !== command.missionId ||
                command.expectedRevision !== mission.revision
              )
                return yield* deny();
              const retro = mission.managers.retro;
              if (
                retro?.threadId !== authority.controllerThreadId ||
                retro.epoch !== command.retroEpoch
              )
                return yield* deny();
              const checkpoint = (mission.execution?.retroCheckpoints ?? []).find(
                (entry) => entry.checkpointId === command.checkpointId,
              );
              if (checkpoint === undefined) return yield* deny();
              const decodedCheckpoint = yield* decodeCheckpoint(checkpoint).pipe(
                Effect.mapError(() => deny()),
              );
              if (
                decodedCheckpoint.teamId !== authority.teamId ||
                decodedCheckpoint.environmentId !== authority.environmentId ||
                decodedCheckpoint.missionId !== mission.id ||
                decodedCheckpoint.checkpointId !== command.checkpointId
              )
                return yield* deny();
              const analysis = (mission.execution?.retroAnalyses ?? []).find(
                (record) => record.checkpointId === command.checkpointId,
              );
              if (analysis === undefined) return yield* deny();
              if (
                analysis.checkpointId !== decodedCheckpoint.checkpointId ||
                analysis.teamId !== decodedCheckpoint.teamId ||
                analysis.environmentId !== decodedCheckpoint.environmentId ||
                analysis.missionId !== decodedCheckpoint.missionId ||
                analysis.sourceThreadId !== decodedCheckpoint.sourceThreadId ||
                analysis.sourceRoot !== decodedCheckpoint.sourceRoot ||
                analysis.snapshotFingerprint !== decodedCheckpoint.snapshotFingerprint ||
                analysis.coveredFromInclusive !== decodedCheckpoint.coveredFromInclusive ||
                analysis.coveredToExclusive !== decodedCheckpoint.coveredToExclusive ||
                analysis.managerThreadId !== authority.controllerThreadId ||
                analysis.managerEpoch !== command.retroEpoch ||
                analysis.status !== "reserved" ||
                analysis.lease === null ||
                analysis.settlement !== null
              )
                return yield* deny();
              // Current delivery assignment is NOT snapshotted: retained
              // checkpoints stay valid across a legitimate delivery handoff.
              // The binding's historic delivery proof is validated against
              // the immutable checkpoint scope below, never against the
              // current delivery thread/epoch. Current retro manager,
              // epoch, and the full analysis identity (fence/attempt/
              // manager/lease/settlement) still guard every read.
              return {
                revision: mission.revision,
                retroThreadId: authority.controllerThreadId,
                retroEpoch: command.retroEpoch,
                checkpointJson: stableStringify(decodedCheckpoint),
                analysisJson: stableStringify(analysis),
              } satisfies CanonicalSnapshot;
            }),
          )
          .pipe(Effect.mapError((cause) => (isStoreError(cause) ? cause : deny())));
        return snapshot;
      },
    );

    const resolve = Effect.fn("MissionRetroReportSourceResolver.resolve")(function* (
      raw: Artifacts.MissionRetroReportResolverInput,
    ): Effect.fn.Return<
      Artifacts.MissionRetroReportTrustedMetadata,
      MissionRetroReportStoreError
    > {
      if (
        typeof artifactDirectory !== "string" ||
        !NodePath.isAbsolute(artifactDirectory) ||
        Option.isNone(sqlOption) ||
        Option.isNone(authorityOption)
      )
        return yield* deny();
      const authority = authorityOption.value;
      // Detach the caller command, SHA, and parsed report before any I/O;
      // the report object supplies no trusted fact below.
      const command = yield* Effect.try({
        try: () => structuredClone(raw.command),
        catch: () => deny(),
      });
      const originalSha = raw.originalSha;
      const report = yield* Effect.try({
        try: () => structuredClone(raw.report),
        catch: () => deny(),
      });
      if (
        typeof originalSha !== "string" ||
        !SHA_HEX.test(originalSha) ||
        originalSha !== command.originalArtifactSha ||
        Artifacts.parseArtifactRef(command.originalArtifactRef, "retro-original") !==
          originalSha
      )
        return yield* deny();
      // Strictly decoded, but claimed scope/origin/coverage/read/skill facts
      // are never trusted: every such fact is re-derived from immutable notes.
      yield* decodeReport(report).pipe(Effect.mapError(() => deny()));
      const before = yield* readCanonical(command);
      const checkpoint = yield* Effect.try({
        try: () => decodeCheckpointJson(before.checkpointJson),
        catch: () => deny(),
      });
      const manifestNotes = checkpoint.omissions.filter((note) =>
        note.startsWith(SOURCE_NOTE_PREFIX),
      );
      const bindingNotes = checkpoint.omissions.filter((note) =>
        note.startsWith(BINDING_NOTE_PREFIX),
      );
      if (manifestNotes.length !== 1 || bindingNotes.length !== 1) return yield* deny();
      const manifestRef = manifestNotes[0]!.slice(SOURCE_NOTE_PREFIX.length);
      const bindingRef = bindingNotes[0]!.slice(BINDING_NOTE_PREFIX.length);
      const manifestHash = Artifacts.parseArtifactRef(manifestRef, "retro-source");
      const bindingHash = Artifacts.parseArtifactRef(bindingRef, "retro-source");
      if (manifestHash === null || bindingHash === null) return yield* deny();
      // External filesystem reads stay outside the owning SQL transaction.
      const manifestStored = yield* Artifacts.readArtifactBytes({
        artifactDirectory,
        namespace: "retro-source",
        ref: manifestRef,
        maxBytes: MAX_SOURCE_BYTES,
      }).pipe(Effect.mapError(() => deny()));
      const bindingStored = yield* Artifacts.readArtifactBytes({
        artifactDirectory,
        namespace: "retro-source",
        ref: bindingRef,
        maxBytes: MAX_SOURCE_BYTES,
      }).pipe(Effect.mapError(() => deny()));
      if (manifestStored.sha !== manifestHash || bindingStored.sha !== bindingHash)
        return yield* deny();
      const manifest = parseManifest(manifestStored.text);
      const binding = parseBinding(bindingStored.text);
      if (manifest === null || binding === null) return yield* deny();
      // Binding version 2 strictly matches the canonical checkpoint, source
      // scope, and manifest ref. Legacy version 1 lacks origin proof and is
      // denied here, never upgraded by guessing from paths or labels.
      if (
        binding.version !== 2 ||
        binding.actualOrigin !== "product" ||
        binding.captureBoundaryId !== manifest.captureBoundaryId ||
        binding.checkpointId !== checkpoint.checkpointId ||
        binding.snapshotFingerprint !== checkpoint.snapshotFingerprint ||
        binding.manifestRef !== manifestRef ||
        binding.teamId !== checkpoint.teamId ||
        binding.environmentId !== checkpoint.environmentId ||
        binding.missionId !== checkpoint.missionId ||
        binding.sourceThreadId !== checkpoint.sourceThreadId ||
        binding.sourceRoot !== checkpoint.sourceRoot ||
        binding.fromInclusive !== checkpoint.coveredFromInclusive ||
        binding.toExclusive !== checkpoint.coveredToExclusive ||
        // Historic original-capture proof only: the original authorized
        // delivery controller is the capture root itself (Capture requires
        // sourceThreadId === caller delivery thread and derives sourceRoot
        // from it), with a positive original epoch. Never compared to the
        // CURRENT delivery assignment, which may have handed off since.
        binding.deliveryThreadId !== checkpoint.sourceThreadId ||
        binding.sourceRoot !== `thread://${encodeURIComponent(binding.deliveryThreadId)}` ||
        !isSafeInt(binding.deliveryEpoch) ||
        (binding.deliveryEpoch as number) <= 0
      )
        return yield* deny();
      if (
        manifest.scope.teamId !== checkpoint.teamId ||
        manifest.scope.environmentId !== checkpoint.environmentId ||
        manifest.scope.missionId !== checkpoint.missionId ||
        manifest.scope.captureBoundaryId !== manifest.captureBoundaryId ||
        manifest.scope.sourceRoot !== checkpoint.sourceRoot ||
        manifest.scope.sourceThreadId !== checkpoint.sourceThreadId ||
        manifest.scope.fromInclusive !== checkpoint.coveredFromInclusive ||
        manifest.scope.toExclusive !== checkpoint.coveredToExclusive
      )
        return yield* deny();
      if (!threadsReadPrimary(manifest.threadsRead, checkpoint.sourceThreadId)) return yield* deny();
      if (!chunksMatchCanonical(manifest.chunks, checkpoint.sourceRefs, checkpoint.sourceRoot))
        return yield* deny();
      if (manifest.artifactSha256 !== manifestHash) return yield* deny();
      const preimage = stableStringify({
        version: 1,
        coveragePolicy: COVERAGE_POLICY,
        teamId: manifest.scope.teamId,
        environmentId: manifest.scope.environmentId,
        missionId: manifest.scope.missionId,
        captureBoundaryId: manifest.captureBoundaryId,
        sourceRoot: manifest.scope.sourceRoot,
        sourceThreadId: manifest.scope.sourceThreadId,
        fromInclusive: manifest.scope.fromInclusive,
        toExclusive: manifest.scope.toExclusive,
        threadsRead: [...manifest.threadsRead].sort(),
        chunkHashes: manifest.chunks.map((chunk) => chunk.chunkHash),
        artifactSha256: manifest.artifactSha256,
      });
      if (
        sha256Hex(preimage) !== checkpoint.snapshotFingerprint ||
        binding.snapshotFingerprint !== checkpoint.snapshotFingerprint
      )
        return yield* deny();
      // Reauthorize after external reads: any role or canonical mutation
      // observed across the producer boundary denies instead of returning
      // metadata mixed from two states.
      const after = yield* readCanonical(command);
      if (stableStringify(after) !== stableStringify(before)) return yield* deny();
      const tiling = exactTiling(
        manifest.chunks,
        checkpoint.coveredFromInclusive,
        checkpoint.coveredToExclusive,
      );
      const apiCoverage =
        manifest.apiCoverage === "full" &&
        manifest.omissions.length === 0 &&
        manifest.uncoveredRanges.length === 0 &&
        tiling
          ? ("full" as const)
          : manifest.apiCoverage === "unknown"
            ? ("unknown" as const)
            : ("partial" as const);
      return {
        teamId: checkpoint.teamId,
        environmentId: checkpoint.environmentId,
        missionId: checkpoint.missionId,
        checkpointId: checkpoint.checkpointId,
        retroThreadId: authority.controllerThreadId,
        retroEpoch: command.retroEpoch,
        sourceThreadId: checkpoint.sourceThreadId,
        sourceRoot: checkpoint.sourceRoot,
        snapshotFingerprint: checkpoint.snapshotFingerprint,
        coveredFromInclusive: checkpoint.coveredFromInclusive,
        coveredToExclusive: checkpoint.coveredToExclusive,
        actualOrigin: "product",
        coverage: {
          manifestSourceRefs: checkpoint.sourceRefs.map((ref) => ({ ...ref })),
          readReceipts: [],
          apiCoverage,
          childLogCoverage: "unknown",
          rawStdoutCoverage: "unknown",
          pendingChildRuns:
            manifest.pendingChildRuns ||
            !manifest.pendingChildRunsKnown ||
            checkpoint.omissions.includes("pending-child-runs"),
          trustedSkillLoads: [],
        },
      };
    });

    return Artifacts.MissionRetroReportTrustedResolver.of({ resolve });
  });

/** Actual manifest bytes decoded and validated; null on any shape, hash, or range defect. */
const parseManifest = (text: string): ValidManifest | null => {
  let parsed: unknown;
  try {
    parsed = decodeJsonUnknown(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (
    !hasExactKeys(parsed, [
      "version",
      "coveragePolicy",
      "scope",
      "threadsRead",
      "chunks",
      "omissions",
      "uncoveredRanges",
      "coverage",
    ])
  )
    return null;
  if (parsed["version"] !== 1 || parsed["coveragePolicy"] !== COVERAGE_POLICY) return null;
  const scope = parsed["scope"];
  if (!isRecord(scope)) return null;
  if (
    !hasExactKeys(scope, [
      "teamId",
      "environmentId",
      "missionId",
      "captureBoundaryId",
      "sourceRoot",
      "sourceThreadId",
      "fromInclusive",
      "toExclusive",
    ])
  )
    return null;
  if (
    !isNonEmptyString(scope["teamId"]) ||
    !isNonEmptyString(scope["environmentId"]) ||
    !isNonEmptyString(scope["missionId"]) ||
    !isNonEmptyString(scope["captureBoundaryId"]) ||
    !isNonEmptyString(scope["sourceRoot"]) ||
    !isNonEmptyString(scope["sourceThreadId"]) ||
    !isSafeInt(scope["fromInclusive"]) ||
    !isSafeInt(scope["toExclusive"]) ||
    (scope["fromInclusive"] as number) < 0 ||
    !((scope["fromInclusive"] as number) < (scope["toExclusive"] as number))
  )
    return null;
  const scopeFrom = scope["fromInclusive"] as number;
  const scopeTo = scope["toExclusive"] as number;
  const scopeSource = scope["sourceThreadId"] as string;
  const rawThreads = parsed["threadsRead"];
  // A genuine partial capture (all items omitted, first page out of window)
  // may legitimately read no thread and export zero chunks; never full.
  if (!Array.isArray(rawThreads) || rawThreads.length > 16) return null;
  const threadsRead: Array<string> = [];
  for (const entry of rawThreads) {
    if (!isNonEmptyString(entry) || entry !== scopeSource) return null;
    if (threadsRead.includes(entry)) return null;
    threadsRead.push(entry);
  }
  const rawChunks = parsed["chunks"];
  if (!Array.isArray(rawChunks) || rawChunks.length > 16) return null;
  const chunks: Array<ValidChunk & { readonly items: unknown }> = [];
  for (const entry of rawChunks) {
    if (!isRecord(entry)) return null;
    if (
      !hasExactKeys(entry, [
        "chunkRef",
        "chunkHash",
        "threadId",
        "coveredFromInclusive",
        "coveredToExclusive",
        "items",
      ])
    )
      return null;
    const chunkRef = entry["chunkRef"];
    const chunkHash = entry["chunkHash"];
    const threadId = entry["threadId"];
    const from = entry["coveredFromInclusive"];
    const to = entry["coveredToExclusive"];
    const items = entry["items"];
    if (
      typeof chunkRef !== "string" ||
      typeof chunkHash !== "string" ||
      !SHA_HEX.test(chunkHash) ||
      chunkRef !== `retro-source-chunk:${chunkHash}` ||
      !isNonEmptyString(threadId) ||
      threadId !== scopeSource ||
      !isSafeInt(from) ||
      !isSafeInt(to) ||
      !(from < to) ||
      from < scopeFrom ||
      to > scopeTo ||
      !Array.isArray(items) ||
      items.length === 0 ||
      items.length > 1000
    )
      return null;
    // Recompute the full chunk SHA over the exact collector payload; the ref
    // must equal that hash, never a transplanted one.
    const recomputed = sha256Hex(
      stableStringify({
        threadId,
        coveredFromInclusive: from,
        coveredToExclusive: to,
        items,
      }),
    );
    if (recomputed !== chunkHash) return null;
    // Actual collector chunk format: exact SanitizedEntry keys, contiguous
    // positions tiling [from, to) with no gaps, every entry on the chunk thread.
    for (let index = 0; index < items.length; index++) {
      const item: unknown = items[index];
      if (!isRecord(item)) return null;
      if (
        !hasExactKeys(item, [
          "threadId",
          "position",
          "itemId",
          "sourceThreadId",
          "runId",
          "messageId",
          "type",
          "status",
          "visibility",
          "title",
          "text",
          "createdBy",
          "creationSource",
          "updatedAt",
        ])
      )
        return null;
      if (
        item["threadId"] !== threadId ||
        item["position"] !== from + index ||
        !isNonEmptyString(item["itemId"]) ||
        item["sourceThreadId"] !== scopeSource ||
        !isNullableString(item["runId"]) ||
        !isNullableString(item["messageId"]) ||
        !isNonEmptyString(item["type"]) ||
        !isNonEmptyString(item["status"]) ||
        !isNonEmptyString(item["visibility"]) ||
        !isNullableString(item["title"]) ||
        !isNullableString(item["text"]) ||
        !isNullableString(item["createdBy"]) ||
        !isNullableString(item["creationSource"]) ||
        !isNonEmptyString(item["updatedAt"])
      )
        return null;
    }
    if (items.length !== to - from) return null;
    chunks.push({
      chunkRef,
      chunkHash,
      threadId,
      coveredFromInclusive: from,
      coveredToExclusive: to,
      items,
    });
  }
  // Any duplicate chunk ref, and any overlapping range, denies instead of
  // coalescing into false coverage.
  const seen = new Set<string>();
  for (const chunk of chunks) {
    if (seen.has(chunk.chunkRef)) return null;
    seen.add(chunk.chunkRef);
  }
  const ordered = [...chunks].sort((a, b) => a.coveredFromInclusive - b.coveredFromInclusive);
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index]!.coveredFromInclusive < ordered[index - 1]!.coveredToExclusive) return null;
  }
  const rawOmissions = parsed["omissions"];
  if (!Array.isArray(rawOmissions) || rawOmissions.length > 16) return null;
  const omissions: Array<string> = [];
  for (const note of rawOmissions) {
    if (typeof note !== "string" || note.length > 512) return null;
    omissions.push(note);
  }
  const rawUncovered = parsed["uncoveredRanges"];
  if (!Array.isArray(rawUncovered) || rawUncovered.length > 32) return null;
  const uncoveredRanges: Array<{ readonly fromInclusive: number; readonly toExclusive: number }> =
    [];
  for (const range of rawUncovered) {
    if (!isRecord(range)) return null;
    if (!hasExactKeys(range, ["fromInclusive", "toExclusive"])) return null;
    const from = range["fromInclusive"];
    const to = range["toExclusive"];
    if (!isSafeInt(from) || !isSafeInt(to) || !(from < to) || from < scopeFrom || to > scopeTo)
      return null;
    uncoveredRanges.push({ fromInclusive: from, toExclusive: to });
  }
  const orderedUncovered = [...uncoveredRanges].sort((a, b) => a.fromInclusive - b.fromInclusive);
  for (let index = 1; index < orderedUncovered.length; index++) {
    if (orderedUncovered[index]!.fromInclusive < orderedUncovered[index - 1]!.toExclusive)
      return null;
  }
  const coverage = parsed["coverage"];
  if (!isRecord(coverage)) return null;
  if (
    !hasExactKeys(coverage, [
      "apiCoverage",
      "childLogCoverage",
      "rawStdoutCoverage",
      "pendingChildRuns",
      "pendingChildRunsKnown",
    ])
  )
    return null;
  const apiCoverage = coverage["apiCoverage"];
  if (apiCoverage !== "full" && apiCoverage !== "partial" && apiCoverage !== "unknown")
    return null;
  // Producer states stay unknown: forged full child/raw-stdout coverage denies.
  if (coverage["childLogCoverage"] !== "unknown" || coverage["rawStdoutCoverage"] !== "unknown")
    return null;
  if (typeof coverage["pendingChildRuns"] !== "boolean") return null;
  if (typeof coverage["pendingChildRunsKnown"] !== "boolean") return null;
  return {
    scope: {
      teamId: scope["teamId"] as string,
      environmentId: scope["environmentId"] as string,
      missionId: scope["missionId"] as string,
      captureBoundaryId: scope["captureBoundaryId"] as string,
      sourceRoot: scope["sourceRoot"] as string,
      sourceThreadId: scope["sourceThreadId"] as string,
      fromInclusive: scope["fromInclusive"] as number,
      toExclusive: scope["toExclusive"] as number,
    },
    captureBoundaryId: scope["captureBoundaryId"] as string,
    threadsRead,
    chunks: chunks.map(({ items: _items, ...chunk }) => chunk),
    omissions,
    uncoveredRanges,
    apiCoverage,
    pendingChildRuns: coverage["pendingChildRuns"] as boolean,
    pendingChildRunsKnown: coverage["pendingChildRunsKnown"] as boolean,
    artifactSha256: sha256Hex(text),
  };
};

interface ValidBinding {
  readonly version: number;
  readonly captureBoundaryId: string;
  readonly checkpointId: string;
  readonly snapshotFingerprint: string;
  readonly manifestRef: string;
  readonly actualOrigin: string;
  readonly teamId: string;
  readonly environmentId: string;
  readonly missionId: string;
  readonly sourceThreadId: string;
  readonly sourceRoot: string;
  readonly fromInclusive: number;
  readonly toExclusive: number;
  readonly deliveryThreadId: string;
  readonly deliveryEpoch: number;
}

const BINDING_KEYS = [
  "version",
  "captureBoundaryId",
  "checkpointId",
  "snapshotFingerprint",
  "manifestRef",
  "actualOrigin",
  "teamId",
  "environmentId",
  "missionId",
  "sourceThreadId",
  "sourceRoot",
  "fromInclusive",
  "toExclusive",
  "deliveryThreadId",
  "deliveryEpoch",
] as const;

/** Private binding bytes strictly decoded; null on any shape defect. */
const parseBinding = (text: string): ValidBinding | null => {
  let parsed: unknown;
  try {
    parsed = decodeJsonUnknown(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, [...BINDING_KEYS])) return null;
  if (
    parsed["version"] !== 2 ||
    !isNonEmptyString(parsed["captureBoundaryId"]) ||
    !isNonEmptyString(parsed["checkpointId"]) ||
    typeof parsed["snapshotFingerprint"] !== "string" ||
    !SHA_HEX.test(parsed["snapshotFingerprint"]) ||
    typeof parsed["manifestRef"] !== "string" ||
    Artifacts.parseArtifactRef(parsed["manifestRef"], "retro-source") === null ||
    !isNonEmptyString(parsed["actualOrigin"]) ||
    !isNonEmptyString(parsed["teamId"]) ||
    !isNonEmptyString(parsed["environmentId"]) ||
    !isNonEmptyString(parsed["missionId"]) ||
    !isNonEmptyString(parsed["sourceThreadId"]) ||
    !isNonEmptyString(parsed["sourceRoot"]) ||
    !isSafeInt(parsed["fromInclusive"]) ||
    !isSafeInt(parsed["toExclusive"]) ||
    !((parsed["fromInclusive"] as number) < (parsed["toExclusive"] as number)) ||
    !isNonEmptyString(parsed["deliveryThreadId"]) ||
    !isSafeInt(parsed["deliveryEpoch"])
  )
    return null;
  return {
    version: 2,
    captureBoundaryId: parsed["captureBoundaryId"],
    checkpointId: parsed["checkpointId"],
    snapshotFingerprint: parsed["snapshotFingerprint"],
    manifestRef: parsed["manifestRef"],
    actualOrigin: parsed["actualOrigin"],
    teamId: parsed["teamId"],
    environmentId: parsed["environmentId"],
    missionId: parsed["missionId"],
    sourceThreadId: parsed["sourceThreadId"],
    sourceRoot: parsed["sourceRoot"],
    fromInclusive: parsed["fromInclusive"],
    toExclusive: parsed["toExclusive"],
    deliveryThreadId: parsed["deliveryThreadId"],
    deliveryEpoch: parsed["deliveryEpoch"],
  };
};

const threadsReadPrimary = (
  threadsRead: ReadonlyArray<string>,
  sourceThreadId: string,
): boolean => threadsRead.every((thread) => thread === sourceThreadId);

/** Canonical checkpoint source refs must exactly match the manifest chunks. */
const chunksMatchCanonical = (
  chunks: ReadonlyArray<ValidChunk>,
  canonical: ReadonlyArray<{
    readonly rootRef: string;
    readonly chunkRef: string;
    readonly chunkHash: string;
    readonly coveredFromInclusive: number;
    readonly coveredToExclusive: number;
  }>,
  sourceRoot: string,
): boolean => {
  if (chunks.length !== canonical.length) return false;
  const byRef = new Map(canonical.map((ref) => [ref.chunkRef, ref]));
  if (byRef.size !== canonical.length) return false;
  return chunks.every((chunk) => {
    const known = byRef.get(chunk.chunkRef);
    return (
      known !== undefined &&
      known.chunkHash === chunk.chunkHash &&
      known.rootRef === sourceRoot &&
      known.coveredFromInclusive === chunk.coveredFromInclusive &&
      known.coveredToExclusive === chunk.coveredToExclusive
    );
  });
};

/** True only when chunks tile the captured window exactly, with no gap or overlap. */
const exactTiling = (
  chunks: ReadonlyArray<ValidChunk>,
  fromInclusive: number,
  toExclusive: number,
): boolean => {
  const ordered = [...chunks].sort((a, b) => a.coveredFromInclusive - b.coveredFromInclusive);
  let cursor = fromInclusive;
  for (const chunk of ordered) {
    if (chunk.coveredFromInclusive !== cursor) return false;
    cursor = chunk.coveredToExclusive;
  }
  return cursor === toExclusive;
};

/**
 * Invocation-scoped factory for the EXISTING trusted resolver port. Root
 * must supply the ambient SQL client, the current retro-manager
 * `MissionAuthority`, and a private absolute artifact directory. No global
 * captured manager is shared across requests, no independent SQL
 * connection is opened, and no canonical write, lease mutation, model
 * start, source access, or read-receipt promotion ever happens here:
 * `ReportStore` keeps owning CAS, receipts, and reconciliation. Never
 * install globally and never expose `resolve` as a public tool: the caller
 * authority belongs to the current retro manager/epoch/team/env.
 */
export const layerMissionRetroReportSourceResolver = (
  config: MissionRetroReportSourceResolverConfig,
) => Layer.effect(Artifacts.MissionRetroReportTrustedResolver, make(config));

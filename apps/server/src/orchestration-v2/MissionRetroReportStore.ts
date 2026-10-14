// @effect-diagnostics nodeBuiltinImport:off -- cryptographic hashes bind artifact bytes and durable receipts.
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import {
  CommandId,
  EventId,
  NonNegativeInt,
} from "../../../../packages/contracts/src/baseSchemas.ts";
import {
  Mission,
  MissionId,
  type MissionRetroReportReceivedEvent,
} from "../../../../packages/contracts/src/mission.ts";
import { emptyMissionExecution } from "../../../../packages/contracts/src/missionExecution.ts";
import {
  RetroId,
  Sha256Hex,
  type MissionRetroCheckpoint,
} from "../../../../packages/contracts/src/missionRetro.ts";
import type {
  MissionRetroAnalysis,
  MissionRetroAnalysisLease,
} from "../../../../packages/contracts/src/missionRetroAnalysis.ts";
import {
  MAX_MISSION_RETRO_REPORT_RECEIPTS,
  MAX_MISSION_RETRO_REPORT_QUARANTINE,
  MAX_MISSION_RETRO_REPORT_REASON_REFS,
  MissionRetroReportReceipt as ReceiptSchema,
  type MissionRetroReportDispositionValue,
  type MissionRetroReportReceipt as ReceiptRecord,
  type MissionRetroReportVerdictValue,
} from "../../../../packages/contracts/src/missionRetroReportReceipt.ts";
import { MissionRetroReport } from "../../../../packages/contracts/src/missionRetroReport.ts";
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
import { MissionAuthority } from "./MissionService.ts";
import {
  computeRetroReportHash,
  MissionRetroReportReconciliationError,
  reconcileRetroReport,
  type MissionRetroReportAssignment,
  type MissionRetroReportContext,
  type MissionRetroReportDecision,
  type MissionRetroReportTrustedCoverage,
} from "./MissionRetroReportReconciliation.ts";
import type { MissionRetroReport as ReportValue } from "../../../../packages/contracts/src/missionRetroReport.ts";

/**
 * Dormant retro report store. Receives ONE bounded source report per
 * canonical analysis attempt/checkpoint through the SAME canonical mission
 * event log / projection / command-receipt transaction as every other
 * mission store: no new table, bus, framework, outbox, notification, model
 * start, lease/slot mutation, or runtime activation.
 *
 * Serialization contract: the original descriptor bytes are the UTF-8 JSON
 * text of the worker report; `originalArtifactSha` is the SHA-256 over
 * those complete bytes. The normalized descriptor bytes are the canonical
 * `stableStringify` of the server-normalized report; the normalized
 * artifact ref is content-addressed as `retro-normalized:<reportHash>`.
 * Snapshots carry pointer metadata only (refs/hashes/counts/verdict/
 * disposition/coverage flags and bounded reason refs); complete reports
 * and incident indexes live in the immutable artifacts outside the DB.
 */

export const MISSION_RETRO_REPORT_RECEIVE_COMMAND_TYPE = "mission.retro-report-receive";
/** Byte bound for one original descriptor; schema bounds keep real reports far below it. */
export const MAX_MISSION_RETRO_REPORT_DESCRIPTOR_BYTES = 524_288;

export class MissionRetroReportStoreError extends Schema.TaggedError<MissionRetroReportStoreError>()(
  "MissionRetroReportStoreError",
  {
    operation: Schema.Literals(["receive"]),
    category: Schema.Literals([
      "scope_denied",
      "invalid_command",
      "request_conflict",
      "persistence",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Mission retro report receive failed (${this.category}).`;
  }
}

/** Documented durable denial. Persisted as a rejected command receipt. */
export class MissionRetroReportRejection extends Schema.TaggedError<MissionRetroReportRejection>()(
  "MissionRetroReportRejection",
  {
    operation: Schema.Literal("receive"),
    code: Schema.Literals([
      "checkpoint_missing",
      "analysis_missing",
      "lease_missing",
      "terminal_denied",
      "scope_mismatch",
      "epoch_mismatch",
      "claimed_hash_mismatch",
      "artifact_mismatch",
      "report_bound",
      "quarantine_bound",
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message() {
    return `Mission retro report denied (${this.code}).`;
  }
}

const ReceiveCommand = Schema.Struct({
  commandId: CommandId,
  missionId: RetroId,
  checkpointId: RetroId,
  expectedRevision: NonNegativeInt,
  retroEpoch: NonNegativeInt,
  originalArtifactRef: RetroId,
  originalArtifactSha: Sha256Hex,
  claimedSourceReportHash: Sha256Hex,
});
export type MissionRetroReportReceiveCommand = typeof ReceiveCommand.Type;

/**
 * Trusted original resolved by the authorized artifact port from the exact
 * command refs. Scope/source fields are server facts; the report object is
 * never trusted (the store decodes `descriptorBytes` itself).
 */
export interface MissionRetroReportTrustedOriginal {
  readonly teamId: string;
  readonly environmentId: string;
  readonly missionId: string;
  readonly checkpointId: string;
  readonly retroThreadId: string;
  readonly retroEpoch: number;
  readonly sourceThreadId: string;
  readonly sourceRoot: string;
  readonly snapshotFingerprint: string;
  readonly coveredFromInclusive: number;
  readonly coveredToExclusive: number;
  readonly originalArtifactRef: string;
  /** Complete actual descriptor bytes (UTF-8 JSON report text). */
  readonly descriptorBytes: string;
  readonly report: unknown;
  /** Trusted actual origin of the source work, never the caller's label. */
  readonly actualOrigin: string;
  readonly coverage: MissionRetroReportTrustedCoverage;
}

export interface MissionRetroReportReadInput {
  readonly command: MissionRetroReportReceiveCommand;
}

export interface MissionRetroReportPrepareInput {
  /** Server-normalized report (pure policy output), never worker claims. */
  readonly report: ReportValue;
  readonly coverageEvidence: MissionRetroReportCoverageEvidence;
  readonly sourceReportHash: string;
  readonly checkpointId: string;
}

export interface MissionRetroReportCoverageEvidence {
  readonly checkpointId: string;
  readonly sourceReportHash: string;
  readonly normalizedReportHash: string;
  readonly coverage: MissionRetroReportDecision["coverage"];
  readonly observations: MissionRetroReportTrustedCoverage;
}

export interface MissionRetroReportPreparedNormalized {
  readonly artifactRef: string;
  readonly artifactSha: string;
  readonly coverageEvidence: { readonly artifactRef: string; readonly artifactSha: string; readonly descriptorBytes: string };
  /** Complete actual normalized descriptor bytes. */
  readonly descriptorBytes: string;
}

export class MissionRetroReportArtifactPort extends Context.Service<
  MissionRetroReportArtifactPort,
  {
    readonly readOriginal: (
      input: MissionRetroReportReadInput,
    ) => Effect.Effect<MissionRetroReportTrustedOriginal, MissionRetroReportStoreError>;
    readonly prepareNormalized: (
      input: MissionRetroReportPrepareInput,
    ) => Effect.Effect<MissionRetroReportPreparedNormalized, MissionRetroReportStoreError>;
  }
>()("t3/orchestration-v2/MissionRetroReportStore/MissionRetroReportArtifactPort") {}

export interface MissionRetroReportOutcome {
  readonly receiptRecord: ReceiptRecord;
  readonly receipt: Receipts.OrchestrationCommandReceipt;
  readonly committed: boolean;
  readonly recovered: boolean;
  readonly eventSequence: number;
  readonly disposition: MissionRetroReportDispositionValue;
  readonly verdict: MissionRetroReportVerdictValue;
  readonly sourceReportHash: string;
  readonly normalizedReportHash: string;
  readonly normalizedArtifactRef: string;
}

export type MissionRetroReportResult = Result.Result<
  MissionRetroReportOutcome,
  MissionRetroReportRejection | MissionRetroReportReconciliationError
>;

export class MissionRetroReportStore extends Context.Service<
  MissionRetroReportStore,
  {
    readonly receive: (
      command: MissionRetroReportReceiveCommand,
    ) => Effect.Effect<MissionRetroReportResult, MissionRetroReportStoreError>;
  }
>()("t3/orchestration-v2/MissionRetroReportStore") {}

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));
const encodeMission = Schema.encodeEffect(Schema.fromJsonString(Mission));
const FailureSchema = Schema.Union([
  MissionRetroReportRejection,
  MissionRetroReportReconciliationError,
]);
const encodeFailure = Schema.encodeEffect(Schema.fromJsonString(FailureSchema));
const decodeFailure = Schema.decodeUnknownEffect(Schema.fromJsonString(FailureSchema));
const decodeReceiptRecord = Schema.decodeUnknownEffect(ReceiptSchema);
const decodeReportValue = Schema.decodeUnknownEffect(MissionRetroReport, {
  onExcessProperty: "error",
});
const decodeCommand = Schema.decodeUnknownEffect(ReceiveCommand, { onExcessProperty: "error" });
const isStoreError = Schema.is(MissionRetroReportStoreError);

const sha256 = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");
const reasonRef = (reason: string): string => `retro-reason:${sha256(reason).slice(0, 24)}`;
const reasonRefs = (reasons: ReadonlyArray<string>): ReadonlyArray<string> =>
  reasons.slice(0, MAX_MISSION_RETRO_REPORT_REASON_REFS).map(reasonRef);

interface Prepared {
  readonly trusted: MissionRetroReportTrustedOriginal;
  readonly decision: MissionRetroReportDecision;
  readonly actualSourceHash: string;
  readonly normalized: MissionRetroReportPreparedNormalized | null;
  /** Disposition override for a command whose claimed hash attests nothing. */
  readonly claimedMismatch: boolean;
  /** Canonical lease tuple captured at prepare time, compared at commit. */
  readonly leaseTupleJson: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authority = yield* MissionAuthority;
  const events = yield* EventStore.OrchestrationEventStore;
  const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
  const port = yield* MissionRetroReportArtifactPort;

  const mapError = (cause: unknown) =>
    isStoreError(cause)
      ? cause
      : new MissionRetroReportStoreError({ operation: "receive", category: "persistence", cause });

  const load = Effect.fn("MissionRetroReportStore.load")(function* (
    command: MissionRetroReportReceiveCommand,
  ) {
    const rows = yield* sql<{
      mission_id: string;
      revision: number;
      snapshot_json: string;
    }>`SELECT mission_id, revision, snapshot_json FROM projection_missions WHERE mission_id = ${command.missionId} AND team_id = ${authority.teamId} AND authority_environment_id = ${authority.environmentId}`;
    if (rows[0] === undefined)
      return yield* new MissionRetroReportStoreError({
        operation: "receive",
        category: "scope_denied",
      });
    const mission = yield* decodeMission(rows[0].snapshot_json);
    if (
      mission.id !== rows[0].mission_id ||
      mission.revision !== rows[0].revision ||
      mission.teamId !== authority.teamId ||
      mission.authorityEnvironmentId !== authority.environmentId
    )
      return yield* new MissionRetroReportStoreError({
        operation: "receive",
        category: "persistence",
      });
    const checkpoints = mission.execution?.retroCheckpoints ?? [];
    if (
      new Set(checkpoints.map((cp) => cp.checkpointId)).size !== checkpoints.length ||
      checkpoints.some(
        (cp) =>
          cp.teamId !== authority.teamId ||
          cp.environmentId !== authority.environmentId ||
          cp.missionId !== mission.id,
      ) ||
      (mission.execution?.retroAnalyses ?? []).some((record) => {
        const cp = checkpoints.find((entry) => entry.checkpointId === record.checkpointId);
        return cp === undefined || !sameSource(cp, record);
      }) ||
      (mission.execution?.retroReportReceipts ?? []).some(
        (record) =>
          record.teamId !== authority.teamId ||
          record.environmentId !== authority.environmentId ||
          record.missionId !== mission.id,
      )
    )
      return yield* new MissionRetroReportStoreError({
        operation: "receive",
        category: "persistence",
      });
    const manager = mission.managers.retro;
    if (
      manager?.threadId !== authority.controllerThreadId ||
      manager.epoch === undefined ||
      manager.epoch !== command.retroEpoch
    )
      return yield* new MissionRetroReportStoreError({
        operation: "receive",
        category: "scope_denied",
      });
    return mission;
  });

  const rejectInTransaction = Effect.fn("MissionRetroReportStore.reject")(function* (
    command: MissionRetroReportReceiveCommand,
    requestHash: string,
    failure: MissionRetroReportRejection | MissionRetroReportReconciliationError,
  ) {
    if (
      !(yield* receipts.insertIfAbsent({
        commandId: command.commandId,
        aggregateKind: "mission",
        aggregateId: MissionId.make(command.missionId),
        commandType: MISSION_RETRO_REPORT_RECEIVE_COMMAND_TYPE,
        acceptedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
        resultSequence: 0,
        status: "rejected",
        error: yield* encodeFailure(failure),
        requestHash,
      }))
    )
      return yield* new MissionRetroReportStoreError({
        operation: "receive",
        category: "request_conflict",
      });
    return Result.fail(failure);
  });

  const outcomeFromEvent = (
    event: Extract<MissionRetroReportReceivedEvent, { type: "mission.retro-report-received" }>,
    saved: Receipts.OrchestrationCommandReceipt,
  ): MissionRetroReportOutcome | null => {
    const records = (event.payload.mission.execution?.retroReportReceipts ?? []).filter(
      (record) => record.checkpointId === event.payload.checkpointId,
    );
    const main = records.find(
      (record) => record.sourceReportHash === event.payload.sourceReportHash,
    );
    if (main !== undefined) {
      return {
        receiptRecord: main,
        receipt: saved,
        committed: false,
        recovered: true,
        eventSequence: event.sequence,
        disposition: main.disposition,
        verdict: main.verdict,
        sourceReportHash: main.sourceReportHash,
        normalizedReportHash: main.normalizedReportHash,
        normalizedArtifactRef: main.normalizedArtifactRef,
      };
    }
    for (const record of records) {
      const variant = record.quarantine.find(
        (entry) => entry.sourceReportHash === event.payload.sourceReportHash,
      );
      if (variant !== undefined) {
        return {
          receiptRecord: record,
          receipt: saved,
          committed: false,
          recovered: true,
          eventSequence: event.sequence,
          disposition: "held_conflict" as const,
          verdict: "partial_coverage",
          sourceReportHash: variant.sourceReportHash,
          normalizedReportHash: variant.normalizedReportHash,
          normalizedArtifactRef: variant.normalizedArtifactRef,
        };
      }
    }
    return null;
  };

  const replay = Effect.fn("MissionRetroReportStore.replay")(function* (
    command: MissionRetroReportReceiveCommand,
    requestHash: string,
  ) {
    const prior = yield* receipts.getByCommandId({ commandId: command.commandId });
    if (Option.isNone(prior)) return Option.none<MissionRetroReportResult>();
    const saved = prior.value;
    if (
      saved.commandType !== MISSION_RETRO_REPORT_RECEIVE_COMMAND_TYPE ||
      saved.aggregateKind !== "mission" ||
      saved.aggregateId !== command.missionId ||
      saved.requestHash !== requestHash
    )
      return yield* new MissionRetroReportStoreError({
        operation: "receive",
        category: "request_conflict",
      });
    if (saved.status === "rejected") {
      if (saved.error === null)
        return yield* new MissionRetroReportStoreError({
          operation: "receive",
          category: "persistence",
        });
      return Option.some(Result.fail(yield* decodeFailure(saved.error)));
    }
    const logged = yield* events.readMissionEvents(MissionId.make(command.missionId));
    const event = logged.find((entry) => entry.sequence === saved.resultSequence);
    if (event?.type !== "mission.retro-report-received")
      return yield* new MissionRetroReportStoreError({
        operation: "receive",
        category: "persistence",
      });
    const outcome = outcomeFromEvent(event, saved);
    if (outcome === null)
      return yield* new MissionRetroReportStoreError({
        operation: "receive",
        category: "persistence",
      });
    return Option.some(Result.succeed(outcome));
  });

  const commitSnapshot = Effect.fn("MissionRetroReportStore.commitSnapshot")(function* (
    command: MissionRetroReportReceiveCommand,
    requestHash: string,
    canonical: Mission,
    nextReceipts: ReadonlyArray<ReceiptRecord>,
    eventSourceHash: string,
  ) {
    const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    const execution = canonical.execution ?? emptyMissionExecution();
    const updated: Mission = {
      ...canonical,
      revision: canonical.revision + 1,
      updatedAt: now,
      execution: { ...execution, retroReportReceipts: [...nextReceipts] },
    };
    const event: MissionRetroReportReceivedEvent = {
      sequence: 0,
      eventId: EventId.make(NodeCrypto.randomUUID()),
      aggregateKind: "mission",
      aggregateId: canonical.id,
      occurredAt: now,
      commandId: command.commandId,
      metadata: {},
      type: "mission.retro-report-received",
      payload: {
        mission: updated,
        checkpointId: command.checkpointId,
        sourceReportHash: eventSourceHash,
        operation: "receive",
      },
    };
    const stored = yield* events.appendMissionEvent(event);
    const snapshot = yield* encodeMission(updated);
    const cas = yield* sql<{
      mission_id: string;
    }>`UPDATE projection_missions SET revision = ${updated.revision}, snapshot_json = ${snapshot}, updated_at = ${now} WHERE mission_id = ${canonical.id} AND revision = ${canonical.revision} AND team_id = ${authority.teamId} AND authority_environment_id = ${authority.environmentId} RETURNING mission_id`;
    if (cas.length !== 1)
      return yield* new MissionRetroReportStoreError({
        operation: "receive",
        category: "request_conflict",
      });
    const receipt: Receipts.OrchestrationCommandReceipt = {
      commandId: command.commandId,
      aggregateKind: "mission",
      aggregateId: canonical.id,
      commandType: MISSION_RETRO_REPORT_RECEIVE_COMMAND_TYPE,
      acceptedAt: now,
      resultSequence: stored.sequence,
      status: "accepted",
      error: null,
      requestHash,
    };
    if (!(yield* receipts.insertIfAbsent(receipt)))
      return yield* new MissionRetroReportStoreError({
        operation: "receive",
        category: "request_conflict",
      });
    return { receipt, sequence: stored.sequence };
  });

  const leaseTuple = (analysis: MissionRetroAnalysis) =>
    analysis.lease === null
      ? null
      : {
          assignmentToken: analysis.lease.assignmentToken,
          fence: analysis.fence,
          attemptNumber: analysis.attemptNumber,
          reportRevision: analysis.lease.reportRevision,
          reporterChildThreadId: analysis.lease.reporterChildThreadId,
          reporterRunId: analysis.lease.reporterRunId,
          accountId: analysis.lease.accountId,
          providerInstanceId: analysis.lease.providerInstanceId,
          modelId: analysis.lease.modelId,
          profile: analysis.lease.profile,
          company: analysis.lease.company,
          managerEpoch: analysis.managerEpoch,
          status: analysis.status,
          settlementStatus: analysis.settlement?.status ?? null,
        };

  const transaction = Effect.fn("MissionRetroReportStore.transaction")(function* (
    command: MissionRetroReportReceiveCommand,
    requestHash: string,
    prepared: Prepared | null,
  ) {
    // Canonical reread and current retro-role check precede every receipt
    // lookup inside the owning transaction, including replay.
    const canonical = yield* load(command);
    const savedReplay = yield* replay(command, requestHash);
    if (Option.isSome(savedReplay)) return savedReplay.value;
    if (prepared === null)
      return yield* new MissionRetroReportStoreError({
        operation: "receive",
        category: "persistence",
      });
    const { trusted, decision, actualSourceHash } = prepared;
    const checkpoint = (canonical.execution?.retroCheckpoints ?? []).find(
      (cp) => cp.checkpointId === command.checkpointId,
    );
    if (checkpoint === undefined)
      return yield* rejectInTransaction(
        command,
        requestHash,
        new MissionRetroReportRejection({ operation: "receive", code: "checkpoint_missing" }),
      );
    const analysis = (canonical.execution?.retroAnalyses ?? []).find(
      (record) => record.checkpointId === command.checkpointId,
    );
    if (analysis === undefined)
      return yield* rejectInTransaction(
        command,
        requestHash,
        new MissionRetroReportRejection({ operation: "receive", code: "analysis_missing" }),
      );
    // Epoch/fence/token/checkpoint state may not change between prepare and
    // commit undetected: any drift fails closed and rolls back.
    if (
      !sameSource(checkpoint, analysis) ||
      !sameSource(checkpoint, trusted) ||
      analysis.managerEpoch !== command.retroEpoch ||
      stableStringify(leaseTuple(analysis)) !== prepared.leaseTupleJson ||
      !leaseAcceptable(analysis)
    )
      return yield* new MissionRetroReportStoreError({
        operation: "receive",
        category: "request_conflict",
      });
    const lease = analysis.lease as MissionRetroAnalysisLease;
    const records = canonical.execution?.retroReportReceipts ?? [];
    const prior = records.find(
      (record) =>
        record.checkpointId === command.checkpointId &&
        record.fence === analysis.fence &&
        record.attemptNumber === analysis.attemptNumber &&
        record.reportRevision === lease.reportRevision,
    );
    const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));

    if (prior !== undefined && prior.sourceReportHash === actualSourceHash) {
      if (prepared.claimedMismatch)
        return yield* rejectInTransaction(
          command,
          requestHash,
          new MissionRetroReportRejection({
            operation: "receive",
            code: "claimed_hash_mismatch",
          }),
        );
      // Duplicate canonical bytes from a new command id: alias the original
      // event sequence, with no revision, event, or job of its own.
      const logged = yield* events.readMissionEvents(canonical.id);
      const original = logged.find(
        (entry) =>
          entry.type === "mission.retro-report-received" &&
          entry.payload.checkpointId === command.checkpointId &&
          entry.payload.sourceReportHash === actualSourceHash,
      );
      if (original?.type !== "mission.retro-report-received")
        return yield* new MissionRetroReportStoreError({
          operation: "receive",
          category: "persistence",
        });
      const aliasReceipt: Receipts.OrchestrationCommandReceipt = {
        commandId: command.commandId,
        aggregateKind: "mission",
        aggregateId: canonical.id,
        commandType: MISSION_RETRO_REPORT_RECEIVE_COMMAND_TYPE,
        acceptedAt: now,
        resultSequence: original.sequence,
        status: "accepted",
        error: null,
        requestHash,
      };
      if (!(yield* receipts.insertIfAbsent(aliasReceipt)))
        return yield* new MissionRetroReportStoreError({
          operation: "receive",
          category: "request_conflict",
        });
      const outcome = outcomeFromEvent(original, aliasReceipt);
      if (outcome === null)
        return yield* new MissionRetroReportStoreError({
          operation: "receive",
          category: "persistence",
        });
      return Result.succeed({ ...outcome, receipt: aliasReceipt });
    }

    if (prior !== undefined) {
      // Same revision, changed ACTUAL source hash: quarantine the variant on
      // the existing receipt; the accepted main hash/status never moves.
      const repeated = prior.quarantine.find(
        (entry) => entry.sourceReportHash === actualSourceHash,
      );
      if (repeated !== undefined) {
        const logged = yield* events.readMissionEvents(canonical.id);
        const held = logged.find(
          (entry) =>
            entry.type === "mission.retro-report-received" &&
            entry.payload.checkpointId === command.checkpointId &&
            entry.payload.sourceReportHash === actualSourceHash,
        );
        if (held?.type !== "mission.retro-report-received")
          return yield* new MissionRetroReportStoreError({
            operation: "receive",
            category: "persistence",
          });
        const aliasReceipt: Receipts.OrchestrationCommandReceipt = {
          commandId: command.commandId,
          aggregateKind: "mission",
          aggregateId: canonical.id,
          commandType: MISSION_RETRO_REPORT_RECEIVE_COMMAND_TYPE,
          acceptedAt: now,
          resultSequence: held.sequence,
          status: "accepted",
          error: null,
          requestHash,
        };
        if (!(yield* receipts.insertIfAbsent(aliasReceipt)))
          return yield* new MissionRetroReportStoreError({
            operation: "receive",
            category: "request_conflict",
          });
        const outcome = outcomeFromEvent(held, aliasReceipt);
        if (outcome === null)
          return yield* new MissionRetroReportStoreError({
            operation: "receive",
            category: "persistence",
          });
        return Result.succeed({ ...outcome, receipt: aliasReceipt });
      }
      if (prepared.normalized === null)
        return yield* new MissionRetroReportStoreError({ operation: "receive", category: "persistence" });
      if (command.expectedRevision !== canonical.revision)
        return yield* new MissionRetroReportStoreError({
          operation: "receive",
          category: "request_conflict",
        });
      if (prior.quarantine.length >= MAX_MISSION_RETRO_REPORT_QUARANTINE)
        return yield* rejectInTransaction(
          command,
          requestHash,
          new MissionRetroReportRejection({ operation: "receive", code: "quarantine_bound" }),
        );
      const updatedPrior: ReceiptRecord = {
        ...prior,
        quarantine: [
          ...prior.quarantine,
          {
            originalArtifactRef: command.originalArtifactRef,
            originalArtifactSha: command.originalArtifactSha,
            claimedSourceReportHash: command.claimedSourceReportHash,
            sourceReportHash: actualSourceHash,
            normalizedReportHash: decision.report.reportHash,
            normalizedArtifactRef: prepared.normalized.artifactRef,
            normalizedArtifactSha: prepared.normalized.artifactSha,
            coverageEvidenceRef: prepared.normalized.coverageEvidence.artifactRef,
            coverageEvidenceSha: prepared.normalized.coverageEvidence.artifactSha,
            reasonRef: reasonRef("same revision with changed source hash"),
            receivedAt: now,
          },
        ],
      };
      yield* decodeReceiptRecord(updatedPrior);
      const next = records.map((record) => (record === prior ? updatedPrior : record));
      const committed = yield* commitSnapshot(command, requestHash, canonical, next, actualSourceHash);
      return Result.succeed({
        receiptRecord: updatedPrior,
        receipt: committed.receipt,
        committed: true,
        recovered: false,
        eventSequence: committed.sequence,
        disposition: "held_conflict" as const,
        verdict: "partial_coverage" as const,
        sourceReportHash: actualSourceHash,
        normalizedReportHash: decision.report.reportHash,
        normalizedArtifactRef: prepared.normalized.artifactRef,
      });
    }

    if (prepared.normalized === null)
      return yield* new MissionRetroReportStoreError({ operation: "receive", category: "persistence" });
    if (command.expectedRevision !== canonical.revision)
      return yield* new MissionRetroReportStoreError({
        operation: "receive",
        category: "request_conflict",
      });
    if (records.length >= MAX_MISSION_RETRO_REPORT_RECEIPTS)
      return yield* rejectInTransaction(
        command,
        requestHash,
        new MissionRetroReportRejection({ operation: "receive", code: "report_bound" }),
      );
    const disposition: MissionRetroReportDispositionValue = prepared.claimedMismatch
      ? "held_conflict"
      : decision.disposition === "recovered_duplicate"
        ? "held_conflict"
        : decision.disposition;
    const verdict: MissionRetroReportVerdictValue = prepared.claimedMismatch
      ? "partial_coverage"
      : decision.verdict;
    const record = yield* decodeReceiptRecord({
      checkpointId: checkpoint.checkpointId,
      teamId: checkpoint.teamId,
      environmentId: checkpoint.environmentId,
      missionId: checkpoint.missionId,
      sourceThreadId: checkpoint.sourceThreadId,
      sourceRoot: checkpoint.sourceRoot,
      snapshotFingerprint: checkpoint.snapshotFingerprint,
      coveredFromInclusive: checkpoint.coveredFromInclusive,
      coveredToExclusive: checkpoint.coveredToExclusive,
      reporterChildThreadId: lease.reporterChildThreadId,
      reporterRunId: lease.reporterRunId,
      assignmentToken: lease.assignmentToken,
      fence: analysis.fence,
      attemptNumber: analysis.attemptNumber,
      reportRevision: lease.reportRevision,
      accountId: lease.accountId,
      providerInstanceId: lease.providerInstanceId,
      modelId: lease.modelId,
      profile: lease.profile,
      company: lease.company,
      originalArtifactRef: command.originalArtifactRef,
      originalArtifactSha: command.originalArtifactSha,
      claimedSourceReportHash: command.claimedSourceReportHash,
      sourceReportHash: decision.sourceReportHash,
      normalizedArtifactRef: prepared.normalized.artifactRef,
      normalizedArtifactSha: prepared.normalized.artifactSha,
      coverageEvidenceRef: prepared.normalized.coverageEvidence.artifactRef,
      coverageEvidenceSha: prepared.normalized.coverageEvidence.artifactSha,
      normalizedReportHash: decision.report.reportHash,
      verdict,
      disposition,
      coverageFull: prepared.claimedMismatch ? false : decision.coverage.full,
      coverageReasonRefs: prepared.claimedMismatch
        ? reasonRefs(["claimed source hash does not match actual bytes"])
        : reasonRefs(decision.coverage.reasons),
      incidentCount: decision.report.incidents.length,
      shortlistCount: decision.report.shortlist.length,
      incidentArtifactRef: prepared.normalized.artifactRef,
      receivedAt: now,
      quarantine: [],
    });
    const committed = yield* commitSnapshot(
      command,
      requestHash,
      canonical,
      [...records, record],
      actualSourceHash,
    );
    return Result.succeed({
      receiptRecord: record,
      receipt: committed.receipt,
      committed: true,
      recovered: false,
      eventSequence: committed.sequence,
      disposition,
      verdict,
      sourceReportHash: decision.sourceReportHash,
      normalizedReportHash: decision.report.reportHash,
      normalizedArtifactRef: prepared.normalized.artifactRef,
    });
  });

  function sameSource(
    checkpoint: MissionRetroCheckpoint,
    other: {
      readonly checkpointId: string;
      readonly teamId: string;
      readonly environmentId: string;
      readonly missionId: string;
      readonly sourceThreadId: string;
      readonly sourceRoot: string;
      readonly snapshotFingerprint: string;
      readonly coveredFromInclusive: number;
      readonly coveredToExclusive: number;
    },
  ): boolean {
    return (
      checkpoint.checkpointId === other.checkpointId &&
      checkpoint.teamId === other.teamId &&
      checkpoint.environmentId === other.environmentId &&
      checkpoint.missionId === other.missionId &&
      checkpoint.sourceThreadId === other.sourceThreadId &&
      checkpoint.sourceRoot === other.sourceRoot &&
      checkpoint.snapshotFingerprint === other.snapshotFingerprint &&
      checkpoint.coveredFromInclusive === other.coveredFromInclusive &&
      checkpoint.coveredToExclusive === other.coveredToExclusive
    );
  }

  function leaseAcceptable(analysis: MissionRetroAnalysis): boolean {
    if (analysis.lease === null) return false;
    if (analysis.status === "reserved" || analysis.status === "uncertain") return true;
    return analysis.status === "settled" && analysis.settlement?.status === "succeeded";
  }

  const receive = Effect.fn("MissionRetroReportStore.receive")(function* (
    input: MissionRetroReportReceiveCommand,
  ) {
    const command = yield* decodeCommand(structuredClone(input)).pipe(
      Effect.mapError(
        (cause) =>
          new MissionRetroReportStoreError({
            operation: "receive",
            category: "invalid_command",
            cause,
          }),
      ),
    );
    // No artifact or receipt work may run inside a caller's transaction.
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
      return yield* new MissionRetroReportStoreError({
        operation: "receive",
        category: "persistence",
      });
    // Authenticated retro scope precedes ANY receipt lookup or artifact read.
    const pre = yield* load(command);
    const requestHash = sha256(
      stableStringify({
        operation: "receive",
        teamId: authority.teamId,
        environmentId: authority.environmentId,
        controllerThreadId: authority.controllerThreadId,
        command,
      }),
    );
    const rejectRechecked = (
      command: MissionRetroReportReceiveCommand,
      requestHash: string,
      failure: MissionRetroReportRejection | MissionRetroReportReconciliationError,
    ) => Effect.gen(function* () {
      const current = yield* load(command);
      const saved = yield* replay(command, requestHash);
      if (Option.isSome(saved)) return saved.value;
      if (current.revision !== pre.revision)
        return yield* new MissionRetroReportStoreError({ operation: "receive", category: "request_conflict" });
      return yield* rejectInTransaction(command, requestHash, failure);
    });
    const existing = yield* receipts.getByCommandId({ commandId: command.commandId });
    let prepared: Prepared | null = null;
    if (Option.isNone(existing)) {
      const checkpoint = (pre.execution?.retroCheckpoints ?? []).find(
        (cp) => cp.checkpointId === command.checkpointId,
      );
      if (checkpoint === undefined)
        return yield* sql
          .withTransaction(
            rejectRechecked(
              command,
              requestHash,
              new MissionRetroReportRejection({ operation: "receive", code: "checkpoint_missing" }),
            ),
          )
          .pipe(Effect.mapError(mapError));
      const analysis = (pre.execution?.retroAnalyses ?? []).find(
        (record) => record.checkpointId === command.checkpointId,
      );
      if (analysis === undefined)
        return yield* sql
          .withTransaction(
            rejectRechecked(
              command,
              requestHash,
              new MissionRetroReportRejection({ operation: "receive", code: "analysis_missing" }),
            ),
          )
          .pipe(Effect.mapError(mapError));
      if (analysis.lease === null)
        return yield* sql
          .withTransaction(
            rejectRechecked(
              command,
              requestHash,
              new MissionRetroReportRejection({ operation: "receive", code: "lease_missing" }),
            ),
          )
          .pipe(Effect.mapError(mapError));
      if (analysis.managerEpoch !== command.retroEpoch)
        return yield* sql
          .withTransaction(
            rejectRechecked(
              command,
              requestHash,
              new MissionRetroReportRejection({ operation: "receive", code: "epoch_mismatch" }),
            ),
          )
          .pipe(Effect.mapError(mapError));
      if (!leaseAcceptable(analysis))
        return yield* sql
          .withTransaction(
            rejectRechecked(
              command,
              requestHash,
              new MissionRetroReportRejection({ operation: "receive", code: "terminal_denied" }),
            ),
          )
          .pipe(Effect.mapError(mapError));
      const lease = analysis.lease;
      // Immutable source bytes come from the authorized port OUTSIDE SQL.
      const trustedRaw = yield* port.readOriginal(
        structuredClone({ command }) as MissionRetroReportReadInput,
      );
      const trusted: MissionRetroReportTrustedOriginal = structuredClone(trustedRaw);
      if (
        trusted.teamId !== authority.teamId ||
        trusted.environmentId !== authority.environmentId ||
        trusted.missionId !== command.missionId ||
        trusted.checkpointId !== command.checkpointId ||
        trusted.retroThreadId !== authority.controllerThreadId ||
        trusted.retroEpoch !== command.retroEpoch ||
        trusted.originalArtifactRef !== command.originalArtifactRef ||
        !sameSource(checkpoint, trusted)
      )
        return yield* sql
          .withTransaction(
            rejectRechecked(
              command,
              requestHash,
              new MissionRetroReportRejection({ operation: "receive", code: "scope_mismatch" }),
            ),
          )
          .pipe(Effect.mapError(mapError));
      if (sha256(trusted.descriptorBytes) !== command.originalArtifactSha)
        return yield* sql
          .withTransaction(
            rejectRechecked(
              command,
              requestHash,
              new MissionRetroReportRejection({ operation: "receive", code: "artifact_mismatch" }),
            ),
          )
          .pipe(Effect.mapError(mapError));
      let parsed: unknown;
      try {
        if (Buffer.byteLength(trusted.descriptorBytes, "utf8") > MAX_MISSION_RETRO_REPORT_DESCRIPTOR_BYTES)
          throw new Error("descriptor too large");
        parsed = decodeJson(trusted.descriptorBytes);
      } catch {
        return yield* sql
          .withTransaction(
            rejectRechecked(
              command,
              requestHash,
              new MissionRetroReportReconciliationError({
                operation: "reconcile",
                category: "malformed",
                detail: "Original descriptor bytes are not bounded JSON.",
              }),
            ),
          )
          .pipe(Effect.mapError(mapError));
      }
      const decoded = yield* decodeReportValue(parsed).pipe(
        Effect.mapError(
          () =>
            new MissionRetroReportReconciliationError({
              operation: "reconcile",
              category: "malformed",
              detail: "Original descriptor does not decode as a bounded retro report.",
            }),
        ),
        Effect.result,
      );
      if (Result.isFailure(decoded))
        return yield* sql
          .withTransaction(rejectRechecked(command, requestHash, decoded.failure))
          .pipe(Effect.mapError(mapError));
      const report = decoded.success;
      const actualSourceHash = computeRetroReportHash(report);
      const records = pre.execution?.retroReportReceipts ?? [];
      const prior = records.find(
        (record) =>
          record.checkpointId === command.checkpointId &&
          record.fence === analysis.fence &&
          record.attemptNumber === analysis.attemptNumber &&
          record.reportRevision === lease.reportRevision,
      );
      const assignment: MissionRetroReportAssignment = {
        reporterChildThreadId: lease.reporterChildThreadId,
        reporterRunId: lease.reporterRunId,
        reportRevision: lease.reportRevision,
        assignmentToken: lease.assignmentToken,
        managerEpoch: analysis.managerEpoch,
        requestedModel: lease.modelId,
        requestedProfile: lease.profile,
        verifiedCompany: lease.company,
        verifiedAccountRef: lease.verifiedAccountRef,
        verifiedProviderRef: lease.verifiedProviderRef,
        status: "active",
        actualOrigin: trusted.actualOrigin,
      };
      const context: MissionRetroReportContext = {
        expectedCheckpoint: {
          checkpointId: checkpoint.checkpointId,
          teamId: checkpoint.teamId,
          environmentId: checkpoint.environmentId,
          missionId: checkpoint.missionId,
          sourceThreadId: checkpoint.sourceThreadId,
          sourceRoot: checkpoint.sourceRoot,
          snapshotFingerprint: checkpoint.snapshotFingerprint,
          fromInclusive: checkpoint.coveredFromInclusive,
          toExclusive: checkpoint.coveredToExclusive,
        },
        assignment,
        coverage: trusted.coverage,
        priorAccepted:
          prior === undefined
            ? undefined
            : { reportRevision: prior.reportRevision, reportHash: prior.sourceReportHash },
      };
      const decided = reconcileRetroReport({ context, report: parsed });
      if (Result.isFailure(decided))
        return yield* sql
          .withTransaction(rejectRechecked(command, requestHash, decided.failure))
          .pipe(Effect.mapError(mapError));
      const decision = decided.success;
      const duplicate = prior !== undefined &&
        (prior.sourceReportHash === actualSourceHash ||
          prior.quarantine.some((variant) => variant.sourceReportHash === actualSourceHash));
      if (duplicate) {
        prepared = { trusted, decision, actualSourceHash, normalized: null,
          claimedMismatch: command.claimedSourceReportHash !== actualSourceHash,
          leaseTupleJson: stableStringify(leaseTuple(analysis)) };
      } else {
      // The port-returned object is never trusted: bytes were decoded above.
      const coverageEvidence: MissionRetroReportCoverageEvidence = {
        checkpointId: checkpoint.checkpointId,
        sourceReportHash: actualSourceHash,
        normalizedReportHash: decision.report.reportHash,
        coverage: decision.coverage,
        observations: trusted.coverage,
      };
      const normalizedRaw = yield* port.prepareNormalized(
        structuredClone({
          report: decision.report,
          coverageEvidence,
          sourceReportHash: actualSourceHash,
          checkpointId: command.checkpointId,
        }) as MissionRetroReportPrepareInput,
      );
      const normalized: MissionRetroReportPreparedNormalized = structuredClone(normalizedRaw);
      const normalizedOk = yield* Effect.result(
        Effect.gen(function* () {
          if (Buffer.byteLength(normalized.descriptorBytes, "utf8") > MAX_MISSION_RETRO_REPORT_DESCRIPTOR_BYTES ||
            sha256(normalized.descriptorBytes) !== normalized.artifactSha) return false;
          const evidence = normalized.coverageEvidence;
          if (evidence === undefined || Buffer.byteLength(evidence.descriptorBytes, "utf8") > 8 * 1024 * 1024 ||
            sha256(evidence.descriptorBytes) !== evidence.artifactSha ||
            evidence.artifactRef !== "retro-coverage:" + evidence.artifactSha ||
            stableStringify(decodeJson(evidence.descriptorBytes)) !== stableStringify(coverageEvidence)) return false;
          let reparsed: unknown;
          try {
            reparsed = decodeJson(normalized.descriptorBytes);
          } catch {
            return false;
          }
          const redecoded = yield* decodeReportValue(reparsed);
          return (
            stableStringify(redecoded) === stableStringify(decision.report) &&
            normalized.artifactRef === `retro-normalized:${redecoded.reportHash}`
          );
        }),
      );
      if (Result.isFailure(normalizedOk) || !normalizedOk.success)
        return yield* sql
          .withTransaction(
            rejectRechecked(
              command,
              requestHash,
              new MissionRetroReportRejection({ operation: "receive", code: "artifact_mismatch" }),
            ),
          )
          .pipe(Effect.mapError(mapError));
      prepared = {
        trusted,
        decision,
        actualSourceHash,
        normalized,
        claimedMismatch: command.claimedSourceReportHash !== actualSourceHash,
        leaseTupleJson: stableStringify(leaseTuple(analysis)),
      };
      }
    }
    const run = () =>
      sql
        .withTransaction(transaction(command, requestHash, prepared))
        .pipe(Effect.mapError(mapError));
    const first = yield* run().pipe(Effect.result);
    if (Result.isSuccess(first)) return first.success;
    if (first.failure.category !== "request_conflict") return yield* first.failure;
    return yield* run();
  });

  return MissionRetroReportStore.of({ receive: (command) => receive(command).pipe(Effect.mapError(mapError)) });
});
export const layer = Layer.effect(MissionRetroReportStore, make);

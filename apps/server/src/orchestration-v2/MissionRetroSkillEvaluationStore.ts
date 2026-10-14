// @effect-diagnostics nodeBuiltinImport:off -- stable command hashes bind durable receipts.
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import {
  CommandId,
  EventId,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "../../../../packages/contracts/src/baseSchemas.ts";
import {
  Mission,
  type MissionRetroSkillEvaluatedEvent,
} from "../../../../packages/contracts/src/mission.ts";
import {
  emptyMissionExecution,
  missionRetroReportReceipts,
  missionRetroSkillEvaluations,
} from "../../../../packages/contracts/src/missionExecution.ts";
import { RetroId, Sha256Hex } from "../../../../packages/contracts/src/missionRetro.ts";
import {
  MAX_MISSION_RETRO_SKILL_EVALUATIONS,
  MissionRetroSkillEvaluation as EvaluationRecordSchema,
  SkillEvaluationEvidenceArtifactRef,
  SkillEvaluationReviewerRef,
  SkillEvaluationTargetSkillRef,
  type MissionRetroSkillEvaluation as EvaluationRecord,
} from "../../../../packages/contracts/src/missionRetroSkillEvaluation.ts";
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
  reconcileSkillEvaluation,
  type SkillEvaluationTrustedContext,
} from "./MissionRetroSkillEvaluation.ts";

/**
 * Durable source-only skill-evaluation recorder (P2).
 *
 * Appends ONE bounded `MissionRetroSkillEvaluation` receipt to
 * `execution.retroSkillEvaluations` on the canonical mission aggregate. It
 * RECORDS the decision the existing pure validator
 * (`reconcileSkillEvaluation`) makes over trusted replay facts; it never runs
 * a replay, reads or writes a skill, installs or promotes anything, starts a
 * model, or activates a runtime. `review_ready` means the candidate may be
 * reviewed: it is not effective, promoted, installed, or authoritative.
 *
 * The canonical write is the existing mission event / `projection_missions`
 * CAS / command receipt transaction: no new table, migration, outbox,
 * scheduler or model dispatch. Only a fresh record writes the dedicated
 * `mission.retro-skill-evaluated` event (full updated snapshot plus the
 * record id), bumps the revision, and inserts the hash-bound accepted
 * receipt, all in ONE owning SQL transaction.
 *
 * Authority and evidence are two required private ports with NO default
 * producer, so the runtime stays dormant until a real producer exists:
 *
 * - `MissionRetroSkillEvaluationAuthority` is the root-held Retro role
 *   binding (team, environment, Retro thread and epoch).
 * - `MissionRetroSkillEvaluationProducer` supplies the candidate body, the
 *   separately trusted replay context for the validator, and the
 *   verification receipt for the immutable replay-evidence artifact, plus
 *   the user stop/pause state. This slice does not build the replay runner
 *   or the artifact filesystem adapter: fixtures that stand in for them are
 *   shape fixtures, not proof that a skill replay ever ran.
 *
 * The caller's command carries identity metadata only: command, mission,
 * expected revision, evaluation and candidate ids, and the evidence
 * pointer plus digest. It never carries a verdict, boolean, source hash,
 * reviewer, or authority. A pointer and digest alone are not proof: the
 * producer must report that it actually verified exactly those artifact
 * bytes and that the artifact is bound to this team, environment, mission,
 * Retro epoch, origin report (source and normalized hash), candidate,
 * evaluation, target skill and old/new snapshot digests.
 *
 * Unknown stays held. A missing or unknown fact (user intent, evaluation
 * facts, evidence verification) or an ineligible origin report (partial,
 * held, quarantined, or one with no candidates) yields a finite hold that
 * persists nothing, so a retry with the same command id succeeds once the
 * fact clears. A mismatched or malformed fact is denied. A recorded `hold`
 * decision is different: it is a real validator outcome and is persisted.
 *
 * Idempotency: the exact command bytes are hashed into the receipt. A
 * replay reconstructs the original record from the event log and canonical
 * snapshot AFTER the current Retro role, scope and user-intent gates, and
 * writes nothing. A new command id for the same evaluation and the same
 * identity returns the original record through an alias receipt (no event,
 * revision or counter of its own). One evaluation id, one evidence digest,
 * and one candidate binding (target skill, source and normalized report)
 * can never be rebound: a conflicting request is denied, never overwritten.
 * The 64-record bound never prunes an old outcome; a full array denies.
 *
 * Both private callbacks are checked after every SQL yield and immediately
 * before commit, over a detached, deep-frozen snapshot of the producer's
 * facts, so a revoked authority, a drifted fact, or a callback that tries to
 * mutate what it inspects rolls the whole transaction back.
 */
export class MissionRetroSkillEvaluationStoreError extends Schema.TaggedError<MissionRetroSkillEvaluationStoreError>()(
  "MissionRetroSkillEvaluationStoreError",
  {
    category: Schema.Literals([
      "scope_denied",
      "invalid_command",
      "request_conflict",
      "binding_conflict",
      "bound_exceeded",
      "persistence",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Mission retro skill evaluation failed (${this.category}).`;
  }
}

/**
 * A finite, non-persisted hold: the evaluation is not safe or not proven
 * yet. Distinct from a recorded `hold` decision, which is a validator
 * outcome that IS persisted.
 */
export class MissionRetroSkillEvaluationHold extends Schema.TaggedError<MissionRetroSkillEvaluationHold>()(
  "MissionRetroSkillEvaluationHold",
  {
    code: Schema.Literals([
      "facts_unknown",
      "mission_inactive",
      "user_stop",
      "user_pause",
      "report_ineligible",
      "evidence_unverified",
    ]),
  },
) {
  override get message() {
    return `Skill evaluation held (${this.code}); nothing was recorded.`;
  }
}

/** Receipt command type for skill-evaluation records. */
export const MISSION_RETRO_SKILL_EVALUATION_COMMAND_TYPE = "mission.retro-skill-evaluation-record";

/**
 * Strict identity-only command. No caller-owned verdict, boolean, hash,
 * reviewer or authority is accepted: excess fields are rejected, never
 * stripped.
 */
export interface MissionRetroSkillEvaluationRecordCommand {
  readonly commandId: CommandId;
  readonly missionId: string;
  /** Canonical revision the caller read; a stale value is a request conflict. */
  readonly expectedRevision: number;
  readonly evaluationId: string;
  readonly candidateId: string;
  /** `skill-replay-evidence:<sha256>`; must equal the digest the producer verified. */
  readonly evidenceArtifactRef: string;
  readonly evidenceArtifactSha: string;
}

/**
 * Required private Retro role authority. Binds the actual team, environment,
 * Retro thread and epoch from the trusted root; `isCurrent` is a pure
 * synchronous check (no I/O), so revocation after any yield denies with
 * rollback.
 */
export class MissionRetroSkillEvaluationAuthority extends Context.Service<
  MissionRetroSkillEvaluationAuthority,
  {
    readonly teamId: string;
    readonly environmentId: string;
    readonly retroThreadId: string;
    readonly retroEpoch: number;
    readonly isCurrent: () => boolean;
  }
>()("t3/orchestration-v2/MissionRetroSkillEvaluationStore/MissionRetroSkillEvaluationAuthority") {}

const BoundedId = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const Counter = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));

/**
 * What the producer proves about the immutable replay-evidence artifact.
 * `verified` means it re-read the artifact bytes and their SHA-256 equals
 * `artifactSha`; `mismatch` means it read them and they differ; `unknown`
 * means it could not check. `binding` is the identity the verified artifact
 * carries, compared field by field with what this store derives itself.
 */
const EvidenceVerification = Schema.Struct({
  artifactRef: SkillEvaluationEvidenceArtifactRef,
  artifactSha: Sha256Hex,
  verification: Schema.Literals(["verified", "mismatch", "unknown"]),
  binding: Schema.Struct({
    teamId: RetroId,
    environmentId: RetroId,
    missionId: RetroId,
    retroEpoch: Counter,
    sourceReportHash: Sha256Hex,
    normalizedReportHash: Sha256Hex,
    candidateId: RetroId,
    evaluationId: RetroId,
    targetSkillRef: SkillEvaluationTargetSkillRef,
    oldSkillSha256: Sha256Hex,
    newSkillSha256: Sha256Hex,
  }),
});

/**
 * Trusted captured facts, produced ONLY by the required private producer.
 * `candidate` is the untrusted worker body and `context` the separately
 * trusted replay context; both go to the existing pure validator unchanged.
 * `fence` is the producer revision token its synchronous currency check
 * compares. An absent or null `evaluation` section is unknown and holds a
 * new record; an exact replay does not need it.
 */
const SkillEvaluationFactsSchema = Schema.Struct({
  teamId: RetroId,
  environmentId: RetroId,
  missionId: RetroId,
  /** Canonical Retro manager the producer saw, with the canonical revision it saw it at. */
  retroThreadId: BoundedId,
  retroEpoch: Counter,
  observedRevision: Counter,
  userStopRequested: Schema.NullOr(Schema.Boolean),
  userPauseRequested: Schema.NullOr(Schema.Boolean),
  evaluation: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        candidate: Schema.Unknown,
        context: Schema.Unknown,
        evidence: EvidenceVerification,
      }),
    ),
  ),
  fence: BoundedId,
});
export type MissionRetroSkillEvaluationFacts = typeof SkillEvaluationFactsSchema.Type;

/** Identity the producer is asked about; a detached copy of the strict command. */
export interface MissionRetroSkillEvaluationFactsRequest {
  readonly missionId: string;
  readonly evaluationId: string;
  readonly candidateId: string;
  readonly evidenceArtifactRef: string;
  readonly evidenceArtifactSha: string;
}

/**
 * Required private evaluation facts producer. No default producer.
 * `readFacts` runs OUTSIDE the owning SQL transaction; `isCurrent` is a pure
 * synchronous check used before and after every own-SQL yield.
 */
export class MissionRetroSkillEvaluationProducer extends Context.Service<
  MissionRetroSkillEvaluationProducer,
  {
    readonly readFacts: (
      request: MissionRetroSkillEvaluationFactsRequest,
    ) => Effect.Effect<MissionRetroSkillEvaluationFacts, MissionRetroSkillEvaluationStoreError>;
    readonly isCurrent: (facts: MissionRetroSkillEvaluationFacts) => boolean;
  }
>()("t3/orchestration-v2/MissionRetroSkillEvaluationStore/MissionRetroSkillEvaluationProducer") {}

export interface MissionRetroSkillEvaluationOutcome {
  /** The stored receipt. Reviewable at most; never effective, promoted, or installed. */
  readonly record: EvaluationRecord;
  /** The canonical origin report this record is bound to. */
  readonly report: {
    readonly checkpointId: string;
    readonly reportRevision: number;
  };
  readonly receipt: Receipts.OrchestrationCommandReceipt;
  /** True only when a fresh event, revision and accepted receipt committed. */
  readonly committed: boolean;
  /** True when the record was reconstructed from a durable receipt (exact replay or alias). */
  readonly recovered: boolean;
  readonly eventSequence: number;
}

export type MissionRetroSkillEvaluationResult = Result.Result<
  MissionRetroSkillEvaluationOutcome,
  MissionRetroSkillEvaluationHold
>;

export class MissionRetroSkillEvaluationStore extends Context.Service<
  MissionRetroSkillEvaluationStore,
  {
    readonly record: (
      command: MissionRetroSkillEvaluationRecordCommand,
    ) => Effect.Effect<MissionRetroSkillEvaluationResult, MissionRetroSkillEvaluationStoreError>;
  }
>()("t3/orchestration-v2/MissionRetroSkillEvaluationStore") {}

const RecordCommandSchema = Schema.Struct({
  commandId: CommandId.check(Schema.isMaxLength(512)),
  missionId: RetroId,
  expectedRevision: Counter,
  evaluationId: RetroId,
  candidateId: RetroId,
  evidenceArtifactRef: SkillEvaluationEvidenceArtifactRef,
  evidenceArtifactSha: Sha256Hex,
}).check(
  Schema.makeFilter(
    (command) =>
      command.evidenceArtifactRef === `skill-replay-evidence:${command.evidenceArtifactSha}`,
    { expected: "an evidence pointer that carries exactly the recorded evidence digest" },
  ),
);
type DecodedCommand = typeof RecordCommandSchema.Type;

/** Only the validator-independent view of the trusted context this store binds. */
const ContextView = Schema.Struct({
  scope: Schema.Struct({
    teamId: RetroId,
    environmentId: RetroId,
    originMissionId: RetroId,
    candidateId: RetroId,
    targetSkillRef: SkillEvaluationTargetSkillRef,
    sourceReportHash: Sha256Hex,
    normalizedReportHash: Sha256Hex,
  }),
  reviewerId: SkillEvaluationReviewerRef,
  oldSnapshotDigest: Sha256Hex,
  newSnapshotDigest: Sha256Hex,
});

const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));
const encodeMission = Schema.encodeEffect(Schema.fromJsonString(Mission));
const decodeRecord = Schema.decodeUnknownEffect(EvaluationRecordSchema);
const decodeCommand = Schema.decodeUnknownEffect(RecordCommandSchema, {
  onExcessProperty: "error",
});
const decodeFacts = Schema.decodeUnknownEffect(SkillEvaluationFactsSchema, {
  onExcessProperty: "error",
});
const decodeContextView = Schema.decodeUnknownEffect(ContextView);
const isStoreError = Schema.is(MissionRetroSkillEvaluationStoreError);

/** Hash of the exact strict command bytes plus the authenticated scope. */
const requestHashFor = (
  scope: {
    readonly teamId: string;
    readonly environmentId: string;
  },
  command: DecodedCommand,
): string =>
  NodeCrypto.createHash("sha256")
    .update(
      stableStringify({
        operation: "record",
        teamId: scope.teamId,
        environmentId: scope.environmentId,
        command: {
          candidateId: command.candidateId,
          commandId: command.commandId,
          evaluationId: command.evaluationId,
          evidenceArtifactRef: command.evidenceArtifactRef,
          evidenceArtifactSha: command.evidenceArtifactSha,
          expectedRevision: command.expectedRevision,
          missionId: command.missionId,
        },
      }),
    )
    .digest("hex");

/** Freeze a decoded snapshot in place. Visited tracking keeps a cyclic body finite. */
const deepFreeze = (value: unknown, seen: WeakSet<object> = new WeakSet()): void => {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  Object.freeze(value);
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authoritySvc = yield* MissionRetroSkillEvaluationAuthority;
  const producer = yield* MissionRetroSkillEvaluationProducer;
  const events = yield* EventStore.OrchestrationEventStore;
  const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;

  // Snapshot the private authority ONCE before any yield; keep only the pure
  // synchronous currency check by reference.
  const authority = Object.freeze({
    teamId: authoritySvc.teamId,
    environmentId: authoritySvc.environmentId,
    retroThreadId: authoritySvc.retroThreadId,
    retroEpoch: authoritySvc.retroEpoch,
  });
  const authorityIsCurrent = (): boolean => {
    try {
      return authoritySvc.isCurrent() === true;
    } catch {
      return false;
    }
  };
  const factsIsCurrent = (facts: MissionRetroSkillEvaluationFacts): boolean => {
    try {
      return producer.isCurrent(facts) === true;
    } catch {
      return false;
    }
  };
  /** Both private callbacks must still be current. */
  const stillCurrent = (facts: MissionRetroSkillEvaluationFacts): boolean =>
    authorityIsCurrent() && factsIsCurrent(facts);

  const toStoreError = (cause: unknown): MissionRetroSkillEvaluationStoreError =>
    isStoreError(cause)
      ? cause
      : new MissionRetroSkillEvaluationStoreError({ category: "persistence", cause });
  const failure = (category: MissionRetroSkillEvaluationStoreError["category"]) =>
    new MissionRetroSkillEvaluationStoreError({ category });
  const hold = (code: MissionRetroSkillEvaluationHold["code"]) =>
    Result.fail(new MissionRetroSkillEvaluationHold({ code }));

  /** Origin report pointer for a record, or null when the canonical receipt is gone. */
  const reportPointer = (canonical: Mission, record: EvaluationRecord) => {
    const receipt = missionRetroReportReceipts(canonical.execution ?? emptyMissionExecution()).find(
      (entry) =>
        entry.sourceReportHash === record.sourceReportHash &&
        entry.normalizedReportHash === record.normalizedReportHash &&
        entry.teamId === record.teamId &&
        entry.environmentId === record.environmentId &&
        entry.missionId === record.missionId,
    );
    return receipt === undefined
      ? null
      : { checkpointId: receipt.checkpointId, reportRevision: receipt.reportRevision };
  };

  /**
   * The original committed record and event for an evaluation id, with the
   * snapshot copy checked against the event copy so a rewritten or lost
   * record is a persistence failure rather than a silent success.
   */
  const originalOf = Effect.fn("MissionRetroSkillEvaluationStore.originalOf")(function* (
    canonical: Mission,
    evaluationId: string,
    sequence: number | null,
  ) {
    const stored = missionRetroSkillEvaluations(
      canonical.execution ?? emptyMissionExecution(),
    ).find((entry) => entry.evaluationId === evaluationId);
    const logged = yield* events.readMissionEvents(canonical.id);
    const event = logged.find(
      (entry): entry is MissionRetroSkillEvaluatedEvent =>
        entry.type === "mission.retro-skill-evaluated" &&
        (sequence === null
          ? entry.payload.evaluationId === evaluationId
          : entry.sequence === sequence),
    );
    if (stored === undefined || event === undefined) return yield* failure("persistence");
    const original = missionRetroSkillEvaluations(
      event.payload.mission.execution ?? emptyMissionExecution(),
    ).find((entry) => entry.evaluationId === event.payload.evaluationId);
    if (
      event.payload.evaluationId !== stored.evaluationId ||
      original === undefined ||
      stableStringify(original) !== stableStringify(stored)
    ) {
      return yield* failure("persistence");
    }
    return { record: stored, event };
  });

  const recordTransaction = Effect.fn("MissionRetroSkillEvaluationStore.recordTransaction")(
    function* (
      command: DecodedCommand,
      requestHash: string,
      facts: MissionRetroSkillEvaluationFacts,
    ) {
      if (!stillCurrent(facts)) return yield* failure("scope_denied");
      const rows = yield* sql<{ revision: number; snapshot_json: string }>`
        SELECT revision, snapshot_json FROM projection_missions
        WHERE mission_id = ${command.missionId}
          AND team_id = ${authority.teamId}
          AND authority_environment_id = ${authority.environmentId}
      `;
      if (rows[0] === undefined) return yield* failure("scope_denied");
      const canonical = yield* decodeMission(rows[0].snapshot_json).pipe(
        Effect.mapError(toStoreError),
      );
      if (
        rows[0].revision !== canonical.revision ||
        canonical.teamId !== authority.teamId ||
        canonical.authorityEnvironmentId !== authority.environmentId
      ) {
        return yield* failure("persistence");
      }
      if (!stillCurrent(facts)) return yield* failure("scope_denied");

      // The current Retro role is the only role that may record. The producer
      // must describe the ACTUAL canonical manager, epoch and revision.
      const retro = canonical.managers.retro;
      if (
        retro?.threadId === undefined ||
        retro.epoch === undefined ||
        retro.threadId !== authority.retroThreadId ||
        retro.epoch !== authority.retroEpoch ||
        facts.teamId !== authority.teamId ||
        facts.environmentId !== authority.environmentId ||
        facts.missionId !== canonical.id ||
        facts.retroThreadId !== retro.threadId ||
        facts.retroEpoch !== retro.epoch
      ) {
        return yield* failure("scope_denied");
      }
      if (facts.observedRevision !== canonical.revision) return yield* failure("request_conflict");

      // Mission status and user intent gate EVERY branch, replay included,
      // before any receipt lookup: a replay never returns an authorizing
      // outcome under a pause or stop.
      if (canonical.status !== "active") return hold("mission_inactive");
      if (facts.userStopRequested === null || facts.userPauseRequested === null) {
        return hold("facts_unknown");
      }
      if (facts.userStopRequested) return hold("user_stop");
      if (facts.userPauseRequested) return hold("user_pause");

      const prior = yield* receipts.getByCommandId({ commandId: command.commandId });
      if (!stillCurrent(facts)) return yield* failure("scope_denied");

      const execution = canonical.execution ?? emptyMissionExecution();
      const records = missionRetroSkillEvaluations(execution);
      const sameBinding = (record: EvaluationRecord): boolean =>
        record.candidateId === command.candidateId &&
        record.evidenceArtifactRef === command.evidenceArtifactRef &&
        record.evidenceArtifactSha === command.evidenceArtifactSha;

      if (Option.isSome(prior)) {
        const saved = prior.value;
        if (
          saved.commandType !== MISSION_RETRO_SKILL_EVALUATION_COMMAND_TYPE ||
          saved.aggregateKind !== "mission" ||
          saved.aggregateId !== canonical.id ||
          saved.requestHash !== requestHash
        ) {
          return yield* failure("request_conflict");
        }
        // Only accepted records are ever receipted; holds persist nothing.
        if (saved.status !== "accepted") return yield* failure("persistence");
        const { record, event } = yield* originalOf(
          canonical,
          command.evaluationId,
          saved.resultSequence,
        );
        const report = reportPointer(canonical, record);
        if (
          report === null ||
          record.evaluationId !== command.evaluationId ||
          !sameBinding(record) ||
          record.teamId !== authority.teamId ||
          record.environmentId !== authority.environmentId ||
          record.missionId !== canonical.id
        ) {
          return yield* failure("persistence");
        }
        if (!stillCurrent(facts)) return yield* failure("scope_denied");
        return Result.succeed({
          record,
          report,
          receipt: saved,
          committed: false,
          recovered: true,
          eventSequence: event.sequence,
        } satisfies MissionRetroSkillEvaluationOutcome);
      }

      const existing = records.find((entry) => entry.evaluationId === command.evaluationId);
      if (existing !== undefined) {
        // A new command id for an evaluation that already exists: identical
        // identity is the same evaluation; anything else is a conflict.
        if (!sameBinding(existing)) return yield* failure("binding_conflict");
        const { record, event } = yield* originalOf(canonical, command.evaluationId, null);
        const report = reportPointer(canonical, record);
        if (report === null) return yield* failure("persistence");
        const alias: Receipts.OrchestrationCommandReceipt = {
          commandId: command.commandId,
          aggregateKind: "mission",
          aggregateId: canonical.id,
          commandType: MISSION_RETRO_SKILL_EVALUATION_COMMAND_TYPE,
          acceptedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
          resultSequence: event.sequence,
          status: "accepted",
          error: null,
          requestHash,
        };
        if (!(yield* receipts.insertIfAbsent(alias))) return yield* failure("request_conflict");
        if (!stillCurrent(facts)) return yield* failure("scope_denied");
        return Result.succeed({
          record,
          report,
          receipt: alias,
          committed: false,
          recovered: true,
          eventSequence: event.sequence,
        } satisfies MissionRetroSkillEvaluationOutcome);
      }

      // A fresh record from here on.
      if (command.expectedRevision !== canonical.revision)
        return yield* failure("request_conflict");
      const evaluation = facts.evaluation;
      if (evaluation === undefined || evaluation === null) return hold("facts_unknown");
      const view = yield* decodeContextView(evaluation.context).pipe(
        Effect.mapError(() => failure("scope_denied")),
      );
      const { scope } = view;
      const { evidence } = evaluation;
      // The context, the evidence pointer and the verified artifact binding
      // must all describe exactly this scope, candidate and evaluation.
      const expectedBinding = {
        teamId: authority.teamId,
        environmentId: authority.environmentId,
        missionId: canonical.id,
        retroEpoch: retro.epoch,
        sourceReportHash: scope.sourceReportHash,
        normalizedReportHash: scope.normalizedReportHash,
        candidateId: command.candidateId,
        evaluationId: command.evaluationId,
        targetSkillRef: scope.targetSkillRef,
        oldSkillSha256: view.oldSnapshotDigest,
        newSkillSha256: view.newSnapshotDigest,
      };
      if (
        scope.teamId !== authority.teamId ||
        scope.environmentId !== authority.environmentId ||
        scope.originMissionId !== canonical.id ||
        scope.candidateId !== command.candidateId ||
        evidence.artifactRef !== command.evidenceArtifactRef ||
        evidence.artifactSha !== command.evidenceArtifactSha ||
        stableStringify(evidence.binding) !== stableStringify(expectedBinding)
      ) {
        return yield* failure("scope_denied");
      }
      if (evidence.verification === "mismatch") return yield* failure("scope_denied");
      if (evidence.verification !== "verified") return hold("evidence_unverified");

      // The origin report must be the canonical receipt for exactly these
      // hashes, and a full, triage-ready report that carries candidates. A
      // hash only a quarantined variant carries is known but ineligible.
      const reportReceipts = missionRetroReportReceipts(execution);
      const receipt = reportReceipts.find(
        (entry) => entry.sourceReportHash === scope.sourceReportHash,
      );
      if (receipt === undefined) {
        const quarantined = reportReceipts.some((entry) =>
          entry.quarantine.some((variant) => variant.sourceReportHash === scope.sourceReportHash),
        );
        return quarantined ? hold("report_ineligible") : yield* failure("scope_denied");
      }
      if (
        receipt.normalizedReportHash !== scope.normalizedReportHash ||
        receipt.teamId !== authority.teamId ||
        receipt.environmentId !== authority.environmentId ||
        receipt.missionId !== canonical.id
      ) {
        return yield* failure("scope_denied");
      }
      if (
        receipt.disposition !== "queued_for_triage" ||
        !receipt.coverageFull ||
        receipt.verdict !== "candidates" ||
        receipt.shortlistCount < 1
      ) {
        return hold("report_ineligible");
      }

      // Never rebind: one evidence digest names one evaluation, and one
      // candidate keeps its target skill and origin report.
      if (
        records.some((entry) => entry.evidenceArtifactSha === command.evidenceArtifactSha) ||
        records.some(
          (entry) =>
            entry.candidateId === command.candidateId &&
            (entry.targetSkillRef !== scope.targetSkillRef ||
              entry.sourceReportHash !== scope.sourceReportHash ||
              entry.normalizedReportHash !== scope.normalizedReportHash),
        )
      ) {
        return yield* failure("binding_conflict");
      }
      if (records.length >= MAX_MISSION_RETRO_SKILL_EVALUATIONS) {
        return yield* failure("bound_exceeded");
      }

      // The existing pure validator decides, over the frozen captured facts.
      const decided = reconcileSkillEvaluation({
        context: evaluation.context as SkillEvaluationTrustedContext,
        candidate: evaluation.candidate,
      });
      if (Result.isFailure(decided)) return yield* failure("scope_denied");
      const decision = decided.success;
      if (!stillCurrent(facts)) return yield* failure("scope_denied");

      const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      // Decision metadata only: no detail text, pair bodies, expected
      // answers, transcripts, or fixture contents are stored.
      const record = yield* decodeRecord({
        evaluationId: command.evaluationId,
        teamId: authority.teamId,
        environmentId: authority.environmentId,
        missionId: canonical.id,
        candidateId: decision.candidateId,
        targetSkillRef: decision.targetSkillRef,
        sourceReportHash: decision.sourceReportHash,
        normalizedReportHash: decision.normalizedReportHash,
        oldSkillSha256: decision.oldSkillSha256,
        newSkillSha256: decision.newSkillSha256,
        kind: decision.kind,
        reason: decision.reason,
        failurePairs: decision.failurePairs,
        positivePairs: decision.positivePairs,
        negativePairs: decision.negativePairs,
        uncertainty: decision.uncertainty,
        evidenceArtifactRef: command.evidenceArtifactRef,
        evidenceArtifactSha: command.evidenceArtifactSha,
        reviewerRef: view.reviewerId,
        recordedByThreadId: authority.retroThreadId,
        retroEpoch: retro.epoch,
        recordedAt: now,
      }).pipe(Effect.mapError(() => failure("persistence")));
      if (record.candidateId !== command.candidateId) return yield* failure("persistence");

      const updated: Mission = {
        ...canonical,
        revision: canonical.revision + 1,
        execution: { ...execution, retroSkillEvaluations: [...records, record] },
        updatedAt: now,
      };
      const event: MissionRetroSkillEvaluatedEvent = {
        sequence: 0,
        eventId: EventId.make(NodeCrypto.randomUUID()),
        aggregateKind: "mission",
        aggregateId: canonical.id,
        occurredAt: now,
        commandId: command.commandId,
        metadata: {},
        type: "mission.retro-skill-evaluated",
        payload: { mission: updated, evaluationId: record.evaluationId },
      };
      const stored = yield* events.appendMissionEvent(event);
      if (!stillCurrent(facts)) return yield* failure("scope_denied");
      const snapshot = yield* encodeMission(updated);
      const cas = yield* sql<{ mission_id: string }>`
        UPDATE projection_missions
        SET revision = ${updated.revision}, snapshot_json = ${snapshot}, updated_at = ${now}
        WHERE mission_id = ${canonical.id}
          AND team_id = ${authority.teamId}
          AND authority_environment_id = ${authority.environmentId}
          AND revision = ${canonical.revision}
        RETURNING mission_id
      `;
      if (cas.length === 0) return yield* failure("request_conflict");
      if (!stillCurrent(facts)) return yield* failure("scope_denied");
      const committedReceipt: Receipts.OrchestrationCommandReceipt = {
        commandId: command.commandId,
        aggregateKind: "mission",
        aggregateId: canonical.id,
        commandType: MISSION_RETRO_SKILL_EVALUATION_COMMAND_TYPE,
        acceptedAt: now,
        resultSequence: stored.sequence,
        status: "accepted",
        error: null,
        requestHash,
      };
      if (!(yield* receipts.insertIfAbsent(committedReceipt))) {
        return yield* failure("request_conflict");
      }
      // Final revocation check: rolling back here undoes event, CAS, and receipt.
      if (!stillCurrent(facts)) return yield* failure("scope_denied");
      return Result.succeed({
        record,
        report: { checkpointId: receipt.checkpointId, reportRevision: receipt.reportRevision },
        receipt: committedReceipt,
        committed: true,
        recovered: false,
        eventSequence: stored.sequence,
      } satisfies MissionRetroSkillEvaluationOutcome);
    },
  );

  const record = Effect.fn("MissionRetroSkillEvaluationStore.record")(function* (
    input: MissionRetroSkillEvaluationRecordCommand,
  ) {
    // Detach exactly once; clone-unsafe or malformed input is a finite error.
    const detached = yield* Effect.try({
      try: () => structuredClone(input),
      catch: (cause) =>
        new MissionRetroSkillEvaluationStoreError({ category: "invalid_command", cause }),
    });
    const command = yield* decodeCommand(detached).pipe(
      Effect.mapError(
        (cause) =>
          new MissionRetroSkillEvaluationStoreError({ category: "invalid_command", cause }),
      ),
    );
    if (!authorityIsCurrent()) return yield* failure("scope_denied");
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
      return yield* failure("persistence");
    }
    // Trusted facts are read OUTSIDE the owning SQL transaction, then
    // detached, decoded and deep-frozen so later port mutation cannot alter
    // the bound facts and a currency callback cannot rewrite them.
    const rawFacts = yield* Effect.suspend(() =>
      producer.readFacts({
        missionId: command.missionId,
        evaluationId: command.evaluationId,
        candidateId: command.candidateId,
        evidenceArtifactRef: command.evidenceArtifactRef,
        evidenceArtifactSha: command.evidenceArtifactSha,
      }),
    ).pipe(Effect.catchDefect((cause) => Effect.fail(toStoreError(cause))));
    const facts = yield* Effect.try({
      try: () => structuredClone(rawFacts),
      catch: () => failure("scope_denied"),
    }).pipe(
      Effect.flatMap((cloned) =>
        decodeFacts(cloned).pipe(Effect.mapError(() => failure("scope_denied"))),
      ),
      Effect.tap((decoded) =>
        Effect.try({ try: () => deepFreeze(decoded), catch: () => failure("scope_denied") }),
      ),
    );
    if (!stillCurrent(facts)) return yield* failure("scope_denied");
    const requestHash = requestHashFor(authority, command);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const outcome = yield* recordTransaction(command, requestHash, facts);
          // Every branch, including replays and holds, is fenced at the
          // owning transaction boundary.
          if (!stillCurrent(facts)) return yield* failure("scope_denied");
          return outcome;
        }),
      )
      .pipe(Effect.mapError(toStoreError));
  });

  return MissionRetroSkillEvaluationStore.of({
    record: (command) => record(command).pipe(Effect.mapError(toStoreError)),
  });
});

export const layer = Layer.effect(MissionRetroSkillEvaluationStore, make);

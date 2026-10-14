// @effect-diagnostics nodeBuiltinImport:off -- cryptographic server tokens and request/event identities bind durable lease ownership.
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
  type MissionRetroAnalysisUpdatedEvent,
} from "../../../../packages/contracts/src/mission.ts";
import { emptyMissionExecution } from "../../../../packages/contracts/src/missionExecution.ts";
import {
  ELIGIBLE_RETRO_COMPANY,
  REQUESTED_RETRO_REPORTER,
  RetroId,
  Sha256Hex,
  type MissionRetroCheckpoint,
} from "../../../../packages/contracts/src/missionRetro.ts";
import {
  MAX_MISSION_RETRO_ANALYSES,
  MissionRetroAnalysis,
  type MissionRetroAnalysis as Analysis,
} from "../../../../packages/contracts/src/missionRetroAnalysis.ts";
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

export class MissionRetroAnalysisStoreError extends Schema.TaggedError<MissionRetroAnalysisStoreError>()(
  "MissionRetroAnalysisStoreError",
  {
    operation: Schema.Literals(["claim", "settle"]),
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
    return `Mission retro analysis ${this.operation} failed (${this.category}).`;
  }
}
export class MissionRetroAnalysisRejection extends Schema.TaggedError<MissionRetroAnalysisRejection>()(
  "MissionRetroAnalysisRejection",
  {
    operation: Schema.Literals(["claim", "settle"]),
    code: Schema.Literals([
      "checkpoint_missing",
      "source_mismatch",
      "analysis_bound",
      "already_owned",
      "already_settled",
      "terminal_denied",
      "mission_inactive",
    ]),
  },
) {
  override get message() {
    return `Mission retro analysis denied (${this.code}).`;
  }
}

const Common = {
  commandId: CommandId,
  missionId: RetroId,
  checkpointId: RetroId,
  expectedRevision: NonNegativeInt,
  retroEpoch: NonNegativeInt,
};
const ClaimCommand = Schema.Struct(Common);
const Binding = Schema.Struct({
  assignmentToken: Sha256Hex,
  fence: NonNegativeInt,
  attemptNumber: NonNegativeInt,
  reporterChildThreadId: RetroId,
  reporterRunId: RetroId,
  hostId: RetroId,
  bootId: RetroId,
});
const SettleCommand = Schema.Struct({ ...Common, ...Binding.fields });
export type MissionRetroAnalysisClaimCommand = typeof ClaimCommand.Type;
export type MissionRetroAnalysisSettleCommand = typeof SettleCommand.Type;
export type MissionRetroAnalysisCheckpoint = MissionRetroCheckpoint;

interface TrustedScope {
  readonly teamId: string;
  readonly environmentId: string;
  readonly missionId: string;
  readonly checkpointId: string;
  readonly retroThreadId: string;
  readonly retroEpoch: number;
  readonly nowMs: number;
  readonly maxFactAgeMs: number;
}
/** Server observations only. Account/company/route and prepared identities are never caller assertions. */
export interface MissionRetroAnalysisClaimFacts extends TrustedScope {
  readonly sourceThreadId: string;
  readonly sourceRoot: string;
  readonly snapshotFingerprint: string;
  readonly coveredFromInclusive: number;
  readonly coveredToExclusive: number;
  readonly leaseDurationMs: number;
  readonly capacity: {
    readonly ready: boolean;
    readonly exhausted: boolean;
    readonly lowReserve: boolean;
    readonly verified: boolean;
    readonly company: string | null;
    readonly accountId: string | null;
    readonly providerInstanceId: string | null;
    readonly modelId: string | null;
    readonly profile: string | null;
    readonly observedAtMs: number;
    readonly accountRef: string | null;
    readonly providerRef: string | null;
    readonly capacityRef: string | null;
  };
  readonly host: {
    readonly hostId: string;
    readonly bootId: string;
    readonly verified: boolean;
    readonly interactivePressureVerified: boolean;
    readonly pressureReady: boolean;
    readonly buildVerified: boolean;
    readonly productiveWorkPriority: boolean;
    readonly observedAtMs: number;
    readonly hostRef: string | null;
    readonly buildRef: string | null;
    readonly priorityRef: string | null;
  };
  readonly prepared: {
    readonly reporterChildThreadId: string;
    readonly reporterRunId: string;
    readonly verified: boolean;
    readonly receiptRef: string | null;
  };
}
export interface MissionRetroAnalysisTerminalFacts extends TrustedScope {
  readonly binding: typeof Binding.Type;
  readonly verified: boolean;
  readonly status: "succeeded" | "failed" | "cancelled" | "not_started" | "uncertain";
  readonly receiptRef: string | null;
  readonly observedAtMs: number;
}
export class MissionRetroAnalysisFactsPort extends Context.Service<
  MissionRetroAnalysisFactsPort,
  {
    readonly readClaimFacts: (
      command: MissionRetroAnalysisClaimCommand,
      checkpoint: MissionRetroAnalysisCheckpoint,
    ) => Effect.Effect<MissionRetroAnalysisClaimFacts, MissionRetroAnalysisStoreError>;
    readonly readTerminalFacts: (
      command: MissionRetroAnalysisSettleCommand,
      analysis: Analysis | null,
    ) => Effect.Effect<MissionRetroAnalysisTerminalFacts, MissionRetroAnalysisStoreError>;
  }
>()("t3/orchestration-v2/MissionRetroAnalysisStore/MissionRetroAnalysisFactsPort") {}

export interface MissionRetroAnalysisOutcome {
  readonly analysis: Analysis;
  readonly receipt: Receipts.OrchestrationCommandReceipt;
  readonly recovered: boolean;
  readonly committed: boolean;
  readonly eventSequence: number;
  /** Always dormant. Reservation alone cannot authorize provider dispatch. */
  readonly dispatcherStatus: "unregistered";
}
export type MissionRetroAnalysisResult = Result.Result<
  MissionRetroAnalysisOutcome,
  MissionRetroAnalysisRejection
>;
/**
 * Dormant lease service. SAME mission event/projection/receipt transaction, no new store or worker.
 * Expiry/restart never releases a slot. Only an authoritative exact terminal ACK does.
 * Failed/not-started retries remain held; root must bind dispatch/outbox and report acceptance later.
 */
export class MissionRetroAnalysisStore extends Context.Service<
  MissionRetroAnalysisStore,
  {
    readonly claim: (
      command: MissionRetroAnalysisClaimCommand,
    ) => Effect.Effect<MissionRetroAnalysisResult, MissionRetroAnalysisStoreError>;
    readonly settle: (
      command: MissionRetroAnalysisSettleCommand,
    ) => Effect.Effect<MissionRetroAnalysisResult, MissionRetroAnalysisStoreError>;
  }
>()("t3/orchestration-v2/MissionRetroAnalysisStore") {}

const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));
const encodeMission = Schema.encodeEffect(Schema.fromJsonString(Mission));
const encodeRejection = Schema.encodeEffect(Schema.fromJsonString(MissionRetroAnalysisRejection));
const decodeRejection = Schema.decodeUnknownEffect(
  Schema.fromJsonString(MissionRetroAnalysisRejection),
);
const isStoreError = Schema.is(MissionRetroAnalysisStoreError);
const decodeAnalysis = Schema.decodeUnknownEffect(MissionRetroAnalysis);
const decodeClaimCommand = Schema.decodeUnknownEffect(ClaimCommand, { onExcessProperty: "error" });
const decodeSettleCommand = Schema.decodeUnknownEffect(SettleCommand, {
  onExcessProperty: "error",
});
const isId = Schema.is(RetroId);
const MAX_SCOPE_MISSIONS = 1024;
const MAX_FACT_AGE_MS = 60_000;
const MAX_LEASE_MS = 900_000;
const sourceMatches = (
  a: MissionRetroAnalysisCheckpoint,
  b: Pick<
    Analysis,
    | "checkpointId"
    | "teamId"
    | "environmentId"
    | "missionId"
    | "sourceThreadId"
    | "sourceRoot"
    | "snapshotFingerprint"
    | "coveredFromInclusive"
    | "coveredToExclusive"
  >,
): boolean =>
  a.checkpointId === b.checkpointId &&
  a.teamId === b.teamId &&
  a.environmentId === b.environmentId &&
  a.missionId === b.missionId &&
  a.sourceThreadId === b.sourceThreadId &&
  a.sourceRoot === b.sourceRoot &&
  a.snapshotFingerprint === b.snapshotFingerprint &&
  a.coveredFromInclusive === b.coveredFromInclusive &&
  a.coveredToExclusive === b.coveredToExclusive;
const bindingFor = (record: Analysis): typeof Binding.Type | null =>
  record.lease === null
    ? null
    : {
        assignmentToken: record.lease.assignmentToken,
        fence: record.fence,
        attemptNumber: record.attemptNumber,
        reporterChildThreadId: record.lease.reporterChildThreadId,
        reporterRunId: record.lease.reporterRunId,
        hostId: record.lease.hostId,
        bootId: record.lease.bootId,
      };
const commandBinding = (command: MissionRetroAnalysisSettleCommand): typeof Binding.Type => ({
  assignmentToken: command.assignmentToken,
  fence: command.fence,
  attemptNumber: command.attemptNumber,
  reporterChildThreadId: command.reporterChildThreadId,
  reporterRunId: command.reporterRunId,
  hostId: command.hostId,
  bootId: command.bootId,
});
const fresh = (observedAtMs: number, nowMs: number, maxAgeMs: number): boolean =>
  Number.isFinite(nowMs) &&
  nowMs >= 0 &&
  Number.isFinite(maxAgeMs) &&
  maxAgeMs > 0 &&
  maxAgeMs <= MAX_FACT_AGE_MS &&
  Number.isFinite(observedAtMs) &&
  observedAtMs >= 0 &&
  observedAtMs <= nowMs &&
  nowMs - observedAtMs <= maxAgeMs;
const ready = (facts: MissionRetroAnalysisClaimFacts, nowMs: number): boolean => {
  const c = facts.capacity;
  const h = facts.host;
  const p = facts.prepared;
  return (
    fresh(facts.nowMs, nowMs, facts.maxFactAgeMs) &&
    fresh(c.observedAtMs, nowMs, facts.maxFactAgeMs) &&
    fresh(h.observedAtMs, nowMs, facts.maxFactAgeMs) &&
    c.ready &&
    c.verified &&
    !c.exhausted &&
    !c.lowReserve &&
    c.company === ELIGIBLE_RETRO_COMPANY &&
    isId(c.accountId) &&
    isId(c.accountRef) &&
    isId(c.providerRef) &&
    isId(c.capacityRef) &&
    (c.providerInstanceId === "muse-personal" ||
      c.providerInstanceId === "muse-backstage-support") &&
    c.modelId === REQUESTED_RETRO_REPORTER &&
    c.profile === "muse-review" &&
    h.verified &&
    h.interactivePressureVerified &&
    h.pressureReady &&
    h.buildVerified &&
    h.productiveWorkPriority &&
    isId(h.hostId) &&
    isId(h.bootId) &&
    isId(h.hostRef) &&
    isId(h.buildRef) &&
    isId(h.priorityRef) &&
    p.verified &&
    isId(p.receiptRef) &&
    isId(p.reporterChildThreadId) &&
    isId(p.reporterRunId) &&
    p.reporterChildThreadId !== facts.sourceThreadId &&
    p.reporterChildThreadId !== facts.retroThreadId &&
    Number.isFinite(facts.leaseDurationMs) &&
    facts.leaseDurationMs > 0 &&
    facts.leaseDurationMs <= MAX_LEASE_MS
  );
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authority = yield* MissionAuthority;
  const events = yield* EventStore.OrchestrationEventStore;
  const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
  const port = yield* MissionRetroAnalysisFactsPort;
  type Operation = "claim" | "settle";
  type Command = MissionRetroAnalysisClaimCommand | MissionRetroAnalysisSettleCommand;
  const mapError = (operation: Operation) => (cause: unknown) =>
    isStoreError(cause)
      ? cause
      : new MissionRetroAnalysisStoreError({ operation, category: "persistence", cause });
  const load = Effect.fn("MissionRetroAnalysisStore.load")(function* (
    operation: Operation,
    command: Command,
  ) {
    const rows = yield* sql<{
      mission_id: string;
      revision: number;
      snapshot_json: string;
    }>`SELECT mission_id, revision, snapshot_json FROM projection_missions WHERE mission_id = ${command.missionId} AND team_id = ${authority.teamId} AND authority_environment_id = ${authority.environmentId}`;
    if (rows[0] === undefined)
      return yield* new MissionRetroAnalysisStoreError({ operation, category: "scope_denied" });
    const mission = yield* decodeMission(rows[0].snapshot_json);
    if (
      mission.id !== rows[0].mission_id ||
      mission.revision !== rows[0].revision ||
      mission.teamId !== authority.teamId ||
      mission.authorityEnvironmentId !== authority.environmentId
    )
      return yield* new MissionRetroAnalysisStoreError({ operation, category: "persistence" });
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
        return cp === undefined || !sourceMatches(cp, record);
      })
    )
      return yield* new MissionRetroAnalysisStoreError({ operation, category: "persistence" });
    const manager = mission.managers.retro;
    if (
      manager?.threadId !== authority.controllerThreadId ||
      manager.epoch === undefined ||
      manager.epoch !== command.retroEpoch
    )
      return yield* new MissionRetroAnalysisStoreError({ operation, category: "scope_denied" });
    return mission;
  });
  const scopeMatches = (trusted: TrustedScope, command: Command): boolean =>
    trusted.teamId === authority.teamId &&
    trusted.environmentId === authority.environmentId &&
    trusted.missionId === command.missionId &&
    trusted.checkpointId === command.checkpointId &&
    trusted.retroThreadId === authority.controllerThreadId &&
    trusted.retroEpoch === command.retroEpoch;
  const outcome = (
    analysis: Analysis,
    receipt: Receipts.OrchestrationCommandReceipt,
    committed: boolean,
  ): MissionRetroAnalysisOutcome => ({
    analysis,
    receipt,
    committed,
    recovered: !committed,
    eventSequence: receipt.resultSequence,
    dispatcherStatus: "unregistered",
  });
  const reject = Effect.fn("MissionRetroAnalysisStore.reject")(function* (
    operation: Operation,
    command: Command,
    requestHash: string,
    code: MissionRetroAnalysisRejection["code"],
  ) {
    const failure = new MissionRetroAnalysisRejection({ operation, code });
    if (
      !(yield* receipts.insertIfAbsent({
        commandId: command.commandId,
        aggregateKind: "mission",
        aggregateId: MissionId.make(command.missionId),
        commandType: `mission.retro-analysis-${operation}`,
        acceptedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
        resultSequence: 0,
        status: "rejected",
        error: yield* encodeRejection(failure),
        requestHash,
      }))
    )
      return yield* new MissionRetroAnalysisStoreError({ operation, category: "request_conflict" });
    return Result.fail(failure);
  });
  const replay = Effect.fn("MissionRetroAnalysisStore.replay")(function* (
    operation: Operation,
    command: Command,
    requestHash: string,
  ) {
    const prior = yield* receipts.getByCommandId({ commandId: command.commandId });
    if (Option.isNone(prior)) return Option.none<MissionRetroAnalysisResult>();
    const saved = prior.value;
    if (
      saved.commandType !== `mission.retro-analysis-${operation}` ||
      saved.aggregateKind !== "mission" ||
      saved.aggregateId !== command.missionId ||
      saved.requestHash !== requestHash
    )
      return yield* new MissionRetroAnalysisStoreError({ operation, category: "request_conflict" });
    if (saved.status === "rejected") {
      if (saved.error === null)
        return yield* new MissionRetroAnalysisStoreError({ operation, category: "persistence" });
      return Option.some(Result.fail(yield* decodeRejection(saved.error)));
    }
    const logged = yield* events.readMissionEvents(MissionId.make(command.missionId));
    const event = logged.find((e) => e.sequence === saved.resultSequence);
    if (
      event?.type !== "mission.retro-analysis-updated" ||
      event.payload.operation !== operation ||
      event.payload.checkpointId !== command.checkpointId
    )
      return yield* new MissionRetroAnalysisStoreError({ operation, category: "persistence" });
    const analysis = event.payload.mission.execution?.retroAnalyses?.find(
      (r) => r.checkpointId === command.checkpointId,
    );
    if (analysis === undefined)
      return yield* new MissionRetroAnalysisStoreError({ operation, category: "persistence" });
    // Aliased receipts need not have the originating event's command id.
    return Option.some(Result.succeed(outcome(analysis, saved, false)));
  });
  const commit = Effect.fn("MissionRetroAnalysisStore.commit")(function* (
    operation: Operation,
    command: Command,
    requestHash: string,
    canonical: Mission,
    analysis: Analysis,
  ) {
    const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    const execution = canonical.execution ?? emptyMissionExecution();
    const existing = execution.retroAnalyses ?? [];
    const next = existing.some((r) => r.checkpointId === analysis.checkpointId)
      ? existing.map((r) => (r.checkpointId === analysis.checkpointId ? analysis : r))
      : [...existing, analysis];
    const updated: Mission = {
      ...canonical,
      revision: canonical.revision + 1,
      updatedAt: now,
      execution: { ...execution, retroAnalyses: next },
    };
    const event: MissionRetroAnalysisUpdatedEvent = {
      sequence: 0,
      eventId: EventId.make(NodeCrypto.randomUUID()),
      aggregateKind: "mission",
      aggregateId: canonical.id,
      occurredAt: now,
      commandId: command.commandId,
      metadata: {},
      type: "mission.retro-analysis-updated",
      payload: { mission: updated, checkpointId: command.checkpointId, operation },
    };
    const stored = yield* events.appendMissionEvent(event);
    const snapshot = yield* encodeMission(updated);
    const cas = yield* sql<{
      mission_id: string;
    }>`UPDATE projection_missions SET revision = ${updated.revision}, snapshot_json = ${snapshot}, updated_at = ${now} WHERE mission_id = ${canonical.id} AND revision = ${canonical.revision} AND team_id = ${authority.teamId} AND authority_environment_id = ${authority.environmentId} RETURNING mission_id`;
    if (cas.length !== 1)
      return yield* new MissionRetroAnalysisStoreError({ operation, category: "request_conflict" });
    const receipt: Receipts.OrchestrationCommandReceipt = {
      commandId: command.commandId,
      aggregateKind: "mission",
      aggregateId: canonical.id,
      commandType: `mission.retro-analysis-${operation}`,
      acceptedAt: now,
      resultSequence: stored.sequence,
      status: "accepted",
      error: null,
      requestHash,
    };
    if (!(yield* receipts.insertIfAbsent(receipt)))
      return yield* new MissionRetroAnalysisStoreError({ operation, category: "request_conflict" });
    return Result.succeed(outcome(analysis, receipt, true));
  });
  const transaction = Effect.fn("MissionRetroAnalysisStore.transaction")(function* (
    operation: Operation,
    command: Command,
    requestHash: string,
    trusted: MissionRetroAnalysisClaimFacts | MissionRetroAnalysisTerminalFacts | null,
    preparedAtMs: number,
  ) {
    const canonical = yield* load(operation, command);
    if (trusted !== null && !scopeMatches(trusted, command))
      return yield* new MissionRetroAnalysisStoreError({ operation, category: "scope_denied" });
    const saved = yield* replay(operation, command, requestHash);
    if (Option.isSome(saved)) return saved.value;
    if (command.expectedRevision !== canonical.revision)
      return yield* new MissionRetroAnalysisStoreError({ operation, category: "request_conflict" });
    const checkpoint = canonical.execution?.retroCheckpoints?.find(
      (cp) => cp.checkpointId === command.checkpointId,
    );
    if (checkpoint === undefined)
      return yield* reject(operation, command, requestHash, "checkpoint_missing");
    if (
      checkpoint.teamId !== authority.teamId ||
      checkpoint.environmentId !== authority.environmentId ||
      checkpoint.missionId !== canonical.id
    )
      return yield* new MissionRetroAnalysisStoreError({ operation, category: "persistence" });
    const records = canonical.execution?.retroAnalyses ?? [];
    const prior = records.find((r) => r.checkpointId === command.checkpointId);
    if (prior !== undefined && !sourceMatches(checkpoint, prior))
      return yield* new MissionRetroAnalysisStoreError({ operation, category: "persistence" });
    const clockNowMs = yield* Clock.currentTimeMillis;
    const elapsedMs = clockNowMs - preparedAtMs;
    // Facts are compared with the current commit clock after port work and lock waits.
    // Adding elapsed time to a refreshed observation would timestamp the lease in the future.
    const nowMs =
      trusted === null ||
      !Number.isFinite(elapsedMs) ||
      elapsedMs < 0 ||
      !fresh(trusted.nowMs, clockNowMs, trusted.maxFactAgeMs)
        ? Number.NaN
        : clockNowMs;
    if (operation === "settle") {
      const ack = trusted as MissionRetroAnalysisTerminalFacts | null;
      const settlementCommand = command as MissionRetroAnalysisSettleCommand;
      const expected = prior === undefined ? null : bindingFor(prior);
      if (
        prior === undefined ||
        expected === null ||
        (prior.status !== "reserved" && prior.status !== "uncertain") ||
        ack === null ||
        !ack.verified ||
        (ack.status !== "succeeded" &&
          ack.status !== "failed" &&
          ack.status !== "cancelled" &&
          ack.status !== "not_started") ||
        !isId(ack.receiptRef) ||
        !fresh(ack.observedAtMs, nowMs, ack.maxFactAgeMs) ||
        ack.observedAtMs < prior.lease!.claimedAtMs ||
        !fresh(ack.nowMs, nowMs, ack.maxFactAgeMs) ||
        stableStringify(commandBinding(settlementCommand)) !== stableStringify(expected) ||
        stableStringify(ack.binding) !== stableStringify(expected)
      )
        return yield* reject(operation, command, requestHash, "terminal_denied");
      const analysis = yield* decodeAnalysis({
        ...prior,
        status: "settled",
        settlement: {
          status: ack.status,
          receiptRef: ack.receiptRef,
          observedAtMs: ack.observedAtMs,
        },
      });
      return yield* commit(operation, command, requestHash, canonical, analysis);
    }
    if (prior?.status === "settled")
      return yield* reject(operation, command, requestHash, "already_settled");
    if (prior?.status === "reserved" || prior?.status === "uncertain")
      return yield* reject(operation, command, requestHash, "already_owned");
    if (canonical.status !== "active")
      return yield* reject(operation, command, requestHash, "mission_inactive");
    if (prior === undefined && records.length >= MAX_MISSION_RETRO_ANALYSES)
      return yield* reject(operation, command, requestHash, "analysis_bound");
    const facts = trusted as MissionRetroAnalysisClaimFacts | null;
    if (facts === null || !sourceMatches(checkpoint, facts))
      return yield* reject(operation, command, requestHash, "source_mismatch");
    const rows = yield* sql<{
      mission_id: string;
      revision: number;
      snapshot_json: string;
    }>`SELECT mission_id, revision, snapshot_json FROM projection_missions WHERE team_id = ${authority.teamId} AND authority_environment_id = ${authority.environmentId} LIMIT ${MAX_SCOPE_MISSIONS + 1}`;
    if (rows.length > MAX_SCOPE_MISSIONS)
      return yield* new MissionRetroAnalysisStoreError({ operation, category: "persistence" });
    let busy = false;
    for (const row of rows) {
      const mission = yield* decodeMission(row.snapshot_json);
      if (
        mission.id !== row.mission_id ||
        mission.revision !== row.revision ||
        mission.teamId !== authority.teamId ||
        mission.authorityEnvironmentId !== authority.environmentId
      )
        return yield* new MissionRetroAnalysisStoreError({ operation, category: "persistence" });
      for (const analysis of mission.execution?.retroAnalyses ?? []) {
        const cp = mission.execution?.retroCheckpoints?.find(
          (c) => c.checkpointId === analysis.checkpointId,
        );
        if (cp === undefined || !sourceMatches(cp, analysis))
          return yield* new MissionRetroAnalysisStoreError({ operation, category: "persistence" });
        // Boot/expiry/status of the mission cannot make an unresolved process safe to duplicate.
        if (
          (analysis.status === "reserved" || analysis.status === "uncertain") &&
          analysis.lease?.hostId === facts.host.hostId
        )
          busy = true;
      }
    }
    const canReserve = ready(facts, nowMs) && !busy;
    const base = {
      checkpointId: checkpoint.checkpointId,
      teamId: checkpoint.teamId,
      environmentId: checkpoint.environmentId,
      missionId: checkpoint.missionId,
      sourceThreadId: checkpoint.sourceThreadId,
      sourceRoot: checkpoint.sourceRoot,
      snapshotFingerprint: checkpoint.snapshotFingerprint,
      coveredFromInclusive: checkpoint.coveredFromInclusive,
      coveredToExclusive: checkpoint.coveredToExclusive,
      managerThreadId: authority.controllerThreadId,
      managerEpoch: command.retroEpoch,
    };
    const analysis = yield* decodeAnalysis(
      canReserve
        ? {
            ...base,
            status: "reserved",
            queueReason: null,
            fence: (prior?.fence ?? 0) + 1,
            attemptNumber: (prior?.attemptNumber ?? 0) + 1,
            settlement: null,
            lease: {
              assignmentToken: NodeCrypto.randomBytes(32).toString("hex"),
              reporterChildThreadId: facts.prepared.reporterChildThreadId,
              reporterRunId: facts.prepared.reporterRunId,
              hostId: facts.host.hostId,
              bootId: facts.host.bootId,
              providerInstanceId: facts.capacity.providerInstanceId,
              modelId: facts.capacity.modelId,
              profile: facts.capacity.profile,
              company: facts.capacity.company,
              accountId: facts.capacity.accountId,
              verifiedAccountRef: facts.capacity.accountRef,
              verifiedProviderRef: facts.capacity.providerRef,
              capacityRef: facts.capacity.capacityRef,
              hostRef: facts.host.hostRef,
              buildRef: facts.host.buildRef,
              priorityRef: facts.host.priorityRef,
              preparedIdentityRef: facts.prepared.receiptRef,
              claimedAtMs: nowMs,
              expiresAtMs: nowMs + facts.leaseDurationMs,
              assignmentRevision: canonical.revision + 1,
              reportRevision: 1,
            },
          }
        : {
            ...base,
            status: "queued_capacity",
            queueReason: busy ? "slot_busy" : "capacity",
            fence: 0,
            attemptNumber: 0,
            lease: null,
            settlement: null,
          },
    );
    return yield* commit(operation, command, requestHash, canonical, analysis);
  });
  const execute = Effect.fn("MissionRetroAnalysisStore.execute")(function* (
    operation: Operation,
    input: Command,
  ) {
    const command = yield* (
      operation === "claim"
        ? decodeClaimCommand(structuredClone(input))
        : decodeSettleCommand(structuredClone(input))
    ).pipe(
      Effect.mapError(
        (cause) =>
          new MissionRetroAnalysisStoreError({ operation, category: "invalid_command", cause }),
      ),
    );
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
      return yield* new MissionRetroAnalysisStoreError({ operation, category: "persistence" });
    const pre = yield* load(operation, command);
    const requestHash = NodeCrypto.createHash("sha256")
      .update(
        stableStringify({
          operation,
          teamId: authority.teamId,
          environmentId: authority.environmentId,
          controllerThreadId: authority.controllerThreadId,
          command,
        }),
      )
      .digest("hex");
    // Scope always precedes receipts. A preliminary lookup avoids facts I/O on replay;
    // transaction recovery still repeats scope/receipt checks against the latest epoch.
    const existing = yield* receipts.getByCommandId({ commandId: command.commandId });
    const preparedAtMs = yield* Clock.currentTimeMillis;
    let trusted: MissionRetroAnalysisClaimFacts | MissionRetroAnalysisTerminalFacts | null = null;
    if (Option.isNone(existing)) {
      if (operation === "claim") {
        const checkpoint = pre.execution?.retroCheckpoints?.find(
          (cp) => cp.checkpointId === command.checkpointId,
        );
        if (checkpoint !== undefined)
          trusted = structuredClone(
            yield* port.readClaimFacts(structuredClone(command), structuredClone(checkpoint)),
          );
      } else {
        const record =
          pre.execution?.retroAnalyses?.find((r) => r.checkpointId === command.checkpointId) ??
          null;
        trusted = structuredClone(
          yield* port.readTerminalFacts(
            structuredClone(command as MissionRetroAnalysisSettleCommand),
            structuredClone(record),
          ),
        );
      }
    }
    const run = () =>
      sql
        .withTransaction(transaction(operation, command, requestHash, trusted, preparedAtMs))
        .pipe(Effect.mapError(mapError(operation)));
    const first = yield* run().pipe(Effect.result);
    if (Result.isSuccess(first)) return first.success;
    if (first.failure.category !== "request_conflict") return yield* first.failure;
    return yield* run();
  });
  return MissionRetroAnalysisStore.of({
    claim: (command) => execute("claim", command).pipe(Effect.mapError(mapError("claim"))),
    settle: (command) => execute("settle", command).pipe(Effect.mapError(mapError("settle"))),
  });
});
export const layer = Layer.effect(MissionRetroAnalysisStore, make);

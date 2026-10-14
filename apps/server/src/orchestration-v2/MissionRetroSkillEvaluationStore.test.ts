// @effect-diagnostics nodeBuiltinImport:off -- test hashes fixture evidence and report bytes.
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { assert, it } from "@effect/vitest";
import { CommandId, EnvironmentId, Mission, MissionId, TeamId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { Mission as MissionValue } from "../../../../packages/contracts/src/mission.ts";
import { emptyMissionExecution } from "../../../../packages/contracts/src/missionExecution.ts";
import type { MissionRetroSourceRef as SourceRefValue } from "../../../../packages/contracts/src/missionRetro.ts";
import type { MissionRetroReport as ReportValue } from "../../../../packages/contracts/src/missionRetroReport.ts";
import * as Analysis from "./MissionRetroAnalysisStore.ts";
import * as Checkpoints from "./MissionRetroCheckpointStore.ts";
import * as MissionService from "./MissionService.ts";
import * as ReportStore from "./MissionRetroReportStore.ts";
import {
  computeRetroReportHash,
  withActualReportHash,
  type MissionRetroReportTrustedCoverage,
} from "./MissionRetroReportReconciliation.ts";
import type {
  SkillEvaluationFixtureClass,
  SkillEvaluationTrustedContext,
  SkillEvaluationTrustedObservation,
  SkillEvaluationTrustedPair,
} from "./MissionRetroSkillEvaluation.ts";
import * as SkillStore from "./MissionRetroSkillEvaluationStore.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";

/**
 * Acceptance for the durable skill-evaluation recorder. Persistence is real:
 * memory SQLite with the genuine MissionService, event store, command
 * receipts and projection. The canonical origin report is staged through the
 * genuine checkpoint, analysis and report stores (their own external ports
 * are the same fixtures the report store tests use), so the report receipts
 * are real canonical rows. The existing pure validator decides every
 * recorded outcome from valid trusted pair fixtures.
 *
 * What is fixture, not proof: the private authority and the private evaluation
 * producer. They are auth-shape and evidence-shape fixtures only. No replay
 * ran, no artifact exists on any filesystem, and `verification: "verified"`
 * is just a fixture value standing in for the real producer's receipt. A few
 * tests plant a status, a manager rotation, or extra unrelated state straight
 * into the projection row; that planted state is explicitly NOT a genuine
 * lifecycle transition. No sleeps, polling, ports, or dev servers.
 */

const sha = (text: string): string => NodeCrypto.createHash("sha256").update(text).digest("hex");

const AUTHORITY_REF = { source: "mission-council", ref: "decision" };
const BASE_COMMIT = "a".repeat(40);
const FINGERPRINT = "a".repeat(64);
const OPAQUE_THREAD =
  "thread:delegated-task:command%3Amcp%3A10f3a13b-97f3-4514-b43e-76fb9efb77d8%3Adelegate-task%3Acombined-v3-20261014-p2-skill-evaluation-01";

const decodeFixture = Schema.decodeSync(Mission);
const decodeMissionJson = Schema.decodeUnknownSync(Schema.fromJsonString(Mission));
const encodeMissionJson = Schema.encodeSync(Schema.fromJsonString(Mission));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const missionFixture = (id: string, retroThreadId: string): MissionValue =>
  decodeFixture({
    schemaVersion: 1,
    id,
    revision: 0,
    teamId: "team",
    authorityEnvironmentId: "env",
    bindings: [
      {
        projectId: "project",
        workspaceRoot: "/tmp/project",
        baseCommit: BASE_COMMIT,
        ancestry: [BASE_COMMIT],
      },
    ],
    intent: {
      outcome: "Evaluate one skill candidate.",
      scope: ["retro"],
      exclusions: [],
      authorityRefs: [AUTHORITY_REF],
      acceptanceCriteria: [{ id: "ac", text: "Record once." }],
      decisions: [],
    },
    integrationTarget: { summary: "Root" },
    managers: {
      delivery: { threadId: "delivery", epoch: 3 },
      retro: { threadId: retroThreadId, epoch: 4 },
    },
    status: "active",
    tasks: [
      {
        id: "task",
        projectId: "project",
        title: "Task",
        specHash: "spec",
        dependencyHashes: [],
        dependencies: [],
        acceptanceIds: ["ac"],
        updatedAt: "2026-10-14T00:00:00.000Z",
      },
    ],
    updatedAt: "2026-10-14T00:00:00.000Z",
  });

const chunkFor = (from: number, to: number): SourceRefValue => ({
  rootRef: "thread://origin",
  chunkRef: `chunk-${from}-${to}`,
  chunkHash: "b".repeat(64),
  coveredFromInclusive: from,
  coveredToExclusive: to,
});

type Facts = SkillStore.MissionRetroSkillEvaluationFacts;
type Outcome = SkillStore.MissionRetroSkillEvaluationOutcome;
type RecordCommand = SkillStore.MissionRetroSkillEvaluationRecordCommand;

interface World {
  facts: Facts | null;
  fence: string;
  authorityOk: boolean;
  /** The authority's synchronous currency check throws instead of answering. */
  authorityThrows: boolean;
  factsCalls: number;
  /** Exactly what the store asked the producer about, in call order. */
  requests: Array<SkillStore.MissionRetroSkillEvaluationFactsRequest>;
  coverage: Partial<MissionRetroReportTrustedCoverage>;
  /** Simulates a competing writer landing between the canonical read and the CAS. */
  bumpRevisionAfterAppend: boolean;
  /** Revokes a private callback after the named durable write. */
  revokeAfter: { readonly at: "append" | "receipt"; readonly what: "fence" | "authority" } | null;
  /** What the currency callback does to the frozen snapshot it inspects. */
  currencyProbe: "off" | "observe-frozen" | "mutate-snapshot" | "mutate-own-copy" | "throw";
  frozen: {
    readonly facts: boolean;
    readonly evaluation: boolean;
    readonly context: boolean;
    readonly pairs: boolean;
    readonly firstPair: boolean;
  } | null;
}
const makeWorld = (): World => ({
  facts: null,
  fence: "fence-1",
  authorityOk: true,
  authorityThrows: false,
  factsCalls: 0,
  requests: [],
  coverage: {},
  bumpRevisionAfterAppend: false,
  revokeAfter: null,
  currencyProbe: "off",
  frozen: null,
});

interface HarnessOptions {
  readonly retroThreadId?: string;
  readonly authority?: Partial<{
    readonly teamId: string;
    readonly environmentId: string;
    readonly retroThreadId: string;
    readonly retroEpoch: number;
  }>;
}

const racingEvents = (world: World) =>
  Layer.effect(
    Events.OrchestrationEventStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const built = yield* Layer.build(
        Events.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql))),
      );
      const real = Context.get(built, Events.OrchestrationEventStore);
      return {
        ...real,
        appendMissionEvent: (event: Parameters<typeof real.appendMissionEvent>[0]) =>
          Effect.tap(real.appendMissionEvent(event), () => {
            if (event.type !== "mission.retro-skill-evaluated") return Effect.void;
            if (world.revokeAfter?.at === "append") {
              if (world.revokeAfter.what === "fence") world.fence = "fence-revoked";
              else world.authorityOk = false;
            }
            return world.bumpRevisionAfterAppend
              ? sql`UPDATE projection_missions SET revision = revision + 1 WHERE mission_id = ${event.aggregateId}`.pipe(
                  Effect.orDie,
                )
              : Effect.void;
          }),
      };
    }),
  );

const revokingReceipts = (world: World) =>
  Layer.effect(
    Receipts.OrchestrationCommandReceiptRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const built = yield* Layer.build(
        Receipts.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql))),
      );
      const real = Context.get(built, Receipts.OrchestrationCommandReceiptRepository);
      return {
        ...real,
        insertIfAbsent: (receipt: Receipts.OrchestrationCommandReceipt) =>
          Effect.tap(real.insertIfAbsent(receipt), () =>
            Effect.sync(() => {
              if (receipt.commandType !== SkillStore.MISSION_RETRO_SKILL_EVALUATION_COMMAND_TYPE)
                return;
              if (world.revokeAfter?.at !== "receipt") return;
              if (world.revokeAfter.what === "fence") world.fence = "fence-revoked";
              else world.authorityOk = false;
            }),
          ),
      };
    }),
  );

type TerminalStatus = "succeeded" | "failed" | "cancelled" | "not_started";

const harness = (options: HarnessOptions = {}) => {
  const world = makeWorld();
  const retroThreadId = options.retroThreadId ?? "retro";
  const originals = new Map<string, string>();
  const delivery = {
    teamId: TeamId.make("team"),
    environmentId: EnvironmentId.make("env"),
    controllerThreadId: ThreadId.make("delivery"),
  };
  const retro = { ...delivery, controllerThreadId: ThreadId.make(retroThreadId) };

  const snapshot = Layer.succeed(Checkpoints.MissionRetroSnapshotPort, {
    readSnapshot: (cmd: Checkpoints.MissionRetroCaptureCommand) =>
      Effect.gen(function* () {
        return {
          teamId: "team",
          environmentId: "env",
          deliveryThreadId: "delivery",
          deliveryEpoch: 3,
          nowMs: yield* Clock.currentTimeMillis,
          missionId: cmd.missionId,
          sourceRoot: "thread://origin",
          sourceThreadId: "origin",
          actualOrigin: "product",
          eligibleTrigger: "milestone",
          fromInclusive: cmd.fromInclusive,
          toExclusive: cmd.toExclusive,
          snapshotFingerprint: FINGERPRINT,
          sourceRefs: [],
          omissions: [],
          coverage: "unknown" as const,
          pendingChildRuns: false,
          capacity: {
            state: "unknown" as const,
            accountId: null,
            company: null,
            reporterIdentity: null,
            exhausted: false,
            lowReserve: false,
            profile: null,
          },
        };
      }),
  });
  const analysisPort = Layer.succeed(Analysis.MissionRetroAnalysisFactsPort, {
    readClaimFacts: (
      cmd: Analysis.MissionRetroAnalysisClaimCommand,
      cp: Analysis.MissionRetroAnalysisCheckpoint,
    ) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        return {
          teamId: "team",
          environmentId: "env",
          missionId: cmd.missionId,
          checkpointId: cp.checkpointId,
          retroThreadId,
          retroEpoch: 4,
          sourceThreadId: cp.sourceThreadId,
          sourceRoot: cp.sourceRoot,
          snapshotFingerprint: cp.snapshotFingerprint,
          coveredFromInclusive: cp.coveredFromInclusive,
          coveredToExclusive: cp.coveredToExclusive,
          nowMs,
          maxFactAgeMs: 1000,
          leaseDurationMs: 100000,
          capacity: {
            ready: true,
            exhausted: false,
            lowReserve: false,
            verified: true,
            company: "No Fun",
            accountId: "account",
            providerInstanceId: "muse-personal" as const,
            modelId: "muse-spark-1.3-contributor",
            profile: "muse-review",
            observedAtMs: nowMs,
            accountRef: "account-ref",
            providerRef: "provider-ref",
            capacityRef: "capacity-ref",
          },
          host: {
            hostId: "host",
            bootId: "boot",
            verified: true,
            interactivePressureVerified: true,
            pressureReady: true,
            buildVerified: true,
            productiveWorkPriority: true,
            observedAtMs: nowMs,
            hostRef: "host-ref",
            buildRef: "build-ref",
            priorityRef: "priority-ref",
          },
          prepared: {
            reporterChildThreadId: `child-${cmd.missionId}-${cp.checkpointId}`,
            reporterRunId: `run-${cmd.missionId}-${cp.checkpointId}`,
            verified: true,
            receiptRef: "prepared-ref",
          },
        };
      }),
    readTerminalFacts: (cmd: Analysis.MissionRetroAnalysisSettleCommand) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        return {
          teamId: "team",
          environmentId: "env",
          missionId: cmd.missionId,
          checkpointId: cmd.checkpointId,
          retroThreadId,
          retroEpoch: 4,
          nowMs,
          maxFactAgeMs: 1000,
          binding: {
            assignmentToken: cmd.assignmentToken,
            fence: cmd.fence,
            attemptNumber: cmd.attemptNumber,
            reporterChildThreadId: cmd.reporterChildThreadId,
            reporterRunId: cmd.reporterRunId,
            hostId: cmd.hostId,
            bootId: cmd.bootId,
          },
          verified: true,
          status: "succeeded" as TerminalStatus,
          receiptRef: "terminal-ref",
          observedAtMs: nowMs,
        };
      }),
  });
  const reportPort = Layer.succeed(ReportStore.MissionRetroReportArtifactPort, {
    readOriginal: (input: ReportStore.MissionRetroReportReadInput) =>
      Effect.gen(function* () {
        const bytes = originals.get(input.command.originalArtifactRef);
        if (bytes === undefined)
          return yield* new ReportStore.MissionRetroReportStoreError({
            operation: "receive",
            category: "persistence",
          });
        const report = decodeJson(bytes) as ReportValue;
        const chunk = chunkFor(report.coveredFromInclusive, report.coveredToExclusive);
        const coverage: MissionRetroReportTrustedCoverage = {
          manifestSourceRefs: [chunk],
          readReceipts: [chunk],
          apiCoverage: "full",
          childLogCoverage: "full",
          rawStdoutCoverage: "full",
          pendingChildRuns: false,
          trustedSkillLoads: [],
          ...world.coverage,
        };
        return {
          teamId: "team",
          environmentId: "env",
          missionId: input.command.missionId,
          checkpointId: input.command.checkpointId,
          retroThreadId,
          retroEpoch: 4,
          sourceThreadId: "origin",
          sourceRoot: "thread://origin",
          snapshotFingerprint: FINGERPRINT,
          coveredFromInclusive: report.coveredFromInclusive,
          coveredToExclusive: report.coveredToExclusive,
          originalArtifactRef: input.command.originalArtifactRef,
          descriptorBytes: bytes,
          report,
          actualOrigin: "product",
          coverage,
        };
      }),
    prepareNormalized: (input: ReportStore.MissionRetroReportPrepareInput) =>
      Effect.sync(() => {
        const bytes = stableStringify(input.report);
        const evidenceBytes = stableStringify(input.coverageEvidence);
        const evidenceSha = sha(evidenceBytes);
        return {
          artifactRef: `retro-normalized:${input.report.reportHash}`,
          coverageEvidence: {
            artifactRef: `retro-coverage:${evidenceSha}`,
            artifactSha: evidenceSha,
            descriptorBytes: evidenceBytes,
          },
          artifactSha: sha(bytes),
          descriptorBytes: bytes,
        };
      }),
  });

  const skillAuthority = Layer.succeed(SkillStore.MissionRetroSkillEvaluationAuthority, {
    teamId: options.authority?.teamId ?? "team",
    environmentId: options.authority?.environmentId ?? "env",
    retroThreadId: options.authority?.retroThreadId ?? retroThreadId,
    retroEpoch: options.authority?.retroEpoch ?? 4,
    isCurrent: () => {
      if (world.authorityThrows) throw new Error("authority currency check failed");
      return world.authorityOk;
    },
  });
  const skillProducer = Layer.succeed(SkillStore.MissionRetroSkillEvaluationProducer, {
    readFacts: (request: SkillStore.MissionRetroSkillEvaluationFactsRequest) => {
      world.factsCalls += 1;
      world.requests.push(request);
      return world.facts === null
        ? Effect.fail(
            new SkillStore.MissionRetroSkillEvaluationStoreError({ category: "scope_denied" }),
          )
        : Effect.succeed(world.facts);
    },
    isCurrent: (facts: Facts) => {
      if (world.currencyProbe === "observe-frozen" && facts.evaluation) {
        const context = facts.evaluation.context as { readonly pairs: ReadonlyArray<object> };
        world.frozen = {
          facts: Object.isFrozen(facts),
          evaluation: Object.isFrozen(facts.evaluation),
          context: Object.isFrozen(context),
          pairs: Object.isFrozen(context.pairs),
          firstPair: Object.isFrozen(context.pairs[0]),
        };
      }
      if (world.currencyProbe === "throw") throw new Error("producer currency check failed");
      // A frozen snapshot throws here; the store must treat that as not current.
      if (world.currencyProbe === "mutate-snapshot")
        Object.assign(facts, { userStopRequested: false });
      if (world.currencyProbe === "mutate-own-copy" && world.facts?.evaluation) {
        // The producer rewrites ITS OWN object after the store detached the facts.
        (world.facts.evaluation.context as { pairs: Array<unknown> }).pairs.length = 0;
        (world.facts.evaluation.candidate as { claimedPass: boolean }).claimedPass = false;
      }
      return facts.fence === world.fence;
    },
  });

  const base = Layer.mergeAll(
    SkillStore.layer.pipe(
      Layer.provide(racingEvents(world)),
      Layer.provide(revokingReceipts(world)),
      Layer.provide(skillAuthority),
      Layer.provide(skillProducer),
    ),
    ReportStore.layer.pipe(
      Layer.provide(Events.layer),
      Layer.provide(Receipts.layer),
      Layer.provide(Layer.succeed(MissionService.MissionAuthority, retro)),
      Layer.provide(reportPort),
    ),
    Analysis.layer.pipe(
      Layer.provide(Events.layer),
      Layer.provide(Receipts.layer),
      Layer.provide(Layer.succeed(MissionService.MissionAuthority, retro)),
      Layer.provide(analysisPort),
    ),
    Checkpoints.layer.pipe(
      Layer.provide(Events.layer),
      Layer.provide(Receipts.layer),
      Layer.provide(Layer.succeed(MissionService.MissionAuthority, delivery)),
      Layer.provide(snapshot),
    ),
    MissionService.layer.pipe(
      Layer.provide(Events.layer),
      Layer.provide(Receipts.layer),
      Layer.provide(Layer.succeed(MissionService.MissionAuthority, delivery)),
    ),
    Events.layer,
    Receipts.layer,
  );
  return {
    world,
    retroThreadId,
    layer: base.pipe(Layer.provideMerge(Sqlite.layerMemory)),
    originals,
  };
};

type Harness = ReturnType<typeof harness>;

// Compile-time: BOTH private ports are required by the layer, so there is no
// default authority and no default evaluation producer.
const _requiresPrivatePorts: Layer.Layer<
  SkillStore.MissionRetroSkillEvaluationStore,
  never,
  | SqlClient.SqlClient
  | Events.OrchestrationEventStore
  | Receipts.OrchestrationCommandReceiptRepository
  | SkillStore.MissionRetroSkillEvaluationAuthority
  | SkillStore.MissionRetroSkillEvaluationProducer
> = SkillStore.layer;
void _requiresPrivatePorts;

// ---------------------------------------------------------------------------
// Canonical report staging through the genuine checkpoint/analysis/report stores
// ---------------------------------------------------------------------------

const ok = <A, E>(result: Result.Result<A, E>): A => {
  assert.isTrue(Result.isSuccess(result), "expected success result");
  if (Result.isSuccess(result)) return result.success;
  throw new Error("unreachable");
};

const current = (id: string) =>
  Effect.gen(function* () {
    return Option.getOrThrow(yield* (yield* MissionService.MissionService).get(MissionId.make(id)));
  });

const seedMission = (h: Harness, id: string) =>
  Effect.gen(function* () {
    const svc = yield* MissionService.MissionService;
    yield* svc.execute({
      type: "mission.create",
      commandId: CommandId.make(`create-${id}`),
      mission: missionFixture(id, h.retroThreadId),
    });
  });

const candidateBody = (tag: string): Partial<Omit<ReportValue, "reportHash">> => ({
  verdict: "candidates",
  incidents: [
    {
      incidentId: `incident:${tag}`,
      concernId: `concern:${tag}`,
      sourceEventRef: `event:${tag}`,
      summary: "s",
      destinationOwner: "project_guidance",
    },
  ],
  shortlist: [
    {
      candidateId: `candidate:${tag}`,
      concernId: `concern:${tag}`,
      incidentRefs: [`incident:${tag}`],
      summary: "c",
      destinationOwner: "project_guidance",
      alreadyFixed: false,
    },
  ],
});

interface StageOptions {
  readonly from: number;
  readonly to: number;
  readonly tag: string;
  readonly kind?: "candidates" | "no_change";
  readonly coverage?: Partial<MissionRetroReportTrustedCoverage>;
}

/** Capture, claim, receive and settle one genuine report; returns the canonical receipt hashes. */
const stageReport = (h: Harness, id: string, options: StageOptions) =>
  Effect.gen(function* () {
    h.world.coverage = options.coverage ?? {};
    const checkpoints = yield* Checkpoints.MissionRetroCheckpointStore;
    const analyses = yield* Analysis.MissionRetroAnalysisStore;
    const reports = yield* ReportStore.MissionRetroReportStore;
    const captured = ok(
      yield* checkpoints.capture({
        commandId: CommandId.make(`capture-${options.tag}`),
        missionId: id,
        expectedRevision: (yield* current(id)).revision,
        deliveryEpoch: 3,
        sourceThreadId: "origin",
        fromInclusive: options.from,
        toExclusive: options.to,
        trigger: "milestone",
      }),
    );
    const checkpointId = captured.checkpoint.checkpointId;
    const claimed = ok(
      yield* analyses.claim({
        commandId: CommandId.make(`claim-${options.tag}`),
        missionId: id,
        checkpointId,
        expectedRevision: (yield* current(id)).revision,
        retroEpoch: 4,
      }),
    );
    const lease = claimed.analysis.lease;
    assert.isNotNull(lease, "claim must produce a lease");
    if (lease === null) throw new Error("unreachable");
    const reportFor = (over: Partial<Omit<ReportValue, "reportHash">>): ReportValue =>
      withActualReportHash({
        checkpointId,
        teamId: "team",
        environmentId: "env",
        missionId: id,
        sourceThreadId: "origin",
        sourceRoot: "thread://origin",
        snapshotFingerprint: FINGERPRINT,
        coveredFromInclusive: options.from,
        coveredToExclusive: options.to,
        reporterChildThreadId: lease.reporterChildThreadId,
        reporterRunId: lease.reporterRunId,
        reportRevision: lease.reportRevision,
        assignmentToken: lease.assignmentToken,
        managerEpoch: 4,
        model: "muse-spark-1.3-contributor",
        profile: "muse-review",
        sourceRefs: [chunkFor(options.from, options.to)],
        claimedReadRefs: [],
        summary: "summary",
        verdict: "no_change",
        shortlist: [],
        incidents: [],
        skillEvidence: [],
        omissions: [],
        ...over,
      });
    const receive = (report: ReportValue, ref: string, commandId: string) =>
      Effect.gen(function* () {
        const bytes = stableStringify(report);
        h.originals.set(ref, bytes);
        return yield* reports.receive({
          commandId: CommandId.make(commandId),
          missionId: id,
          checkpointId,
          expectedRevision: (yield* current(id)).revision,
          retroEpoch: 4,
          originalArtifactRef: ref,
          originalArtifactSha: sha(bytes),
          claimedSourceReportHash: computeRetroReportHash(report),
        });
      });
    const report = reportFor(options.kind === "no_change" ? {} : candidateBody(options.tag));
    const out = ok(
      yield* receive(report, `retro-original:${options.tag}`, `receive-${options.tag}`),
    );
    ok(
      yield* analyses.settle({
        commandId: CommandId.make(`settle-${options.tag}`),
        missionId: id,
        checkpointId,
        expectedRevision: (yield* current(id)).revision,
        retroEpoch: 4,
        assignmentToken: lease.assignmentToken,
        fence: claimed.analysis.fence,
        attemptNumber: claimed.analysis.attemptNumber,
        reporterChildThreadId: lease.reporterChildThreadId,
        reporterRunId: lease.reporterRunId,
        hostId: lease.hostId,
        bootId: lease.bootId,
      }),
    );
    h.world.coverage = {};
    return {
      checkpointId,
      sourceReportHash: out.sourceReportHash,
      normalizedReportHash: out.normalizedReportHash,
      disposition: out.disposition,
      reportFor,
      receiveVariant: (variant: ReportValue, tag: string) =>
        receive(variant, `retro-original:${tag}`, `receive-${tag}`),
    };
  });
type Staged = Effect.Success<ReturnType<typeof stageReport>>;

// ---------------------------------------------------------------------------
// Trusted replay-context fixtures for the existing pure validator
// ---------------------------------------------------------------------------

const OLD_SNAP = "a".repeat(64);
const NEW_SNAP = "b".repeat(64);
const CONFIG = "c".repeat(64);
const FIXTURE_HASH: Record<SkillEvaluationFixtureClass, string> = {
  failure: "f".repeat(64),
  positive: "1".repeat(64),
  negative: "2".repeat(64),
};
const TARGET = "skills/retro-reporter/SKILL.md";

let runSeq = 0;
const observation = (
  fixtureClass: SkillEvaluationFixtureClass,
  side: "old" | "new",
  overrides: Partial<SkillEvaluationTrustedObservation> = {},
): SkillEvaluationTrustedObservation => {
  runSeq += 1;
  return {
    runRef: `run:${fixtureClass}:${side}:${runSeq}`,
    contextId: `ctx:${fixtureClass}:${side}:${runSeq}`,
    fixtureId: `fixture:${fixtureClass}`,
    fixtureHash: FIXTURE_HASH[fixtureClass],
    configDigest: CONFIG,
    observedSkillSha256: side === "old" ? OLD_SNAP : NEW_SNAP,
    outcome: side === "old" ? "fail" : "pass",
    skillTriggered: false,
    unnecessaryLoads: 0,
    repeatedLookups: 0,
    completionQuality: "ok",
    ...overrides,
  };
};

/** Failure fixture: old fails, new passes. Positive fixture triggers the skill. Negative never does. */
const pairFor = (
  fixtureClass: SkillEvaluationFixtureClass,
  old: Partial<SkillEvaluationTrustedObservation> = {},
  young: Partial<SkillEvaluationTrustedObservation> = {},
): SkillEvaluationTrustedPair => ({
  fixtureClass,
  old: observation(
    fixtureClass,
    "old",
    fixtureClass === "positive"
      ? { outcome: "pass", skillTriggered: true, ...old }
      : fixtureClass === "negative"
        ? { outcome: "pass", ...old }
        : old,
  ),
  new: observation(
    fixtureClass,
    "new",
    fixtureClass === "positive" ? { skillTriggered: true, ...young } : young,
  ),
});

const cleanPairs = (): Array<SkillEvaluationTrustedPair> => [
  pairFor("failure"),
  pairFor("positive"),
  pairFor("negative"),
];

type Variant = "ready" | "hold" | "rejected" | "no_change" | "forged_claim" | "retarget";

const VARIANT_OUTCOME: Record<Variant, { kind: string; reason: string }> = {
  ready: { kind: "review_ready", reason: "ready_fix_verified" },
  hold: { kind: "hold", reason: "hold_upstream_ownership" },
  rejected: { kind: "rejected", reason: "rejected_regression" },
  no_change: { kind: "no_change", reason: "no_change_identical" },
  forged_claim: { kind: "rejected", reason: "rejected_forged_receipt" },
  retarget: { kind: "rejected", reason: "rejected_retarget" },
};

interface Spec {
  readonly missionId: string;
  readonly report: Staged;
  readonly evaluationId: string;
  readonly candidateId: string;
  readonly target?: string;
  readonly variant?: Variant;
  /** Evidence digest; defaults to one derived from the evaluation id. */
  readonly evidenceSha?: string;
}

const evidenceShaFor = (spec: Spec): string =>
  spec.evidenceSha ?? sha(`evidence:${spec.evaluationId}`);

const contextFor = (spec: Spec): SkillEvaluationTrustedContext => {
  const variant = spec.variant ?? "ready";
  const base: SkillEvaluationTrustedContext = {
    scope: {
      teamId: "team",
      environmentId: "env",
      originMissionId: spec.missionId,
      candidateId: spec.candidateId,
      targetSkillRef: spec.target ?? TARGET,
      sourceReportHash: spec.report.sourceReportHash,
      normalizedReportHash: spec.report.normalizedReportHash,
    },
    authorId: "author:writer-1",
    reviewerId: "reviewer:independent-1",
    oldSnapshotDigest: OLD_SNAP,
    newSnapshotDigest: NEW_SNAP,
    ownership: "owned-isolated",
    configDigest: CONFIG,
    runMode: "deterministic",
    requiredRepeatCount: 1,
    telemetryComplete: true,
    leakageCheck: "pass",
    pairs: cleanPairs(),
  };
  switch (variant) {
    case "ready":
    case "retarget":
      return base;
    case "hold":
      return { ...base, ownership: "upstream" };
    case "rejected":
      return {
        ...base,
        pairs: [
          pairFor("failure"),
          pairFor("positive", {}, { outcome: "fail" }),
          pairFor("negative"),
        ],
      };
    case "forged_claim":
      return {
        ...base,
        pairs: [
          pairFor("failure", {}, { outcome: "fail" }),
          pairFor("positive", {}, { outcome: "fail" }),
          pairFor("negative", {}, { outcome: "fail" }),
        ],
      };
    case "no_change":
      return {
        ...base,
        newSnapshotDigest: OLD_SNAP,
        pairs: [
          pairFor(
            "failure",
            { outcome: "pass", observedSkillSha256: OLD_SNAP },
            { observedSkillSha256: OLD_SNAP },
          ),
          pairFor("positive", { observedSkillSha256: OLD_SNAP }, { observedSkillSha256: OLD_SNAP }),
          pairFor("negative", { observedSkillSha256: OLD_SNAP }, { observedSkillSha256: OLD_SNAP }),
        ],
      };
  }
};

/** Facts exactly as a faithful private producer reports them for the current canonical state. */
const buildFacts = (mission: MissionValue, spec: Spec): Facts => {
  const variant = spec.variant ?? "ready";
  const context = contextFor(spec);
  const artifactSha = evidenceShaFor(spec);
  return {
    teamId: "team",
    environmentId: "env",
    missionId: mission.id,
    retroThreadId: mission.managers.retro?.threadId ?? "",
    retroEpoch: mission.managers.retro?.epoch ?? 0,
    observedRevision: mission.revision,
    userStopRequested: false,
    userPauseRequested: false,
    evaluation: {
      candidate: {
        candidateId: spec.candidateId,
        targetSkillRef:
          variant === "retarget" ? "skills/other-owner/SKILL.md" : (spec.target ?? TARGET),
        sourceReportHash: spec.report.sourceReportHash,
        claimedPass: true,
      },
      context,
      evidence: {
        artifactRef: `skill-replay-evidence:${artifactSha}`,
        artifactSha,
        verification: "verified",
        binding: {
          teamId: "team",
          environmentId: "env",
          missionId: mission.id,
          retroEpoch: mission.managers.retro?.epoch ?? 0,
          sourceReportHash: context.scope.sourceReportHash,
          normalizedReportHash: context.scope.normalizedReportHash,
          candidateId: spec.candidateId,
          evaluationId: spec.evaluationId,
          targetSkillRef: context.scope.targetSkillRef,
          oldSkillSha256: context.oldSnapshotDigest,
          newSkillSha256: context.newSnapshotDigest,
        },
      },
    },
    fence: "fence-1",
  };
};

/** Mutable deep view for fixture tampering only. */
type Draft = {
  teamId: string;
  environmentId: string;
  missionId: string;
  retroThreadId: string;
  retroEpoch: number;
  observedRevision: number;
  userStopRequested: boolean | null;
  userPauseRequested: boolean | null;
  evaluation?: {
    candidate: Record<string, unknown>;
    context: {
      scope: Record<string, unknown>;
      reviewerId: string;
      oldSnapshotDigest: string;
      newSnapshotDigest: string;
    } & Record<string, unknown>;
    evidence: {
      artifactRef: string;
      artifactSha: string;
      verification: string;
      binding: Record<string, unknown>;
    };
  } | null;
  fence: string;
};
const tamper =
  (edit: (draft: Draft) => void) =>
  (facts: Facts): Facts => {
    const draft = structuredClone(facts) as unknown as Draft;
    edit(draft);
    return draft as unknown as Facts;
  };
const evaluationOf = (draft: Draft) => {
  assert.isDefined(draft.evaluation);
  assert.isNotNull(draft.evaluation);
  return draft.evaluation as NonNullable<Draft["evaluation"]>;
};

// ---------------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------------

interface Scenario {
  readonly h: Harness;
  readonly store: SkillStore.MissionRetroSkillEvaluationStore["Service"];
  readonly missionId: string;
  readonly report: Staged;
  seq: number;
}

/** A seeded mission with one eligible, candidate-bearing canonical report. */
const scenario = (h: Harness, missionId = "mission") =>
  Effect.gen(function* () {
    yield* seedMission(h, missionId);
    const report = yield* stageReport(h, missionId, { from: 1, to: 2, tag: `${missionId}-a` });
    assert.strictEqual(report.disposition, "queued_for_triage");
    const store = yield* SkillStore.MissionRetroSkillEvaluationStore;
    return { h, store, missionId, report, seq: 0 } satisfies Scenario;
  });

interface AttemptOptions {
  readonly commandId?: string;
  readonly evaluationId?: string;
  readonly candidateId?: string;
  readonly report?: Staged;
  readonly target?: string;
  readonly variant?: Variant;
  readonly evidenceSha?: string;
  readonly facts?: (base: Facts) => Facts;
  readonly command?: Record<string, unknown>;
  readonly expectedRevision?: number;
}

const attempt = (s: Scenario, options: AttemptOptions = {}) =>
  Effect.gen(function* () {
    s.seq += 1;
    const mission = yield* current(s.missionId);
    const evaluationId = options.evaluationId ?? `eval-${s.seq}`;
    const spec: Spec = {
      missionId: s.missionId,
      report: options.report ?? s.report,
      evaluationId,
      candidateId: options.candidateId ?? `candidate:${s.seq}`,
      ...(options.target === undefined ? {} : { target: options.target }),
      ...(options.variant === undefined ? {} : { variant: options.variant }),
      ...(options.evidenceSha === undefined ? {} : { evidenceSha: options.evidenceSha }),
    };
    const base = buildFacts(mission, spec);
    s.h.world.facts = options.facts === undefined ? base : options.facts(base);
    const artifactSha = evidenceShaFor(spec);
    const command = {
      commandId: CommandId.make(options.commandId ?? `record-${s.seq}`),
      missionId: s.missionId,
      expectedRevision: options.expectedRevision ?? mission.revision,
      evaluationId,
      candidateId: spec.candidateId,
      evidenceArtifactRef: `skill-replay-evidence:${artifactSha}`,
      evidenceArtifactSha: artifactSha,
      ...options.command,
    } as RecordCommand;
    return yield* s.store.record(command);
  });

type Classified =
  | { readonly kind: "ok"; readonly outcome: Outcome }
  | { readonly kind: "hold"; readonly code: string }
  | { readonly kind: "error"; readonly category: string };

const isHold = Schema.is(SkillStore.MissionRetroSkillEvaluationHold);

const classify = <R>(
  effect: Effect.Effect<
    SkillStore.MissionRetroSkillEvaluationResult,
    { readonly category: string },
    R
  >,
): Effect.Effect<Classified, never, R> =>
  effect.pipe(
    Effect.result,
    Effect.map((outer): Classified => {
      if (Result.isFailure(outer)) return { kind: "error", category: outer.failure.category };
      if (Result.isFailure(outer.success)) {
        assert.isTrue(isHold(outer.success.failure), "a finite hold is a typed hold");
        return { kind: "hold", code: outer.success.failure.code };
      }
      return { kind: "ok", outcome: outer.success.success };
    }),
  );

const tryAttempt = (s: Scenario, options: AttemptOptions = {}) => classify(attempt(s, options));

const recorded = (result: Classified): Outcome => {
  assert.strictEqual(
    result.kind,
    "ok",
    `expected a recorded outcome, got ${JSON.stringify(result)}`,
  );
  if (result.kind !== "ok") throw new Error("unreachable");
  return result.outcome;
};

const expectHold = (result: Classified, code: string) =>
  assert.deepStrictEqual(result, { kind: "hold", code });
const expectError = (result: Classified, category: string) =>
  assert.deepStrictEqual(result, { kind: "error", category });

const evalEvents = (missionId: string) =>
  Effect.gen(function* () {
    const logged = yield* (yield* Events.OrchestrationEventStore).readMissionEvents(
      MissionId.make(missionId),
    );
    return logged.filter((entry) => entry.type === "mission.retro-skill-evaluated");
  });

/** Everything a denied or held attempt must leave untouched. */
const ledger = (missionId: string) =>
  Effect.gen(function* () {
    const mission = yield* current(missionId);
    const logged = yield* (yield* Events.OrchestrationEventStore).readMissionEvents(
      MissionId.make(missionId),
    );
    return {
      revision: mission.revision,
      updatedAt: mission.updatedAt,
      events: logged.length,
      records: (mission.execution?.retroSkillEvaluations ?? []).length,
    };
  });

const receiptFor = (commandId: string) =>
  Effect.gen(function* () {
    const repository = yield* Receipts.OrchestrationCommandReceiptRepository;
    return yield* repository.getByCommandId({ commandId: CommandId.make(commandId) });
  });

const recordsOf = (mission: MissionValue) => mission.execution?.retroSkillEvaluations ?? [];

/** Plant canonical state straight into the projection row. NOT a genuine lifecycle transition. */
const plant = (missionId: string, edit: (mission: MissionValue) => MissionValue) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      snapshot_json: string;
    }>`SELECT snapshot_json FROM projection_missions WHERE mission_id = ${missionId}`;
    const row = rows[0];
    assert.isDefined(row);
    const next = edit(decodeMissionJson((row as { snapshot_json: string }).snapshot_json));
    yield* sql`UPDATE projection_missions SET snapshot_json = ${encodeMissionJson(next)} WHERE mission_id = ${missionId}`;
  });

const run = <A, E, R>(h: Harness, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(h.layer));

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

it.effect("records a genuine review_ready decision as bounded metadata in one atomic write", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* run(
      h,
      Effect.gen(function* () {
        const s = yield* scenario(h);
        const before = yield* current(s.missionId);
        const beforeEvents = yield* evalEvents(s.missionId);
        assert.strictEqual(beforeEvents.length, 0);

        const result = recorded(
          yield* tryAttempt(s, { evaluationId: "eval-ready", candidateId: "candidate:ready" }),
        );
        // The producer is asked about identity only: never a verdict, hash, or reviewer.
        assert.deepStrictEqual(h.world.requests, [
          {
            missionId: s.missionId,
            evaluationId: "eval-ready",
            candidateId: "candidate:ready",
            evidenceArtifactRef: `skill-replay-evidence:${sha("evidence:eval-ready")}`,
            evidenceArtifactSha: sha("evidence:eval-ready"),
          },
        ]);
        assert.isTrue(result.committed);
        assert.isFalse(result.recovered);
        assert.deepStrictEqual(result.report, {
          checkpointId: s.report.checkpointId,
          reportRevision: 1,
        });

        const record = result.record;
        assert.strictEqual(record.kind, "review_ready");
        assert.strictEqual(record.reason, "ready_fix_verified");
        assert.deepStrictEqual(record.failurePairs, {
          required: 1,
          observed: 1,
          oldPass: 0,
          newPass: 1,
        });
        assert.deepStrictEqual(record.positivePairs, {
          required: 1,
          observed: 1,
          oldPass: 1,
          newPass: 1,
        });
        assert.deepStrictEqual(record.negativePairs, {
          required: 1,
          observed: 1,
          oldPass: 1,
          newPass: 1,
        });
        assert.strictEqual(record.uncertainty, "observed_pairs_only");
        assert.strictEqual(record.sourceReportHash, s.report.sourceReportHash);
        assert.strictEqual(record.normalizedReportHash, s.report.normalizedReportHash);
        assert.strictEqual(record.oldSkillSha256, OLD_SNAP);
        assert.strictEqual(record.newSkillSha256, NEW_SNAP);
        assert.strictEqual(record.targetSkillRef, TARGET);
        assert.strictEqual(record.evidenceArtifactSha, sha("evidence:eval-ready"));
        assert.strictEqual(
          record.evidenceArtifactRef,
          `skill-replay-evidence:${sha("evidence:eval-ready")}`,
        );
        assert.strictEqual(record.reviewerRef, "reviewer:independent-1");
        assert.strictEqual(record.recordedByThreadId, "retro");
        assert.strictEqual(record.retroEpoch, 4);
        assert.strictEqual(record.teamId, "team");
        assert.strictEqual(record.environmentId, "env");
        assert.strictEqual(record.missionId, s.missionId);
        // The server clock, not the producer, stamps the record.
        assert.strictEqual(record.recordedAt, (yield* current(s.missionId)).updatedAt);
        // Bounded receipt codec shape only: no installed/effective flag exists.
        assert.deepStrictEqual(Object.keys(record).sort(), [
          "candidateId",
          "environmentId",
          "evaluationId",
          "evidenceArtifactRef",
          "evidenceArtifactSha",
          "failurePairs",
          "kind",
          "missionId",
          "negativePairs",
          "newSkillSha256",
          "normalizedReportHash",
          "oldSkillSha256",
          "positivePairs",
          "reason",
          "recordedAt",
          "recordedByThreadId",
          "retroEpoch",
          "reviewerRef",
          "sourceReportHash",
          "targetSkillRef",
          "teamId",
          "uncertainty",
        ]);

        const after = yield* current(s.missionId);
        assert.strictEqual(after.revision, before.revision + 1);
        assert.deepStrictEqual(recordsOf(after), [record]);
        const events = yield* evalEvents(s.missionId);
        assert.strictEqual(events.length, 1);
        const event = events[0];
        assert.strictEqual(event?.type, "mission.retro-skill-evaluated");
        if (event?.type !== "mission.retro-skill-evaluated") throw new Error("unreachable");
        assert.strictEqual(event.sequence, result.eventSequence);
        assert.strictEqual(event.commandId, "record-1");
        assert.strictEqual(event.payload.evaluationId, "eval-ready");
        // The event carries the FULL updated canonical snapshot.
        assert.strictEqual(stableStringify(event.payload.mission), stableStringify(after));
        const receipt = Option.getOrThrow(yield* receiptFor("record-1"));
        assert.strictEqual(receipt.status, "accepted");
        assert.strictEqual(
          receipt.commandType,
          SkillStore.MISSION_RETRO_SKILL_EVALUATION_COMMAND_TYPE,
        );
        assert.strictEqual(receipt.resultSequence, result.eventSequence);
        assert.deepStrictEqual(receipt, result.receipt);

        // No expected answers, detail text, pair bodies, transcripts, or fixture contents.
        const stored = stableStringify(after);
        for (const forbidden of [
          "Ready:",
          "runRef",
          "ctx:",
          "claimedPass",
          "fixture:",
          "run:failure",
          "author:writer",
        ]) {
          assert.isFalse(stored.includes(forbidden), `snapshot must not carry ${forbidden}`);
        }
      }),
    );
  }),
);

it.effect(
  "records hold, rejected, no_change and forged-claim outcomes exactly as the validator decides them",
  () =>
    Effect.gen(function* () {
      const h = harness();
      return yield* run(
        h,
        Effect.gen(function* () {
          const s = yield* scenario(h);
          const variants: ReadonlyArray<Variant> = [
            "hold",
            "rejected",
            "no_change",
            "forged_claim",
            "retarget",
            "ready",
          ];
          for (const variant of variants) {
            const result = recorded(
              yield* tryAttempt(s, {
                evaluationId: `eval-${variant}`,
                candidateId: `candidate:${variant}`,
                variant,
              }),
            );
            assert.deepStrictEqual(
              { kind: result.record.kind, reason: result.record.reason },
              VARIANT_OUTCOME[variant],
            );
            assert.isTrue(result.committed);
          }
          const mission = yield* current(s.missionId);
          assert.deepStrictEqual(
            recordsOf(mission).map((record) => record.evaluationId),
            variants.map((variant) => `eval-${variant}`),
          );
          assert.strictEqual((yield* evalEvents(s.missionId)).length, variants.length);
          // A recorded hold is a validator outcome and is persisted; it is not review_ready.
          assert.isFalse(
            recordsOf(mission).some(
              (record) => record.kind === "review_ready" && record.evaluationId !== "eval-ready",
            ),
          );
        }),
      );
    }),
);

// ---------------------------------------------------------------------------
// Idempotency, alias, and conflict
// ---------------------------------------------------------------------------

it.effect("replays an accepted command from the durable receipt and writes nothing", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* run(
      h,
      Effect.gen(function* () {
        const s = yield* scenario(h);
        const startRevision = (yield* current(s.missionId)).revision;
        const exact = {
          commandId: "record-first",
          evaluationId: "eval-1",
          candidateId: "candidate:1",
          expectedRevision: startRevision,
        };
        const first = recorded(yield* tryAttempt(s, exact));
        // Unrelated canonical movement: the replay still reads the ORIGINAL record.
        recorded(yield* tryAttempt(s, { evaluationId: "eval-2", candidateId: "candidate:2" }));
        const settled = yield* ledger(s.missionId);
        assert.isAbove(settled.revision, startRevision + 1);

        const replay = recorded(yield* tryAttempt(s, exact));
        assert.isTrue(replay.recovered);
        assert.isFalse(replay.committed);
        assert.deepStrictEqual(replay.record, first.record);
        assert.deepStrictEqual(replay.receipt, first.receipt);
        assert.strictEqual(replay.eventSequence, first.eventSequence);
        assert.deepStrictEqual(replay.report, first.report);
        assert.deepStrictEqual(yield* ledger(s.missionId), settled);

        // The same command id with different bytes is an alias conflict, never a new write.
        expectError(
          yield* tryAttempt(s, { ...exact, expectedRevision: settled.revision }),
          "request_conflict",
        );
        expectError(
          yield* tryAttempt(s, { ...exact, candidateId: "candidate:other" }),
          "request_conflict",
        );
        expectError(
          yield* tryAttempt(s, { ...exact, evaluationId: "eval-other" }),
          "request_conflict",
        );
        assert.deepStrictEqual(yield* ledger(s.missionId), settled);
      }),
    );
  }),
);

it.effect(
  "returns the original record for a new command id on the same evaluation without a new event",
  () =>
    Effect.gen(function* () {
      const h = harness();
      return yield* run(
        h,
        Effect.gen(function* () {
          const s = yield* scenario(h);
          const first = recorded(
            yield* tryAttempt(s, {
              commandId: "record-first",
              evaluationId: "eval-1",
              candidateId: "candidate:1",
            }),
          );
          const settled = yield* ledger(s.missionId);

          const alias = recorded(
            yield* tryAttempt(s, {
              commandId: "record-alias",
              evaluationId: "eval-1",
              candidateId: "candidate:1",
              // A stale expectedRevision is irrelevant for an already-recorded evaluation.
              expectedRevision: 0,
            }),
          );
          assert.isTrue(alias.recovered);
          assert.isFalse(alias.committed);
          assert.deepStrictEqual(alias.record, first.record);
          assert.strictEqual(alias.eventSequence, first.eventSequence);
          assert.strictEqual(alias.receipt.commandId, "record-alias");
          assert.strictEqual(alias.receipt.resultSequence, first.eventSequence);
          // The alias is a receipt only: no event, revision, or record of its own.
          assert.deepStrictEqual(yield* ledger(s.missionId), settled);
          const aliasReceipt = Option.getOrThrow(yield* receiptFor("record-alias"));
          assert.strictEqual(aliasReceipt.resultSequence, first.eventSequence);

          // The alias replays too, from its own receipt.
          const aliasReplay = recorded(
            yield* tryAttempt(s, {
              commandId: "record-alias",
              evaluationId: "eval-1",
              candidateId: "candidate:1",
              expectedRevision: 0,
            }),
          );
          assert.deepStrictEqual(aliasReplay.record, first.record);
          assert.deepStrictEqual(yield* ledger(s.missionId), settled);

          // The same evaluation id with a different candidate or evidence is a conflict, never an overwrite.
          expectError(
            yield* tryAttempt(s, {
              commandId: "record-conflict-candidate",
              evaluationId: "eval-1",
              candidateId: "candidate:changed",
            }),
            "binding_conflict",
          );
          expectError(
            yield* tryAttempt(s, {
              commandId: "record-conflict-evidence",
              evaluationId: "eval-1",
              candidateId: "candidate:1",
              evidenceSha: sha("changed evidence"),
            }),
            "binding_conflict",
          );
          assert.deepStrictEqual(yield* ledger(s.missionId), settled);
          assert.deepStrictEqual(recordsOf(yield* current(s.missionId)), [first.record]);
          assert.isTrue(Option.isNone(yield* receiptFor("record-conflict-candidate")));
        }),
      );
    }),
);

it.effect(
  "never rebinds an evidence digest, a candidate's origin report, or its target skill",
  () =>
    Effect.gen(function* () {
      const h = harness();
      return yield* run(
        h,
        Effect.gen(function* () {
          const s = yield* scenario(h);
          const second = yield* stageReport(h, s.missionId, { from: 10, to: 11, tag: "mission-b" });
          assert.notStrictEqual(second.sourceReportHash, s.report.sourceReportHash);
          const first = recorded(
            yield* tryAttempt(s, { evaluationId: "eval-1", candidateId: "candidate:1" }),
          );
          const settled = yield* ledger(s.missionId);

          // One evidence digest names one evaluation.
          expectError(
            yield* tryAttempt(s, {
              evaluationId: "eval-other",
              candidateId: "candidate:other",
              evidenceSha: sha("evidence:eval-1"),
            }),
            "binding_conflict",
          );
          // The same candidate bound to a different canonical report.
          expectError(
            yield* tryAttempt(s, {
              evaluationId: "eval-moved",
              candidateId: "candidate:1",
              report: second,
            }),
            "binding_conflict",
          );
          // The same candidate retargeted at another skill.
          expectError(
            yield* tryAttempt(s, {
              evaluationId: "eval-retargeted",
              candidateId: "candidate:1",
              target: "skills/another/SKILL.md",
            }),
            "binding_conflict",
          );
          assert.deepStrictEqual(yield* ledger(s.missionId), settled);

          // A genuinely new evaluation of the same candidate (new id, new evidence) appends beside it.
          const rerun = recorded(
            yield* tryAttempt(s, { evaluationId: "eval-rerun", candidateId: "candidate:1" }),
          );
          assert.isTrue(rerun.committed);
          assert.deepStrictEqual(
            recordsOf(yield* current(s.missionId)).map((record) => record.evaluationId),
            ["eval-1", "eval-rerun"],
          );
          assert.deepStrictEqual(recordsOf(yield* current(s.missionId))[0], first.record);
          // And a different candidate may bind the second canonical report.
          const other = recorded(
            yield* tryAttempt(s, {
              evaluationId: "eval-b",
              candidateId: "candidate:b",
              report: second,
            }),
          );
          assert.strictEqual(other.record.sourceReportHash, second.sourceReportHash);
        }),
      );
    }),
);

// ---------------------------------------------------------------------------
// Authority, scope, and evidence binding
// ---------------------------------------------------------------------------

const DENIALS: ReadonlyArray<{
  readonly name: string;
  readonly category: "scope_denied" | "request_conflict";
  readonly edit: (draft: Draft) => void;
}> = [
  {
    name: "facts team",
    category: "scope_denied",
    edit: (d) => {
      d.teamId = "other-team";
    },
  },
  {
    name: "facts environment",
    category: "scope_denied",
    edit: (d) => {
      d.environmentId = "other-env";
    },
  },
  {
    name: "facts mission",
    category: "scope_denied",
    edit: (d) => {
      d.missionId = "other-mission";
    },
  },
  {
    name: "facts retro thread",
    category: "scope_denied",
    edit: (d) => {
      d.retroThreadId = "other-thread";
    },
  },
  {
    name: "facts retro epoch",
    category: "scope_denied",
    edit: (d) => {
      d.retroEpoch = 5;
    },
  },
  {
    name: "facts observed revision",
    category: "request_conflict",
    edit: (d) => {
      d.observedRevision = 0;
    },
  },
  {
    name: "context team",
    category: "scope_denied",
    edit: (d) => {
      evaluationOf(d).context.scope.teamId = "other-team";
    },
  },
  {
    name: "context environment",
    category: "scope_denied",
    edit: (d) => {
      evaluationOf(d).context.scope.environmentId = "other-env";
    },
  },
  {
    name: "context origin mission",
    category: "scope_denied",
    edit: (d) => {
      evaluationOf(d).context.scope.originMissionId = "other-mission";
    },
  },
  {
    name: "context candidate",
    category: "scope_denied",
    edit: (d) => {
      evaluationOf(d).context.scope.candidateId = "candidate:other";
    },
  },
  {
    name: "context unknown source report hash",
    category: "scope_denied",
    edit: (d) => {
      evaluationOf(d).context.scope.sourceReportHash = sha("nothing");
    },
  },
  {
    name: "context wrong normalized report hash",
    category: "scope_denied",
    edit: (d) => {
      evaluationOf(d).context.scope.normalizedReportHash = sha("nothing");
    },
  },
  {
    name: "context malformed",
    category: "scope_denied",
    edit: (d) => {
      evaluationOf(d).context.scope.targetSkillRef = "../escape";
    },
  },
  {
    name: "evidence digest differs from the command",
    category: "scope_denied",
    edit: (d) => {
      const e = evaluationOf(d).evidence;
      e.artifactSha = sha("other");
      e.artifactRef = `skill-replay-evidence:${sha("other")}`;
    },
  },
  {
    name: "evidence digest differs but the pointer matches",
    category: "scope_denied",
    edit: (d) => {
      evaluationOf(d).evidence.artifactSha = sha("other");
    },
  },
  {
    name: "evidence pointer differs but the digest matches",
    category: "scope_denied",
    edit: (d) => {
      evaluationOf(d).evidence.artifactRef = `skill-replay-evidence:${sha("other")}`;
    },
  },
  {
    name: "producer consistently names an unknown source report",
    category: "scope_denied",
    edit: (d) => {
      const e = evaluationOf(d);
      e.context.scope.sourceReportHash = sha("nothing");
      e.evidence.binding.sourceReportHash = sha("nothing");
    },
  },
  {
    name: "producer consistently names the wrong normalized report",
    category: "scope_denied",
    edit: (d) => {
      const e = evaluationOf(d);
      e.context.scope.normalizedReportHash = sha("nothing");
      e.evidence.binding.normalizedReportHash = sha("nothing");
    },
  },
  {
    name: "validator rejects a malformed context",
    category: "scope_denied",
    edit: (d) => {
      Object.assign(evaluationOf(d).context, { approved: true });
    },
  },
  {
    name: "validator rejects a malformed candidate",
    category: "scope_denied",
    edit: (d) => {
      evaluationOf(d).candidate = { claimedPass: true };
    },
  },
  {
    name: "evidence verification mismatch",
    category: "scope_denied",
    edit: (d) => {
      evaluationOf(d).evidence.verification = "mismatch";
    },
  },
  {
    name: "evidence binding team",
    category: "scope_denied",
    edit: (d) => {
      evaluationOf(d).evidence.binding.teamId = "other-team";
    },
  },
  {
    name: "evidence binding environment",
    category: "scope_denied",
    edit: (d) => {
      evaluationOf(d).evidence.binding.environmentId = "other-env";
    },
  },
  {
    name: "evidence binding mission",
    category: "scope_denied",
    edit: (d) => {
      evaluationOf(d).evidence.binding.missionId = "other-mission";
    },
  },
  {
    name: "evidence binding retro epoch",
    category: "scope_denied",
    edit: (d) => {
      evaluationOf(d).evidence.binding.retroEpoch = 3;
    },
  },
  {
    name: "evidence binding source hash",
    category: "scope_denied",
    edit: (d) => {
      evaluationOf(d).evidence.binding.sourceReportHash = sha("nothing");
    },
  },
  {
    name: "evidence binding normalized hash",
    category: "scope_denied",
    edit: (d) => {
      evaluationOf(d).evidence.binding.normalizedReportHash = sha("nothing");
    },
  },
  {
    name: "evidence binding candidate",
    category: "scope_denied",
    edit: (d) => {
      evaluationOf(d).evidence.binding.candidateId = "candidate:other";
    },
  },
  {
    name: "evidence binding evaluation",
    category: "scope_denied",
    edit: (d) => {
      evaluationOf(d).evidence.binding.evaluationId = "eval-other";
    },
  },
  {
    name: "evidence binding target skill",
    category: "scope_denied",
    edit: (d) => {
      evaluationOf(d).evidence.binding.targetSkillRef = "skills/other/SKILL.md";
    },
  },
  {
    name: "evidence binding old skill",
    category: "scope_denied",
    edit: (d) => {
      evaluationOf(d).evidence.binding.oldSkillSha256 = sha("other");
    },
  },
  {
    name: "evidence binding new skill",
    category: "scope_denied",
    edit: (d) => {
      evaluationOf(d).evidence.binding.newSkillSha256 = sha("other");
    },
  },
  {
    name: "facts without a currency fence",
    category: "scope_denied",
    edit: (d) => {
      const partial: Partial<Draft> = d;
      delete partial.fence;
    },
  },
  {
    name: "excess producer field",
    category: "scope_denied",
    edit: (d) => {
      Object.assign(d, { approved: true });
    },
  },
];

it.effect(
  "denies any producer fact that does not bind the canonical scope, report, and evidence",
  () =>
    Effect.gen(function* () {
      const h = harness();
      return yield* run(
        h,
        Effect.gen(function* () {
          const s = yield* scenario(h);
          const untouched = yield* ledger(s.missionId);
          for (const denial of DENIALS) {
            const commandId = `record-denied-${denial.name}`;
            const result = yield* tryAttempt(s, {
              commandId,
              evaluationId: "eval-1",
              candidateId: "candidate:1",
              facts: tamper(denial.edit),
            });
            assert.deepStrictEqual(
              result,
              { kind: "error", category: denial.category },
              denial.name,
            );
            assert.deepStrictEqual(yield* ledger(s.missionId), untouched, denial.name);
            assert.isTrue(Option.isNone(yield* receiptFor(commandId)), denial.name);
          }
          // The same evaluation is fully recordable with faithful facts afterwards.
          const accepted = recorded(
            yield* tryAttempt(s, { evaluationId: "eval-1", candidateId: "candidate:1" }),
          );
          assert.isTrue(accepted.committed);
        }),
      );
    }),
);

it.effect("denies a caller that is not the current Retro role", () =>
  Effect.gen(function* () {
    const variants: ReadonlyArray<{
      readonly name: string;
      readonly authority: NonNullable<HarnessOptions["authority"]>;
    }> = [
      { name: "other retro thread", authority: { retroThreadId: "someone-else" } },
      { name: "stale retro epoch", authority: { retroEpoch: 3 } },
      { name: "other team", authority: { teamId: "other-team" } },
      { name: "other environment", authority: { environmentId: "other-env" } },
    ];
    for (const variant of variants) {
      const h = harness({ authority: variant.authority });
      yield* run(
        h,
        Effect.gen(function* () {
          const s = yield* scenario(h);
          const untouched = yield* ledger(s.missionId);
          expectError(
            yield* tryAttempt(s, { evaluationId: "eval-1", candidateId: "candidate:1" }),
            "scope_denied",
          );
          assert.deepStrictEqual(yield* ledger(s.missionId), untouched, variant.name);
          assert.isTrue(Option.isNone(yield* receiptFor("record-1")), variant.name);
        }),
      );
    }
    // The delivery manager thread is not the Retro role even though it owns the mission.
    const delivery = harness({ authority: { retroThreadId: "delivery" } });
    yield* run(
      delivery,
      Effect.gen(function* () {
        const s = yield* scenario(delivery);
        expectError(yield* tryAttempt(s), "scope_denied");
      }),
    );
  }),
);

it.effect(
  "denies without reading facts once the private authority is revoked, and after a Retro rotation",
  () =>
    Effect.gen(function* () {
      const h = harness();
      return yield* run(
        h,
        Effect.gen(function* () {
          const s = yield* scenario(h);
          const exact = {
            commandId: "record-first",
            evaluationId: "eval-1",
            candidateId: "candidate:1",
            expectedRevision: (yield* current(s.missionId)).revision,
          };
          const first = recorded(yield* tryAttempt(s, exact));
          const settled = yield* ledger(s.missionId);

          h.world.authorityOk = false;
          const callsBefore = h.world.factsCalls;
          expectError(yield* tryAttempt(s, exact), "scope_denied");
          assert.strictEqual(
            h.world.factsCalls,
            callsBefore,
            "a revoked authority never asks the producer for facts",
          );
          h.world.authorityOk = true;

          // Replay passes the current role gates again once the authority is back.
          assert.deepStrictEqual(recorded(yield* tryAttempt(s, exact)).record, first.record);

          // Retro rotates: planted manager change (NOT a genuine lifecycle transition).
          yield* plant(s.missionId, (mission) =>
            decodeFixture({
              ...mission,
              managers: { ...mission.managers, retro: { threadId: "retro-successor", epoch: 5 } },
            }),
          );
          expectError(yield* tryAttempt(s, exact), "scope_denied");
          assert.deepStrictEqual(yield* ledger(s.missionId), settled);
        }),
      );
    }),
);

// ---------------------------------------------------------------------------
// Holds: unknown stays held, and nothing is persisted
// ---------------------------------------------------------------------------

it.effect("holds without persisting while a fact is unknown, then records once it clears", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* run(
      h,
      Effect.gen(function* () {
        const s = yield* scenario(h);
        const untouched = yield* ledger(s.missionId);
        const holds: ReadonlyArray<{
          readonly name: string;
          readonly code: string;
          readonly facts: (base: Facts) => Facts;
        }> = [
          {
            name: "stop unknown",
            code: "facts_unknown",
            facts: tamper((d) => {
              d.userStopRequested = null;
            }),
          },
          {
            name: "pause unknown",
            code: "facts_unknown",
            facts: tamper((d) => {
              d.userPauseRequested = null;
            }),
          },
          {
            name: "user stop",
            code: "user_stop",
            facts: tamper((d) => {
              d.userStopRequested = true;
            }),
          },
          {
            name: "user pause",
            code: "user_pause",
            facts: tamper((d) => {
              d.userPauseRequested = true;
            }),
          },
          {
            name: "evaluation facts null",
            code: "facts_unknown",
            facts: tamper((d) => {
              d.evaluation = null;
            }),
          },
          {
            name: "evaluation facts absent",
            code: "facts_unknown",
            facts: tamper((d) => {
              delete d.evaluation;
            }),
          },
          {
            name: "evidence unverified",
            code: "evidence_unverified",
            facts: tamper((d) => {
              evaluationOf(d).evidence.verification = "unknown";
            }),
          },
        ];
        for (const held of holds) {
          const commandId = `record-hold-${held.name}`;
          expectHold(
            yield* tryAttempt(s, {
              commandId,
              evaluationId: "eval-1",
              candidateId: "candidate:1",
              facts: held.facts,
            }),
            held.code,
          );
          assert.deepStrictEqual(yield* ledger(s.missionId), untouched, held.name);
          assert.isTrue(Option.isNone(yield* receiptFor(commandId)), held.name);
        }
        // A transient hold leaves the command id reusable: the SAME id records once the fact clears.
        const cleared = recorded(
          yield* tryAttempt(s, {
            commandId: "record-hold-user pause",
            evaluationId: "eval-1",
            candidateId: "candidate:1",
          }),
        );
        assert.isTrue(cleared.committed);
      }),
    );
  }),
);

it.effect("never returns a recorded outcome under a pause, a stop, or an inactive mission", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* run(
      h,
      Effect.gen(function* () {
        const s = yield* scenario(h);
        const same = {
          commandId: "record-first",
          evaluationId: "eval-1",
          candidateId: "candidate:1",
          expectedRevision: (yield* current(s.missionId)).revision,
        };
        const first = recorded(yield* tryAttempt(s, same));
        const settled = yield* ledger(s.missionId);

        // Replay and alias are gated BEFORE the receipt lookup.
        expectHold(
          yield* tryAttempt(s, {
            ...same,
            facts: tamper((d) => {
              d.userPauseRequested = true;
            }),
          }),
          "user_pause",
        );
        expectHold(
          yield* tryAttempt(s, {
            ...same,
            facts: tamper((d) => {
              d.userStopRequested = true;
            }),
          }),
          "user_stop",
        );
        expectHold(
          yield* tryAttempt(s, {
            ...same,
            facts: tamper((d) => {
              d.userPauseRequested = null;
            }),
          }),
          "facts_unknown",
        );
        expectHold(
          yield* tryAttempt(s, {
            ...same,
            commandId: "record-alias",
            facts: tamper((d) => {
              d.userPauseRequested = true;
            }),
          }),
          "user_pause",
        );
        assert.isTrue(Option.isNone(yield* receiptFor("record-alias")));

        // Planted status (NOT a genuine lifecycle transition): a non-active mission holds every branch.
        for (const status of ["paused", "stopped", "completed"] as const) {
          yield* plant(s.missionId, (mission) => ({ ...mission, status }));
          expectHold(yield* tryAttempt(s, same), "mission_inactive");
          expectHold(
            yield* tryAttempt(s, { evaluationId: "eval-new", candidateId: "candidate:new" }),
            "mission_inactive",
          );
        }
        yield* plant(s.missionId, (mission) => ({ ...mission, status: "active" }));
        assert.deepStrictEqual(yield* ledger(s.missionId), settled);

        // Once the gates clear the original record is returned unchanged.
        const replay = recorded(yield* tryAttempt(s, same));
        assert.deepStrictEqual(replay.record, first.record);
        assert.isTrue(replay.recovered);
      }),
    );
  }),
);

it.effect(
  "holds when the canonical origin report is partial, held, quarantined, or carries no candidates",
  () =>
    Effect.gen(function* () {
      const h = harness();
      return yield* run(
        h,
        Effect.gen(function* () {
          const s = yield* scenario(h);
          const partial = yield* stageReport(h, s.missionId, {
            from: 10,
            to: 11,
            tag: "partial",
            coverage: { readReceipts: [] },
          });
          assert.strictEqual(partial.disposition, "held_partial");
          const noCandidates = yield* stageReport(h, s.missionId, {
            from: 20,
            to: 21,
            tag: "empty",
            kind: "no_change",
          });
          assert.strictEqual(noCandidates.disposition, "queued_for_triage");
          // Same checkpoint and revision, changed source hash: quarantined as a held conflict.
          const variantReport = s.report.reportFor({
            ...candidateBody("variant"),
            summary: "a different summary",
          });
          const variantOutcome = ok(yield* s.report.receiveVariant(variantReport, "variant"));
          assert.strictEqual(variantOutcome.disposition, "held_conflict");
          const quarantinedHash = variantOutcome.sourceReportHash;
          assert.notStrictEqual(quarantinedHash, s.report.sourceReportHash);
          const untouched = yield* ledger(s.missionId);

          for (const [name, report] of [
            ["partial", partial],
            ["no candidates", noCandidates],
          ] as const) {
            expectHold(
              yield* tryAttempt(s, {
                evaluationId: `eval-${name}`,
                candidateId: `candidate:${name}`,
                report,
              }),
              "report_ineligible",
            );
          }
          // The quarantined variant hash is known to canonical state but never eligible.
          expectHold(
            yield* tryAttempt(s, {
              evaluationId: "eval-quarantined",
              candidateId: "candidate:quarantined",
              report: {
                ...s.report,
                sourceReportHash: quarantinedHash,
                normalizedReportHash: variantOutcome.normalizedReportHash,
              },
            }),
            "report_ineligible",
          );
          assert.deepStrictEqual(yield* ledger(s.missionId), { ...untouched });
          assert.strictEqual((yield* evalEvents(s.missionId)).length, 0);

          // A partial or empty report never mints ANY recorded outcome, ready or otherwise.
          for (const variant of ["ready", "hold", "rejected", "no_change"] as const) {
            expectHold(
              yield* tryAttempt(s, {
                evaluationId: `eval-partial-${variant}`,
                candidateId: `candidate:partial-${variant}`,
                report: partial,
                variant,
              }),
              "report_ineligible",
            );
          }
          assert.strictEqual((yield* evalEvents(s.missionId)).length, 0);

          // The eligible canonical report still records.
          assert.isTrue(
            recorded(yield* tryAttempt(s, { evaluationId: "eval-ok", candidateId: "candidate:ok" }))
              .committed,
          );
        }),
      );
    }),
);

// ---------------------------------------------------------------------------
// Bound
// ---------------------------------------------------------------------------

it.effect("keeps 64 outcomes, denies the 65th, and never prunes an old one", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* run(
      h,
      Effect.gen(function* () {
        const s = yield* scenario(h);
        const startRevision = (yield* current(s.missionId)).revision;
        for (let index = 0; index < 64; index += 1) {
          const result = recorded(
            yield* tryAttempt(s, {
              commandId: `record-bulk-${index}`,
              evaluationId: `eval-bulk-${index}`,
              candidateId: `candidate:bulk-${index}`,
              ...(index === 0 ? { expectedRevision: startRevision } : {}),
            }),
          );
          assert.isTrue(result.committed);
        }
        const full = yield* current(s.missionId);
        assert.strictEqual(recordsOf(full).length, 64);
        const fullLedger = yield* ledger(s.missionId);

        expectError(
          yield* tryAttempt(s, {
            commandId: "record-overflow",
            evaluationId: "eval-overflow",
            candidateId: "candidate:overflow",
          }),
          "bound_exceeded",
        );
        assert.deepStrictEqual(yield* ledger(s.missionId), fullLedger);
        assert.isTrue(Option.isNone(yield* receiptFor("record-overflow")));
        assert.deepStrictEqual(recordsOf(yield* current(s.missionId)), recordsOf(full));

        // A full array still replays and aliases an existing outcome.
        const replay = recorded(
          yield* tryAttempt(s, {
            commandId: "record-bulk-0",
            evaluationId: "eval-bulk-0",
            candidateId: "candidate:bulk-0",
            expectedRevision: startRevision,
          }),
        );
        assert.strictEqual(replay.record.evaluationId, "eval-bulk-0");
        const alias = recorded(
          yield* tryAttempt(s, {
            commandId: "record-bulk-alias",
            evaluationId: "eval-bulk-63",
            candidateId: "candidate:bulk-63",
          }),
        );
        assert.strictEqual(alias.record.evaluationId, "eval-bulk-63");
        assert.deepStrictEqual(yield* ledger(s.missionId), fullLedger);
      }),
    );
  }),
);

// ---------------------------------------------------------------------------
// Atomicity: CAS race, revocation, and captured-fact integrity
// ---------------------------------------------------------------------------

it.effect(
  "rolls event, projection, and receipt back on a CAS race or a revoked private callback",
  () =>
    Effect.gen(function* () {
      const h = harness();
      return yield* run(
        h,
        Effect.gen(function* () {
          const s = yield* scenario(h);
          const untouched = yield* ledger(s.missionId);
          const failures: ReadonlyArray<{
            readonly name: string;
            readonly arm: () => void;
            readonly category: string;
          }> = [
            {
              name: "revision race",
              arm: () => {
                h.world.bumpRevisionAfterAppend = true;
              },
              category: "request_conflict",
            },
            {
              name: "producer revoked after append",
              arm: () => {
                h.world.revokeAfter = { at: "append", what: "fence" };
              },
              category: "scope_denied",
            },
            {
              name: "authority revoked after append",
              arm: () => {
                h.world.revokeAfter = { at: "append", what: "authority" };
              },
              category: "scope_denied",
            },
            {
              name: "producer revoked after receipt",
              arm: () => {
                h.world.revokeAfter = { at: "receipt", what: "fence" };
              },
              category: "scope_denied",
            },
            {
              name: "authority revoked after receipt",
              arm: () => {
                h.world.revokeAfter = { at: "receipt", what: "authority" };
              },
              category: "scope_denied",
            },
          ];
          for (const failure of failures) {
            failure.arm();
            expectError(
              yield* tryAttempt(s, {
                commandId: "record-rollback",
                evaluationId: "eval-1",
                candidateId: "candidate:1",
              }),
              failure.category,
            );
            h.world.bumpRevisionAfterAppend = false;
            h.world.revokeAfter = null;
            h.world.fence = "fence-1";
            h.world.authorityOk = true;
            assert.deepStrictEqual(yield* ledger(s.missionId), untouched, failure.name);
            assert.strictEqual((yield* evalEvents(s.missionId)).length, 0, failure.name);
            assert.isTrue(Option.isNone(yield* receiptFor("record-rollback")), failure.name);
          }
          // Nothing leaked: the very same command now commits exactly once.
          const committed = recorded(
            yield* tryAttempt(s, {
              commandId: "record-rollback",
              evaluationId: "eval-1",
              candidateId: "candidate:1",
            }),
          );
          assert.isTrue(committed.committed);
          assert.strictEqual((yield* evalEvents(s.missionId)).length, 1);
        }),
      );
    }),
);

it.effect("binds a detached deep-frozen snapshot of the producer facts", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* run(
      h,
      Effect.gen(function* () {
        const s = yield* scenario(h);

        // A currency callback sees an immutable snapshot, all the way down.
        h.world.currencyProbe = "observe-frozen";
        recorded(yield* tryAttempt(s, { evaluationId: "eval-1", candidateId: "candidate:1" }));
        assert.deepStrictEqual(h.world.frozen, {
          facts: true,
          evaluation: true,
          context: true,
          pairs: true,
          firstPair: true,
        });

        // A callback that mutates what it inspects cannot bypass the gate: the frozen snapshot throws.
        h.world.currencyProbe = "mutate-snapshot";
        expectError(
          yield* tryAttempt(s, {
            commandId: "record-mutate",
            evaluationId: "eval-2",
            candidateId: "candidate:2",
            facts: tamper((d) => {
              d.userStopRequested = true;
            }),
          }),
          "scope_denied",
        );
        assert.strictEqual((yield* ledger(s.missionId)).records, 1);
        assert.isTrue(Option.isNone(yield* receiptFor("record-mutate")));

        // The producer rewriting ITS OWN object after the store detached it changes nothing recorded.
        h.world.currencyProbe = "mutate-own-copy";
        const detached = recorded(
          yield* tryAttempt(s, { evaluationId: "eval-3", candidateId: "candidate:3" }),
        );
        assert.strictEqual(detached.record.kind, "review_ready");
        assert.deepStrictEqual(detached.record.failurePairs, {
          required: 1,
          observed: 1,
          oldPass: 0,
          newPass: 1,
        });
      }),
    );
  }),
);

// ---------------------------------------------------------------------------
// Command strictness, opaque ids, and preserved state
// ---------------------------------------------------------------------------

it.effect("accepts only the strict identity command and bounded opaque ids", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* run(
      h,
      Effect.gen(function* () {
        const s = yield* scenario(h);
        const untouched = yield* ledger(s.missionId);
        const invalid: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
          ["verdict field", { kind: "review_ready" }],
          ["reason field", { reason: "ready_fix_verified" }],
          ["claimed pass", { claimedPass: true }],
          ["caller source hash", { sourceReportHash: sha("x") }],
          ["caller reviewer", { reviewerRef: "reviewer" }],
          ["caller authority", { authority: { teamId: "team" } }],
          ["missing mission", { missionId: undefined }],
          [
            "evidence pointer digest mismatch",
            { evidenceArtifactRef: `skill-replay-evidence:${sha("other")}` },
          ],
          [
            "uppercase evidence digest",
            { evidenceArtifactSha: sha("evidence:eval-1").toUpperCase() },
          ],
          ["command id over 512", { commandId: "c".repeat(513) }],
          ["evaluation id over 256", { evaluationId: "e".repeat(257) }],
          ["candidate id over 256", { candidateId: "c".repeat(257) }],
          ["negative revision", { expectedRevision: -1 }],
          ["fractional revision", { expectedRevision: 1.5 }],
          ["clone-unsafe field", { notCloneable: () => 1 }],
        ];
        for (const [name, patch] of invalid) {
          expectError(
            yield* tryAttempt(s, {
              evaluationId: "eval-1",
              candidateId: "candidate:1",
              command: patch,
            }),
            "invalid_command",
          );
          assert.deepStrictEqual(yield* ledger(s.missionId), untouched, name);
        }
        assert.strictEqual(h.world.factsCalls, 0, "an invalid command never reaches the producer");

        // A fresh command must name the canonical revision it read.
        for (const expectedRevision of [untouched.revision - 1, untouched.revision + 1]) {
          expectError(
            yield* tryAttempt(s, {
              commandId: `record-stale-${expectedRevision}`,
              evaluationId: "eval-1",
              candidateId: "candidate:1",
              expectedRevision,
            }),
            "request_conflict",
          );
          assert.deepStrictEqual(yield* ledger(s.missionId), untouched);
        }

        // Opaque ids at their exact bounds are accepted.
        const longCommand = "c".repeat(512);
        const edge = recorded(
          yield* tryAttempt(s, {
            commandId: longCommand,
            evaluationId: "e".repeat(256),
            candidateId: "c".repeat(256),
          }),
        );
        assert.strictEqual(edge.record.evaluationId.length, 256);
        assert.strictEqual(edge.record.candidateId.length, 256);
        assert.strictEqual(edge.receipt.commandId, longCommand);
      }),
    );
  }),
);

it.effect("records an opaque Retro thread id up to 512 characters and denies a longer one", () =>
  Effect.gen(function* () {
    for (const [name, threadId, expected] of [
      ["opaque T3 thread id", OPAQUE_THREAD, "ok"],
      ["512 characters", "t".repeat(512), "ok"],
      ["513 characters", "t".repeat(513), "scope_denied"],
    ] as const) {
      const h = harness({ authority: { retroThreadId: threadId } });
      yield* run(
        h,
        Effect.gen(function* () {
          // The genuine report chain bounds its own manager id at 256, so stage under a
          // short thread and plant the long canonical Retro manager (NOT a lifecycle transition).
          const s = yield* scenario(h);
          yield* plant(s.missionId, (mission) =>
            decodeFixture({
              ...mission,
              managers: { ...mission.managers, retro: { threadId, epoch: 4 } },
            }),
          );
          const result = yield* tryAttempt(s, {
            evaluationId: "eval-1",
            candidateId: "candidate:1",
          });
          if (expected === "ok") {
            assert.strictEqual(recorded(result).record.recordedByThreadId, threadId, name);
          } else {
            expectError(result, expected);
          }
        }),
      );
    }
  }),
);

it.effect("preserves unrelated mission state and writes no outbox or dispatch work", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* run(
      h,
      Effect.gen(function* () {
        const s = yield* scenario(h);
        // Planted unrelated execution state (NOT genuine admission): preservation only.
        yield* plant(s.missionId, (mission) =>
          decodeFixture({
            ...mission,
            execution: {
              ...(mission.execution ?? emptyMissionExecution()),
              consumedExceptionIds: ["exception-1"],
              writerClaims: [
                {
                  scope: "/tmp/scope",
                  dispatchKey: "dispatch-1",
                  missionId: mission.id,
                  taskId: "task",
                  attemptNumber: 1,
                  operation: "write",
                },
              ],
            },
          }),
        );
        const sql = yield* SqlClient.SqlClient;
        const outbox = () =>
          Effect.gen(function* () {
            const rows = yield* sql<{
              count: number;
            }>`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox`;
            return rows[0]?.count;
          });
        const before = yield* current(s.missionId);
        const outboxBefore = yield* outbox();
        const eventsBefore = (yield* ledger(s.missionId)).events;
        assert.isAbove(before.execution?.retroCheckpoints?.length ?? 0, 0);
        assert.isAbove(before.execution?.retroReportReceipts?.length ?? 0, 0);

        recorded(yield* tryAttempt(s, { evaluationId: "eval-1", candidateId: "candidate:1" }));

        const after = yield* current(s.missionId);
        const strip = (mission: MissionValue) => ({
          ...mission,
          revision: 0,
          updatedAt: "",
          execution: { ...mission.execution, retroSkillEvaluations: [] },
        });
        assert.deepStrictEqual(strip(after), strip(before));
        assert.strictEqual(after.revision, before.revision + 1);
        assert.deepStrictEqual(after.execution?.consumedExceptionIds, ["exception-1"]);
        assert.strictEqual(after.execution?.writerClaims.length, 1);
        assert.deepStrictEqual(after.managers, before.managers);
        assert.deepStrictEqual(after.intent, before.intent);
        // Exactly one new durable event, and no effect enqueued for any model, scheduler, or outbox.
        assert.strictEqual((yield* ledger(s.missionId)).events, eventsBefore + 1);
        assert.strictEqual(yield* outbox(), outboxBefore);
      }),
    );
  }),
);

it.effect("treats a throwing currency check as not current and rolls back", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* run(
      h,
      Effect.gen(function* () {
        const s = yield* scenario(h);
        const untouched = yield* ledger(s.missionId);

        h.world.currencyProbe = "throw";
        expectError(
          yield* tryAttempt(s, { evaluationId: "eval-1", candidateId: "candidate:1" }),
          "scope_denied",
        );
        h.world.currencyProbe = "off";
        h.world.authorityThrows = true;
        const callsBefore = h.world.factsCalls;
        expectError(
          yield* tryAttempt(s, { evaluationId: "eval-1", candidateId: "candidate:1" }),
          "scope_denied",
        );
        assert.strictEqual(h.world.factsCalls, callsBefore);
        h.world.authorityThrows = false;
        assert.deepStrictEqual(yield* ledger(s.missionId), untouched);

        assert.isTrue(
          recorded(yield* tryAttempt(s, { evaluationId: "eval-1", candidateId: "candidate:1" }))
            .committed,
        );
      }),
    );
  }),
);

it.effect("refuses to run inside a caller's transaction", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* run(
      h,
      Effect.gen(function* () {
        const s = yield* scenario(h);
        const untouched = yield* ledger(s.missionId);
        const sql = yield* SqlClient.SqlClient;
        const nested = yield* sql.withTransaction(
          tryAttempt(s, { evaluationId: "eval-1", candidateId: "candidate:1" }),
        );
        expectError(nested, "persistence");
        assert.deepStrictEqual(yield* ledger(s.missionId), untouched);
        assert.isTrue(Option.isNone(yield* receiptFor("record-1")));
      }),
    );
  }),
);

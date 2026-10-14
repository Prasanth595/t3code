import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  Mission,
  MissionId,
  TeamId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  MissionResultReceipt as MissionResultReceiptSchema,
  MissionResultRecord as MissionResultRecordSchema,
} from "../../../../packages/contracts/src/missionResult.ts";
import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { type MissionAdmissionRequest, dispatchKeyFor } from "./MissionAdmission.ts";
import * as MissionAdmissionStore from "./MissionAdmissionStore.ts";
import type {
  MissionResultArrival,
  MissionResultReceipt,
} from "./MissionResultReconciliation.ts";
import * as MissionResultStore from "./MissionResultStore.ts";
import * as MissionService from "./MissionService.ts";

/**
 * Dormant result store acceptance: seed a real mission through
 * MissionService, reserve through the real MissionAdmissionStore, then
 * initialize from a trusted runtime association and drive observe, review,
 * acceptance, git integration, and separate installed delivery through the
 * result store. Exact replays recover the saved outcome (even after later
 * revisions and across close/reopen); scope denials precede receipt lookup
 * and persist nothing. No sleeps or polling; concurrency via Effect.all.
 */

const NOW_MS = Date.parse("2026-10-14T03:00:00.000Z");
const iso = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms));
const BASE_COMMIT = "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d";
const COMMIT_A = "commit:aaa";
const COMMIT_B = "commit:bbb";
const AUTHORITY = { source: "mission-council", ref: "decision-2026-001" } as const;
const RESULT_REVISION = 3;
const scope = {
  teamId: TeamId.make("team-1"),
  environmentId: EnvironmentId.make("env-1"),
  controllerThreadId: ThreadId.make("thread-1"),
};

const decodeMission = Schema.decodeUnknownSync(Mission);

const missionFixture = (id: string, taskIds: ReadonlyArray<string>) =>
  decodeMission({
    schemaVersion: 1,
    id,
    revision: 0,
    teamId: "team-1",
    authorityEnvironmentId: "env-1",
    bindings: [
      {
        projectId: "project-1",
        workspaceRoot: "/tmp/project",
        baseCommit: BASE_COMMIT,
        ancestry: [BASE_COMMIT],
      },
    ],
    intent: {
      outcome: "Ship result reconciliation.",
      scope: ["results"],
      exclusions: [],
      authorityRefs: [{ ...AUTHORITY }],
      acceptanceCriteria: [{ id: "ac-1", text: "Reconcile once." }],
      decisions: [],
    },
    integrationTarget: { summary: "Root store follow-up." },
    managers: { delivery: { threadId: "thread-1", epoch: 3 } },
    status: "active",
    tasks: taskIds.map((taskId) => ({
      id: taskId,
      projectId: "project-1",
      title: `Task ${taskId}`,
      specHash: "hash-1",
      dependencyHashes: [],
      dependencies: [],
      acceptanceIds: ["ac-1"],
      updatedAt: iso(NOW_MS - 3_600_000),
    })),
    updatedAt: iso(NOW_MS - 3_600_000),
  });

const admissionFacts = (): MissionAdmissionStore.MissionAdmissionTrustedFacts => ({
  taskNecessary: true,
  nowMs: NOW_MS,
  teamId: "team-1",
  environmentId: "env-1",
  deliveryThreadId: "thread-1",
  deliveryEpoch: 3,
  account: {
    accountId: "acct-1",
    providerInstanceId: "codex_personal",
    billingMode: "subscription",
    company: "No Fun",
    verifiedAtMs: NOW_MS - 1_000,
  },
  route: {
    accountId: "acct-1",
    providerInstanceId: "codex_personal",
    billingMode: "subscription",
    modelId: "model-a",
    profile: "muse-focused high",
    capability: "writer",
    supportedModelIds: ["model-a", "model-b"],
  },
  usageLimits: {
    checkedAt: iso(NOW_MS - 60_000),
    windows: [
      { id: "five_hour", kind: "session", label: "5h", usedPercent: 50 },
      { id: "weekly", kind: "weekly", label: "weekly", usedPercent: 10 },
    ],
  },
  usageMaxObservationAgeMs: 30 * 60_000,
  host: {
    hostId: "test-host",
    bootId: "test-boot",
    ready: true,
    buildObserved: true,
    buildOk: true,
    toolchainObserved: true,
    toolchainOk: true,
    pressureObserved: true,
    pressureAcceptable: true,
    observedAtMs: NOW_MS - 5_000,
  },
  repository: {
    projectId: "project-1",
    workspaceRootRealpath: "/tmp/project",
    observedAncestry: [BASE_COMMIT],
    observedAtMs: NOW_MS - 5_000,
  },
  writerScope: "/tmp/project/work",
  sharedManifestScopes: ["/tmp/shared"],
  guiScopes: ["/tmp/gui"],
  dependencyReceipts: [],
});

const admissionRequest = (
  mission: Mission,
  taskId: string,
  operation: "write" | "read" = "write",
): MissionAdmissionRequest => ({
  mission,
  taskId,
  specHash: "hash-1",
  dependencyHashes: [],
  attempt: { attemptNumber: 1, operation },
  proposedAccountId: "acct-1",
  proposedProviderInstanceId: "codex_personal",
  proposedBillingMode: "subscription",
  modelId: "model-a",
  profile: "muse-focused high",
  promptHash: "prompt-1",
  optionsHash: "options-1",
  workspaceRoot: "/tmp/project",
  privilege: operation === "write" ? "writer" : "reader",
  rejectedRoutes: [],
});

type TrustedFacts = MissionResultStore.MissionResultTrustedFacts;
type Association = MissionResultStore.MissionResultTrustedAssociation;

const placeholderAssociation: Association = {
  childTaskId: "child-task-1",
  childThreadId: "child-thread-1",
  childRunId: "run-1",
  requiredAncestry: [BASE_COMMIT],
  initialCommitSet: [COMMIT_A, COMMIT_B],
  initialAncestry: [BASE_COMMIT, COMMIT_A, COMMIT_B],
  source: "subagent-run",
  sourceRef: "run-1",
  initialResultRevision: RESULT_REVISION,
  digests: { inputDigest: "unset", dependencyDigest: "unset", acceptanceDigest: "unset" },
  admissionDispatchKey: "unset",
  admissionRequestDigest: "unset",
  attemptNumber: 1,
  pendingChildRuns: false,
};

interface Harness {
  readonly state: { facts: TrustedFacts };
  readonly base: Layer.Layer<
    | MissionResultStore.MissionResultStore
    | MissionAdmissionStore.MissionAdmissionStore
    | MissionService.MissionService
    | EventStore.OrchestrationEventStore
    | Receipts.OrchestrationCommandReceiptRepository,
    never,
    SqlClient.SqlClient
  >;
}

const harness = (): Harness => {
  const state: { facts: TrustedFacts } = {
    facts: {
      teamId: "team-1",
      environmentId: "env-1",
      deliveryThreadId: "thread-1",
      deliveryEpoch: 3,
      nowMs: NOW_MS,
      association: placeholderAssociation,
    },
  };
  const authority = Layer.succeed(MissionService.MissionAuthority, scope);
  const resultPort = Layer.succeed(MissionResultStore.MissionResultFactsPort, {
    readFacts: () => Effect.succeed(state.facts),
  });
  const admissionPort = Layer.succeed(MissionAdmissionStore.MissionAdmissionFactsPort, {
    readFacts: () => Effect.succeed(admissionFacts()),
  });
  const base = Layer.mergeAll(
    MissionResultStore.layer.pipe(
      Layer.provide(EventStore.layer),
      Layer.provide(Receipts.layer),
      Layer.provide(authority),
      Layer.provide(resultPort),
    ),
    MissionAdmissionStore.layer.pipe(
      Layer.provide(EventStore.layer),
      Layer.provide(Receipts.layer),
      Layer.provide(authority),
      Layer.provide(admissionPort),
    ),
    MissionService.layer.pipe(
      Layer.provide(EventStore.layer),
      Layer.provide(Receipts.layer),
      Layer.provide(authority),
    ),
    EventStore.layer,
    Receipts.layer,
  );
  return { state, base };
};

const memory = (h: Harness) => h.base.pipe(Layer.provideMerge(Sqlite.layerMemory));

const encodeJsonMission = Schema.encodeEffect(Schema.fromJsonString(Mission));
const decodeJsonMission = Schema.decodeEffect(Schema.fromJsonString(Mission));
const decodeResultRecord = Schema.decodeEffect(MissionResultRecordSchema);
const decodeResultReceipt = Schema.decodeEffect(MissionResultReceiptSchema);

const currentMission = (missionId: string) =>
  Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    return Option.getOrThrow(yield* service.get(MissionId.make(missionId)));
  });

const eventCount = (missionId: string) =>
  Effect.gen(function* () {
    const events = yield* EventStore.OrchestrationEventStore;
    return (yield* events.readMissionEvents(MissionId.make(missionId))).length;
  });

const okExec = (result: MissionResultStore.MissionResultExecuteResult): MissionResultStore.MissionResultExecution => {
  assert.isTrue(Result.isSuccess(result));
  return Result.getOrThrow(result);
};
const failTag = (result: MissionResultStore.MissionResultExecuteResult): string => {
  assert.isTrue(Result.isFailure(result));
  return Result.isFailure(result) ? `${result.failure.operation}:${result.failure.category}` : assert.fail("expected failure");
};

/** Seed via MissionService and reserve via the real admission store. Returns the trusted association to install in facts. */
const seedReserveBind = (h: Harness, missionId: string, taskId: string, operation: "write" | "read" = "write") =>
  Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    const fixture = missionFixture(missionId, [taskId]);
    yield* service.execute({
      type: "mission.create",
      commandId: CommandId.make(`seed-${missionId}`),
      mission: fixture,
    });
    const admissionStore = yield* MissionAdmissionStore.MissionAdmissionStore;
    const reserved = yield* admissionStore.reserve(admissionRequest(fixture, taskId, operation));
    assert.isTrue(Result.isSuccess(reserved));
    const receipt = Result.getOrThrow(reserved).receipt;
    const canonical = yield* currentMission(missionId);
    const digests = MissionResultStore.canonicalResultDigests(canonical, taskId);
    assert.isDefined(digests);
    const association: Association = {
      ...placeholderAssociation,
      digests: digests!,
      admissionDispatchKey: receipt.dispatchKey,
      admissionRequestDigest: receipt.requestDigest,
    };
    h.state.facts = { ...h.state.facts, association };
    return { canonical, receipt, association };
  });

const cmd = (
  association: Association,
  overrides: Partial<MissionResultStore.MissionResultCommand>,
): MissionResultStore.MissionResultCommand => ({
  commandId: CommandId.make("result-cmd-1"),
  missionId: "mission-1",
  expectedRevision: 1,
  deliveryEpoch: 3,
  taskId: "task-a",
  dispatchKey: association.admissionDispatchKey,
  action: "initialize",
  summaryText: "Worker finished the task.",
  outcome: "completed",
  ...overrides,
});

const decisionReceipt = (
  kind: MissionResultReceipt["kind"],
  overrides: Partial<MissionResultReceipt> = {},
): MissionResultReceipt => ({
  kind,
  revision: RESULT_REVISION,
  commitSet: [COMMIT_A, COMMIT_B],
  evidenceKind:
    kind === "review"
      ? "test_report"
      : kind === "acceptance"
        ? "check_pass"
        : kind === "integration"
          ? "git_integration"
          : "installed_delivery",
  evidenceRef: `evidence:${kind}`,
  decidedBy: "thread-1",
  decidedAt: iso(NOW_MS),
  ...overrides,
});

const observeCmd = (h: Harness, association: Association, commandId: string, expectedRevision: number) =>
  Effect.gen(function* () {
    h.state.facts = {
      ...h.state.facts,
      observation: {
        childTaskId: association.childTaskId,
        childThreadId: association.childThreadId,
        childRunId: association.childRunId,
        resultRevision: RESULT_REVISION,
        pendingChildRuns: false,
        stage: "observed",
      },
    };
    const store = yield* MissionResultStore.MissionResultStore;
    return yield* store.execute(
      cmd(association, { commandId: CommandId.make(commandId), action: "observe", expectedRevision, summaryText: undefined, outcome: undefined }),
    );
  });

describe("MissionResultStore", () => {
  it.effect("initializes from the trusted association and drives observe-review-accept-integrate with installed delivery separate", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { association } = yield* seedReserveBind(h, "mission-1", "task-a");
      const store = yield* MissionResultStore.MissionResultStore;
      const initialized = okExec(yield* store.execute(cmd(association, { expectedRevision: 1 })));
      assert.isTrue(initialized.committed);
      assert.isFalse(initialized.recovered);
      assert.strictEqual(initialized.disposition, "advanced");
      // Identity comes from the trusted runtime association, never the caller.
      assert.strictEqual(initialized.record.provenance.childTaskId, "child-task-1");
      assert.strictEqual(initialized.record.provenance.childThreadId, "child-thread-1");
      assert.strictEqual(initialized.record.provenance.childRunId, "run-1");
      assert.deepStrictEqual(initialized.record.provenance.commitSet, [COMMIT_A, COMMIT_B]);
      assert.strictEqual(initialized.record.state, "produced");
      assert.strictEqual((yield* currentMission("mission-1")).revision, 2);

      const observed = okExec(yield* observeCmd(h, association, "result-observe-1", 2));
      assert.strictEqual(observed.record.state, "observed");

      const reviewed = okExec(
        yield* store.execute(
          cmd(association, {
            commandId: CommandId.make("result-review-1"),
            action: "review",
            expectedRevision: 3,
            summaryText: undefined,
            outcome: undefined,
            receipt: decisionReceipt("review"),
          }),
        ),
      );
      assert.strictEqual(reviewed.record.state, "reviewed");

      const accepted = okExec(
        yield* store.execute(
          cmd(association, {
            commandId: CommandId.make("result-accept-1"),
            action: "accept",
            expectedRevision: 4,
            summaryText: undefined,
            outcome: undefined,
            receipt: decisionReceipt("acceptance"),
          }),
        ),
      );
      assert.strictEqual(accepted.record.state, "accepted");
      // Source acceptance never infers installed delivery.
      assert.isUndefined(accepted.record.installedDeliveryReceipt);

      const integrated = okExec(
        yield* store.execute(
          cmd(association, {
            commandId: CommandId.make("result-integrate-1"),
            action: "integrate",
            expectedRevision: 5,
            summaryText: undefined,
            outcome: undefined,
            receipt: decisionReceipt("integration"),
          }),
        ),
      );
      assert.strictEqual(integrated.record.state, "integrated");
      assert.isUndefined(integrated.record.installedDeliveryReceipt);

      // A proposal alone cannot choose the installed build.
      const proposedOnly = yield* store.execute(
        cmd(association, {
          commandId: CommandId.make("result-installed-proposed"),
          action: "installed_delivery",
          expectedRevision: 6,
          summaryText: undefined,
          outcome: undefined,
          receipt: decisionReceipt("installed_delivery", { evidenceRef: "build:proposed" }),
        }),
      );
      assert.strictEqual(failTag(proposedOnly), "installed_delivery:evidence_mismatch");

      h.state.facts = { ...h.state.facts, installedBuildRef: "build:exact-1" };
      const wrongBuild = yield* store.execute(
        cmd(association, {
          commandId: CommandId.make("result-installed-wrong"),
          action: "installed_delivery",
          expectedRevision: 6,
          summaryText: undefined,
          outcome: undefined,
          receipt: decisionReceipt("installed_delivery", { evidenceRef: "build:other" }),
        }),
      );
      assert.strictEqual(failTag(wrongBuild), "installed_delivery:evidence_mismatch");

      const delivered = okExec(
        yield* store.execute(
          cmd(association, {
            commandId: CommandId.make("result-installed-1"),
            action: "installed_delivery",
            expectedRevision: 6,
            summaryText: undefined,
            outcome: undefined,
            receipt: decisionReceipt("installed_delivery", { evidenceRef: "build:exact-1" }),
          }),
        ),
      );
      assert.strictEqual(delivered.record.state, "integrated");
      assert.strictEqual(delivered.record.installedDeliveryReceipt?.evidenceRef, "build:exact-1");
      assert.strictEqual((yield* currentMission("mission-1")).revision, 7);
      // seed + admission + init + observe + review + accept + integrate + installed
      assert.strictEqual(yield* eventCount("mission-1"), 8);
    }).pipe(Effect.provide(memory(h)));
  });

  it.effect("recovers the exact duplicate once under concurrency and replays with no new writes", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { association } = yield* seedReserveBind(h, "mission-1", "task-a");
      const store = yield* MissionResultStore.MissionResultStore;
      const command = cmd(association, { expectedRevision: 1 });
      const results = yield* Effect.all([store.execute(command), store.execute(command)], {
        concurrency: 2,
      });
      const outs = results.map(okExec);
      assert.strictEqual(outs.filter((o) => o.committed).length, 1);
      assert.strictEqual(outs.filter((o) => o.recovered).length, 1);
      assert.deepStrictEqual(outs[0]!.receipt, outs[1]!.receipt);
      assert.deepStrictEqual(outs[0]!.record, outs[1]!.record);
      assert.strictEqual(outs[0]!.eventSequence, outs[1]!.eventSequence);
      assert.strictEqual((yield* currentMission("mission-1")).revision, 2);
      assert.strictEqual(yield* eventCount("mission-1"), 3);

      const replay = okExec(yield* store.execute(command));
      assert.isTrue(replay.recovered);
      assert.isFalse(replay.committed);
      assert.deepStrictEqual(replay.record, outs[0]!.record);
      assert.strictEqual((yield* currentMission("mission-1")).revision, 2);
      assert.strictEqual(yield* eventCount("mission-1"), 3);
    }).pipe(Effect.provide(memory(h)));
  });

  it.effect("reproduces the saved exact outcome across close/reopen even after later revisions, and conflicts on changed bytes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "combined-v3-result-" });
        const databasePath = `${directory}/state.sqlite`;
        const h = harness();
        const run = <A, E>(
          effect: Effect.Effect<
            A,
            E,
            | MissionResultStore.MissionResultStore
            | MissionAdmissionStore.MissionAdmissionStore
            | MissionService.MissionService
            | EventStore.OrchestrationEventStore
            | Receipts.OrchestrationCommandReceiptRepository
          >,
        ) => effect.pipe(Effect.provide(h.base.pipe(Layer.provideMerge(Sqlite.layerFromPath(databasePath)))));

        const first = yield* run(
          Effect.gen(function* () {
            const { association } = yield* seedReserveBind(h, "mission-1", "task-a");
            const store = yield* MissionResultStore.MissionResultStore;
            const initialized = okExec(yield* store.execute(cmd(association, { expectedRevision: 1 })));
            const observed = yield* observeCmd(h, association, "result-observe-1", 2);
            assert.strictEqual(okExec(observed).record.state, "observed");
            return { association, initialized };
          }),
        );

        const second = yield* run(
          Effect.gen(function* () {
            const store = yield* MissionResultStore.MissionResultStore;
            const replay = okExec(
              yield* store.execute(cmd(first.association, { expectedRevision: 1 })),
            );
            // The saved outcome is the produced record as committed, even
            // though the canonical revision has since advanced to observed.
            assert.isTrue(replay.recovered);
            assert.isFalse(replay.committed);
            assert.strictEqual(replay.record.state, "produced");
            assert.deepStrictEqual(replay.receipt, first.initialized.receipt);
            assert.strictEqual(replay.eventSequence, first.initialized.eventSequence);
            assert.strictEqual((yield* currentMission("mission-1")).revision, 3);
            assert.strictEqual(yield* eventCount("mission-1"), 4);

            const changedText = yield* store
              .execute(cmd(first.association, { expectedRevision: 1, summaryText: "Different bytes." }))
              .pipe(Effect.result);
            assert.isTrue(Result.isFailure(changedText));
            if (Result.isFailure(changedText)) assert.strictEqual(changedText.failure.category, "request_conflict");

            const changedRevision = yield* store
              .execute(cmd(first.association, { expectedRevision: 3 }))
              .pipe(Effect.result);
            assert.isTrue(Result.isFailure(changedRevision));
            if (Result.isFailure(changedRevision)) assert.strictEqual(changedRevision.failure.category, "request_conflict");
            assert.strictEqual(yield* eventCount("mission-1"), 4);
            return replay;
          }),
        );
        assert.deepStrictEqual(second.record, first.initialized.record);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("replays a failed domain command with its original rejection and preserves the snapshot", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { association } = yield* seedReserveBind(h, "mission-1", "task-a");
      const store = yield* MissionResultStore.MissionResultStore;
      okExec(yield* store.execute(cmd(association, { expectedRevision: 1 })));
      const premature = cmd(association, {
        commandId: CommandId.make("result-review-early"),
        action: "review",
        expectedRevision: 2,
        summaryText: undefined,
        outcome: undefined,
        receipt: decisionReceipt("review"),
      });
      const first = yield* store.execute(premature);
      assert.strictEqual(failTag(first), "review:invalid_transition");
      const replay = yield* store.execute(premature);
      assert.strictEqual(failTag(replay), "review:invalid_transition");
      if (Result.isFailure(first) && Result.isFailure(replay)) {
        assert.strictEqual(replay.failure.detail, first.failure.detail);
      }
      const canonical = yield* currentMission("mission-1");
      assert.strictEqual(canonical.revision, 2);
      assert.strictEqual(canonical.execution?.results?.[0]?.state, "produced");
      assert.strictEqual(yield* eventCount("mission-1"), 3);

      const changed = yield* store
        .execute({ ...premature, receipt: decisionReceipt("review", { evidenceRef: "evidence:changed" }) })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(changed));
      if (Result.isFailure(changed)) assert.strictEqual(changed.failure.category, "request_conflict");
    }).pipe(Effect.provide(memory(h)));
  });

  it.effect("denies wrong team, environment, epoch, and decidedBy before receipt replay and persists no scope denial", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { association } = yield* seedReserveBind(h, "mission-1", "task-a");
      const store = yield* MissionResultStore.MissionResultStore;
      const command = cmd(association, { expectedRevision: 1 });
      okExec(yield* store.execute(command));

      for (const facts of [
        { teamId: "foreign-team" },
        { environmentId: "foreign-env" },
        { deliveryEpoch: 2 },
      ]) {
        h.state.facts = { ...h.state.facts, association, ...facts };
        const denied = yield* store.execute(command).pipe(Effect.result);
        assert.isTrue(Result.isFailure(denied));
        if (Result.isFailure(denied)) assert.strictEqual(denied.failure.category, "scope_denied");
      }
      h.state.facts = { ...h.state.facts, association, teamId: "team-1", environmentId: "env-1", deliveryEpoch: 3 };
      const wrongCommandEpoch = yield* store
        .execute({ ...command, deliveryEpoch: 2 })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(wrongCommandEpoch));
      if (Result.isFailure(wrongCommandEpoch)) assert.strictEqual(wrongCommandEpoch.failure.category, "scope_denied");

      // A scope denial for a fresh command id persists no receipt at all.
      h.state.facts = { ...h.state.facts, association, teamId: "foreign-team" };
      const freshDenied = yield* store
        .execute(cmd(association, { commandId: CommandId.make("result-scope-denied"), expectedRevision: 2, action: "observe", summaryText: undefined, outcome: undefined }))
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(freshDenied));
      const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
      assert.isTrue(Option.isNone(yield* receipts.getByCommandId({ commandId: CommandId.make("result-scope-denied") })));
      h.state.facts = { ...h.state.facts, association, teamId: "team-1" };

      // An arbitrary receipt actor is denied; only the authentic controller decides.
      okExec(yield* observeCmd(h, association, "result-observe-1", 2));
      const arbitrary = yield* store.execute(
        cmd(association, {
          commandId: CommandId.make("result-review-arbitrary"),
          action: "review",
          expectedRevision: 3,
          summaryText: undefined,
          outcome: undefined,
          receipt: decisionReceipt("review", { decidedBy: "arbitrary-actor" }),
        }),
      );
      assert.strictEqual(failTag(arbitrary), "review:evidence_mismatch");
      assert.strictEqual((yield* currentMission("mission-1")).execution?.results?.[0]?.state, "observed");
      const authentic = okExec(
        yield* store.execute(
          cmd(association, {
            commandId: CommandId.make("result-review-authentic"),
            action: "review",
            expectedRevision: 3,
            summaryText: undefined,
            outcome: undefined,
            receipt: decisionReceipt("review"),
          }),
        ),
      );
      assert.strictEqual(authentic.record.state, "reviewed");
    }).pipe(Effect.provide(memory(h)));
  });

  it.effect("denies initialization with wrong input, dependency, criteria, ancestry, or admission digests", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { association } = yield* seedReserveBind(h, "mission-1", "task-a");
      const store = yield* MissionResultStore.MissionResultStore;
      const variants: Array<Association> = [
        { ...association, digests: { ...association.digests, inputDigest: "wrong-input" } },
        { ...association, digests: { ...association.digests, dependencyDigest: "wrong-deps" } },
        { ...association, digests: { ...association.digests, acceptanceDigest: "wrong-criteria" } },
        { ...association, requiredAncestry: ["commit:unrelated"] },
        { ...association, initialAncestry: [COMMIT_A, COMMIT_B] },
        { ...association, admissionRequestDigest: "wrong-admission-digest" },
        { ...association, admissionDispatchKey: "wrong-dispatch-key" },
      ];
      for (const [index, variant] of variants.entries()) {
        h.state.facts = { ...h.state.facts, association: variant };
        const denied = yield* store.execute(
          cmd(variant, { commandId: CommandId.make(`result-init-denied-${index}`), expectedRevision: 1 }),
        );
        assert.strictEqual(failTag(denied), "initialize:digest_mismatch");
      }
      h.state.facts = { ...h.state.facts, association };
      const canonical = yield* currentMission("mission-1");
      assert.strictEqual(canonical.revision, 1);
      assert.deepStrictEqual(canonical.execution?.results ?? [], []);
      assert.strictEqual(yield* eventCount("mission-1"), 2);
    }).pipe(Effect.provide(memory(h)));
  });

  it.effect("durably replays an association rejection even when later facts would allow it", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { association } = yield* seedReserveBind(h, "mission-1", "task-a");
      const store = yield* MissionResultStore.MissionResultStore;
      const command = cmd(association, { commandId: CommandId.make("bad-association"), expectedRevision: 1 });
      h.state.facts = { ...h.state.facts, association: { ...association, admissionRequestDigest: "wrong" } };
      assert.strictEqual(failTag(yield* store.execute(command)), "initialize:digest_mismatch");
      const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
      const persisted = Option.getOrThrow(yield* receipts.getByCommandId({ commandId: command.commandId }));
      assert.strictEqual(persisted.status, "rejected");
      h.state.facts = { ...h.state.facts, association };
      assert.strictEqual(failTag(yield* store.execute(command)), "initialize:digest_mismatch");
      const current = yield* currentMission("mission-1");
      assert.strictEqual(current.revision, 1);
      assert.deepStrictEqual(current.execution?.results ?? [], []);
      assert.strictEqual(yield* eventCount("mission-1"), 2);
    }).pipe(Effect.provide(memory(h)));
  });

  it.effect("ignores a fake dispatch key on non-initialize commands and denies promotion after a spec update", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { association } = yield* seedReserveBind(h, "mission-1", "task-a");
      const store = yield* MissionResultStore.MissionResultStore;
      okExec(yield* store.execute(cmd(association, { expectedRevision: 1 })));
      okExec(yield* observeCmd(h, association, "result-observe-1", 2));

      const fakeKey = yield* store.execute(
        cmd(association, {
          commandId: CommandId.make("result-review-fake-key"),
          action: "review",
          expectedRevision: 3,
          dispatchKey: "fake-dispatch-key",
          summaryText: undefined,
          outcome: undefined,
          receipt: decisionReceipt("review"),
        }),
      );
      assert.strictEqual(failTag(fakeKey), "freshness:digest_mismatch");
      let canonical = yield* currentMission("mission-1");
      assert.strictEqual(canonical.execution?.results?.[0]?.state, "observed");
      assert.isUndefined(canonical.execution?.results?.[0]?.reviewReceipt);

      const reviewed = okExec(
        yield* store.execute(
          cmd(association, {
            commandId: CommandId.make("result-review-1"),
            action: "review",
            expectedRevision: 3,
            summaryText: undefined,
            outcome: undefined,
            receipt: decisionReceipt("review"),
          }),
        ),
      );
      assert.strictEqual(reviewed.record.state, "reviewed");

      // Generic replacement changes the task spec and preserves the result.
      const service = yield* MissionService.MissionService;
      canonical = yield* currentMission("mission-1");
      yield* service.execute({
        type: "mission.replace",
        commandId: CommandId.make("replace-spec-1"),
        mission: {
          ...canonical,
          revision: canonical.revision + 1,
          tasks: canonical.tasks.map((task) => ({ ...task, specHash: "hash-2" })),
        },
        expectedRevision: canonical.revision,
        epoch: 3,
        authority: { ...AUTHORITY },
      });
      const replaced = yield* currentMission("mission-1");
      assert.strictEqual(replaced.execution?.results?.length, 1);
      assert.strictEqual(replaced.execution?.results?.[0]?.state, "reviewed");

      const staleAccept = yield* store.execute(
        cmd(association, {
          commandId: CommandId.make("result-accept-stale"),
          action: "accept",
          expectedRevision: replaced.revision,
          summaryText: undefined,
          outcome: undefined,
          receipt: decisionReceipt("acceptance"),
        }),
      );
      assert.strictEqual(failTag(staleAccept), "freshness:digest_mismatch");
      assert.strictEqual((yield* currentMission("mission-1")).execution?.results?.[0]?.state, "reviewed");
    }).pipe(Effect.provide(memory(h)));
  });

  it.effect("quarantines foreign arrivals, conflicts on changed source at the same revision, and supersedes a review on a newer commit", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { association } = yield* seedReserveBind(h, "mission-1", "task-a");
      const store = yield* MissionResultStore.MissionResultStore;
      const initialized = okExec(yield* store.execute(cmd(association, { expectedRevision: 1 })));
      const record = initialized.record;
      const arrivalFor = (overrides: Partial<MissionResultArrival>): MissionResultArrival => ({
        attemptNumber: 1,
        outcome: "completed",
        summaryText: record.summaryText,
        digests: { ...record.digests },
        provenance: { ...record.provenance },
        pendingChildRuns: false,
        cancellationRequested: false,
        ...overrides,
      });

      const foreign = okExec(
        yield* store.execute(
          cmd(association, {
            commandId: CommandId.make("result-arrive-foreign"),
            action: "arrive",
            expectedRevision: 2,
            summaryText: undefined,
            outcome: undefined,
            arrival: arrivalFor({
              summaryText: "Foreign child finished.",
              provenance: { ...record.provenance, childTaskId: "foreign-task", childThreadId: "foreign-thread", childRunId: "run-foreign", resultRevision: 9 },
            }),
          }),
        ),
      );
      assert.strictEqual(foreign.disposition, "held_stale");
      assert.strictEqual(foreign.record.summaryText, record.summaryText);
      assert.strictEqual(foreign.record.state, "produced");
      assert.strictEqual(foreign.record.quarantined.length, 1);

      const conflict = okExec(
        yield* store.execute(
          cmd(association, {
            commandId: CommandId.make("result-arrive-conflict"),
            action: "arrive",
            expectedRevision: 3,
            summaryText: undefined,
            outcome: undefined,
            arrival: arrivalFor({
              provenance: { ...record.provenance, source: "other-source", sourceRef: "other-ref" },
            }),
          }),
        ),
      );
      assert.strictEqual(conflict.disposition, "held_conflict");
      assert.deepStrictEqual(conflict.record.provenance.commitSet, [COMMIT_A, COMMIT_B]);
      assert.strictEqual(conflict.record.quarantined.length, 2);

      okExec(yield* observeCmd(h, association, "result-observe-1", 4));
      const reviewed = okExec(
        yield* store.execute(
          cmd(association, {
            commandId: CommandId.make("result-review-1"),
            action: "review",
            expectedRevision: 5,
            summaryText: undefined,
            outcome: undefined,
            receipt: decisionReceipt("review"),
          }),
        ),
      );
      assert.strictEqual(reviewed.record.state, "reviewed");

      const newer = okExec(
        yield* store.execute(
          cmd(association, {
            commandId: CommandId.make("result-arrive-newer"),
            action: "arrive",
            expectedRevision: 6,
            summaryText: undefined,
            outcome: undefined,
            arrival: arrivalFor({
              summaryText: "Newer commit finished.",
              provenance: {
                ...record.provenance,
                commitSet: [COMMIT_A, "commit:ccc"],
                ancestry: [BASE_COMMIT, COMMIT_A, "commit:ccc"],
                resultRevision: RESULT_REVISION + 1,
              },
            }),
          }),
        ),
      );
      assert.strictEqual(newer.disposition, "advanced");
      assert.strictEqual(newer.record.state, "observed");
      assert.isUndefined(newer.record.reviewReceipt);
      assert.deepStrictEqual(newer.record.provenance.commitSet, [COMMIT_A, "commit:ccc"]);
    }).pipe(Effect.provide(memory(h)));
  });

  it.effect("clears pending only through a matching trusted observation and never treats a mailbox ACK as acceptance", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { association } = yield* seedReserveBind(h, "mission-1", "task-a");
      h.state.facts = { ...h.state.facts, association: { ...association, pendingChildRuns: true } };
      const store = yield* MissionResultStore.MissionResultStore;
      const initialized = okExec(yield* store.execute(cmd(association, { expectedRevision: 1 })));
      assert.isTrue(initialized.record.pendingChildRuns);
      h.state.facts = { ...h.state.facts, association };

      const earlyAck = yield* store.execute(
        cmd(association, { commandId: CommandId.make("result-ack-early"), action: "mailbox_ack", expectedRevision: 2, summaryText: undefined, outcome: undefined }),
      );
      assert.strictEqual(failTag(earlyAck), "acknowledge:invalid_transition");

      const record = initialized.record;
      const selfCleared = okExec(
        yield* store.execute(
          cmd(association, {
            commandId: CommandId.make("result-arrive-pending"),
            action: "arrive",
            expectedRevision: 2,
            summaryText: undefined,
            outcome: undefined,
            arrival: {
              attemptNumber: 1,
              outcome: "completed",
              summaryText: record.summaryText,
              digests: { ...record.digests },
              provenance: { ...record.provenance },
              pendingChildRuns: false,
              cancellationRequested: false,
            },
          }),
        ),
      );
      assert.strictEqual(selfCleared.disposition, "held_not_done");
      assert.isTrue(selfCleared.record.pendingChildRuns);

      h.state.facts = {
        ...h.state.facts,
        observation: {
          childTaskId: "foreign-task",
          childThreadId: "foreign-thread",
          childRunId: "run-foreign",
          resultRevision: RESULT_REVISION,
          pendingChildRuns: false,
          stage: "observed",
        },
      };
      const foreignObservation = okExec(
        yield* store.execute(
          cmd(association, { commandId: CommandId.make("result-observe-foreign"), action: "observe", expectedRevision: 3, summaryText: undefined, outcome: undefined }),
        ),
      );
      assert.strictEqual(foreignObservation.disposition, "held_stale");
      assert.isTrue(foreignObservation.record.pendingChildRuns);

      const observed = okExec(yield* observeCmd(h, association, "result-observe-1", 4));
      assert.isFalse(observed.record.pendingChildRuns);
      assert.strictEqual(observed.record.state, "observed");

      const acked = okExec(
        yield* store.execute(
          cmd(association, { commandId: CommandId.make("result-ack-1"), action: "mailbox_ack", expectedRevision: 5, summaryText: undefined, outcome: undefined }),
        ),
      );
      assert.isTrue(acked.record.mailboxAcked);
      assert.strictEqual(acked.record.state, "observed");
      assert.isUndefined(acked.record.acceptanceReceipt);
    }).pipe(Effect.provide(memory(h)));
  });

  it.effect("rolls back event, result, projection, and revision when the receipt insert fails", () => {
    const h = harness();
    const failingReceipts = Layer.succeed(
      Receipts.OrchestrationCommandReceiptRepository,
      {
        insertIfAbsent: () => Effect.succeed(false),
        upsert: () => Effect.void,
        getByCommandId: () => Effect.succeed(Option.none()),
      },
    );
    const authority = Layer.succeed(MissionService.MissionAuthority, scope);
    const resultPort = Layer.succeed(MissionResultStore.MissionResultFactsPort, {
      readFacts: () => Effect.succeed(h.state.facts),
    });
    const admissionPort = Layer.succeed(MissionAdmissionStore.MissionAdmissionFactsPort, {
      readFacts: () => Effect.succeed(admissionFacts()),
    });
    // Seed and reserve use the real receipt repository; only the result
    // store under test sees the failing one.
    const layer = Layer.mergeAll(
      MissionResultStore.layer.pipe(
        Layer.provide(EventStore.layer),
        Layer.provide(failingReceipts),
        Layer.provide(authority),
        Layer.provide(resultPort),
      ),
      MissionAdmissionStore.layer.pipe(
        Layer.provide(EventStore.layer),
        Layer.provide(Receipts.layer),
        Layer.provide(authority),
        Layer.provide(admissionPort),
      ),
      MissionService.layer.pipe(
        Layer.provide(EventStore.layer),
        Layer.provide(Receipts.layer),
        Layer.provide(authority),
      ),
      EventStore.layer,
      Receipts.layer,
    ).pipe(Layer.provideMerge(Sqlite.layerMemory));
    return Effect.gen(function* () {
      const { association } = yield* seedReserveBind(h, "mission-1", "task-a");
      const store = yield* MissionResultStore.MissionResultStore;
      const failed = yield* store
        .execute(cmd(association, { expectedRevision: 1 }))
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(failed));
      const canonical = yield* currentMission("mission-1");
      assert.strictEqual(canonical.revision, 1);
      assert.deepStrictEqual(canonical.execution?.results ?? [], []);
      assert.strictEqual(yield* eventCount("mission-1"), 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("preserves an existing result across a later admission and a generic replacement", () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* MissionService.MissionService;
      const fixture = missionFixture("mission-1", ["task-a", "task-b"]);
      yield* service.execute({
        type: "mission.create",
        commandId: CommandId.make("seed-mission-1"),
        mission: fixture,
      });
      const admissionStore = yield* MissionAdmissionStore.MissionAdmissionStore;
      const first = yield* admissionStore.reserve(admissionRequest(fixture, "task-a"));
      assert.isTrue(Result.isSuccess(first));
      const canonical1 = yield* currentMission("mission-1");
      const digests = MissionResultStore.canonicalResultDigests(canonical1, "task-a");
      assert.isDefined(digests);
      const association: Association = {
        ...placeholderAssociation,
        digests: digests!,
        admissionDispatchKey: Result.getOrThrow(first).receipt.dispatchKey,
        admissionRequestDigest: Result.getOrThrow(first).receipt.requestDigest,
      };
      h.state.facts = { ...h.state.facts, association };
      const store = yield* MissionResultStore.MissionResultStore;
      okExec(yield* store.execute(cmd(association, { expectedRevision: 1 })));

      const canonicalNow = yield* currentMission("mission-1");
      const second = yield* admissionStore.reserve(admissionRequest(canonicalNow, "task-b", "read"));
      assert.isTrue(Result.isSuccess(second));
      const afterAdmission = yield* currentMission("mission-1");
      assert.strictEqual(afterAdmission.execution?.admissions.length, 2);
      assert.strictEqual(afterAdmission.execution?.results?.length, 1);
      assert.strictEqual(afterAdmission.execution?.results?.[0]?.taskId, "task-a");
      assert.strictEqual(afterAdmission.execution?.results?.[0]?.state, "produced");

      yield* service.execute({
        type: "mission.replace",
        commandId: CommandId.make("replace-generic-1"),
        mission: {
          ...afterAdmission,
          revision: afterAdmission.revision + 1,
          intent: { ...afterAdmission.intent, outcome: "Ship result reconciliation, revised." },
        },
        expectedRevision: afterAdmission.revision,
        epoch: 3,
        authority: { ...AUTHORITY },
      });
      const afterReplace = yield* currentMission("mission-1");
      assert.strictEqual(afterReplace.execution?.admissions.length, 2);
      assert.strictEqual(afterReplace.execution?.results?.length, 1);
      assert.strictEqual(afterReplace.execution?.results?.[0]?.state, "produced");
    }).pipe(Effect.provide(memory(h)));
  });

  it.effect("holds sixty-four results at the bound without dropping history", () => {
    const h = harness();
    return Effect.gen(function* () {
      const taskIds = Array.from({ length: 65 }, (_, i) => `task-${i}`);
      const service = yield* MissionService.MissionService;
      const fixture = missionFixture("mission-1", taskIds);
      yield* service.execute({
        type: "mission.create",
        commandId: CommandId.make("seed-mission-1"),
        mission: fixture,
      });
      const admissionStore = yield* MissionAdmissionStore.MissionAdmissionStore;
      const store = yield* MissionResultStore.MissionResultStore;
      for (const taskId of taskIds.slice(0, 64)) {
        const canonicalBefore = yield* currentMission("mission-1");
        const reserved = yield* admissionStore.reserve(admissionRequest(canonicalBefore, taskId, "read"));
        assert.isTrue(Result.isSuccess(reserved));
        const receipt = Result.getOrThrow(reserved).receipt;
        const canonical = yield* currentMission("mission-1");
        const digests = MissionResultStore.canonicalResultDigests(canonical, taskId);
        assert.isDefined(digests);
        const association: Association = {
          ...placeholderAssociation,
          childTaskId: `child-${taskId}`,
          digests: digests!,
          admissionDispatchKey: receipt.dispatchKey,
          admissionRequestDigest: receipt.requestDigest,
        };
        h.state.facts = { ...h.state.facts, association };
        const initialized = yield* store.execute({
          commandId: CommandId.make(`result-init-${taskId}`),
          missionId: "mission-1",
          expectedRevision: canonical.revision,
          deliveryEpoch: 3,
          taskId,
          dispatchKey: receipt.dispatchKey,
          action: "initialize",
          summaryText: `Finished ${taskId}.`,
          outcome: "completed",
        });
        assert.isTrue(Result.isSuccess(initialized));
      }
      const full = yield* currentMission("mission-1");
      assert.strictEqual(full.execution?.results?.length, 64);
      assert.strictEqual(full.execution?.results?.[0]?.taskId, "task-0");
      assert.strictEqual(full.execution?.results?.[63]?.taskId, "task-63");

      // No admission can exist for a sixty-fifth result, and no history drops.
      const canonical = yield* currentMission("mission-1");
      const denied = yield* store.execute({
        commandId: CommandId.make("result-init-task-64"),
        missionId: "mission-1",
        expectedRevision: canonical.revision,
        deliveryEpoch: 3,
        taskId: "task-64",
        dispatchKey: dispatchKeyFor({
          teamId: "team-1",
          environmentId: "env-1",
          missionId: "mission-1",
          taskId: "task-64",
          attemptNumber: 1,
          operation: "read",
        }),
        action: "initialize",
        summaryText: "Finished task-64.",
        outcome: "completed",
      });
      assert.strictEqual(failTag(denied), "initialize:digest_mismatch");
      assert.strictEqual((yield* currentMission("mission-1")).execution?.results?.length, 64);
    }).pipe(Effect.provide(memory(h)));
  });

  it.effect("round-trips an initialized mission through the wire codec and rejects malformed result refs", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { association } = yield* seedReserveBind(h, "mission-1", "task-a");
      const store = yield* MissionResultStore.MissionResultStore;
      okExec(yield* store.execute(cmd(association, { expectedRevision: 1 })));
      const canonical = yield* currentMission("mission-1");
      const encoded = yield* encodeJsonMission(canonical);
      const decoded = yield* decodeJsonMission(encoded);
      assert.strictEqual(decoded.execution?.results?.length, 1);
      assert.strictEqual(decoded.execution?.results?.[0]?.taskId, "task-a");
      assert.strictEqual(decoded.execution?.results?.[0]?.provenance.childRunId, "run-1");

      const record = canonical.execution?.results?.[0];
      assert.isDefined(record);
      const malformedRecord = yield* decodeResultRecord({
        ...record!,
        provenance: { ...record!.provenance, childTaskId: "" },
      }).pipe(Effect.result);
      assert.isTrue(Result.isFailure(malformedRecord));
      const malformedReceipt = yield* decodeResultReceipt({
        ...decisionReceipt("review"),
        evidenceRef: "",
      }).pipe(Effect.result);
      assert.isTrue(Result.isFailure(malformedReceipt));
    }).pipe(Effect.provide(memory(h)));
  });

  it.effect("fails closed on an unknown runtime action without mutating the record", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { association } = yield* seedReserveBind(h, "mission-1", "task-a");
      const store = yield* MissionResultStore.MissionResultStore;
      okExec(yield* store.execute(cmd(association, { expectedRevision: 1 })));
      const bogus = yield* store.execute(
        cmd(association, {
          commandId: CommandId.make("result-bogus-1"),
          action: "bogus" as MissionResultStore.MissionResultAction,
          expectedRevision: 2,
          summaryText: undefined,
          outcome: undefined,
          reason: "must not reject through an unknown action",
        }),
      );
      assert.isTrue(Result.isFailure(bogus));
      const canonical = yield* currentMission("mission-1");
      assert.strictEqual(canonical.revision, 2);
      assert.strictEqual(canonical.execution?.results?.[0]?.state, "produced");
    }).pipe(Effect.provide(memory(h)));
  });
});

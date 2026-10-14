import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  Mission,
  MissionId,
  TeamId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as MissionRetroCheckpointStore from "./MissionRetroCheckpointStore.ts";
import * as MissionService from "./MissionService.ts";

/**
 * Dormant retro checkpoint acceptance: one transaction commits the event,
 * projection, and command receipt together and queues the descriptor for
 * later analysis. Exact replays and same-boundary captures recover the same
 * checkpoint with no new event or revision; policy denials persist a
 * rejected receipt while scope denials persist nothing. No model is
 * launched, no outbox or skills wiring starts, no sleeps or polling;
 * concurrency only via Effect.all like MissionService.
 */

const NOW_MS = Date.parse("2026-10-14T03:00:00.000Z");
const iso = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms));
const BASE_COMMIT = "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d";
const AUTHORITY = { source: "mission-council", ref: "decision-2026-001" } as const;
const scope = {
  teamId: TeamId.make("team-1"),
  environmentId: EnvironmentId.make("env-1"),
  controllerThreadId: ThreadId.make("thread-1"),
};

const decodeMission = Schema.decodeUnknownSync(Mission);

const missionFixture = (id: string) =>
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
      outcome: "Ship retro checkpoint capture.",
      scope: ["retro"],
      exclusions: [],
      authorityRefs: [{ ...AUTHORITY }],
      acceptanceCriteria: [{ id: "ac-1", text: "Queue once." }],
      decisions: [],
    },
    integrationTarget: { summary: "Later analysis follow-up." },
    managers: { delivery: { threadId: "thread-1", epoch: 3 } },
    status: "active",
    tasks: [],
    updatedAt: iso(NOW_MS - 3_600_000),
  });

type Command = MissionRetroCheckpointStore.MissionRetroCaptureCommand;
type Snapshot = MissionRetroCheckpointStore.MissionRetroTrustedSnapshot;

const readyCapacity = (): MissionRetroCheckpointStore.MissionRetroCapacityFacts => ({
  state: "ready",
  accountId: "acct-1",
  company: "No Fun",
  reporterIdentity: "muse-spark-1.3-contributor",
  exhausted: false,
  lowReserve: false,
  profile: "muse-review",
});

const snapshotFor = (
  command: Command,
  overrides: Partial<Snapshot> = {},
): Snapshot => ({
  teamId: "team-1",
  environmentId: "env-1",
  deliveryThreadId: "thread-1",
  deliveryEpoch: 3,
  nowMs: NOW_MS,
  missionId: command.missionId,
  sourceRoot: "thread://thread-origin",
  sourceThreadId: command.sourceThreadId,
  actualOrigin: "worker-milestone",
  eligibleTrigger: command.trigger,
  fromInclusive: command.fromInclusive,
  toExclusive: command.toExclusive,
  snapshotFingerprint: "a".repeat(64),
  sourceRefs: [
    {
      rootRef: "thread://thread-origin",
      chunkRef: `chunk-${command.fromInclusive}-${command.toExclusive}`,
      chunkHash: "b".repeat(64),
      coveredFromInclusive: command.fromInclusive,
      coveredToExclusive: command.toExclusive,
    },
  ],
  omissions: [],
  coverage: "full",
  pendingChildRuns: false,
  capacity: readyCapacity(),
  ...overrides,
});

interface Harness {
  readonly calls: { count: number };
  readonly base: Layer.Layer<
    | MissionRetroCheckpointStore.MissionRetroCheckpointStore
    | MissionService.MissionService
    | EventStore.OrchestrationEventStore
    | Receipts.OrchestrationCommandReceiptRepository,
    never,
    SqlClient.SqlClient
  >;
}

const harness = (snapshot: (command: Command) => Snapshot): Harness => {
  const calls = { count: 0 };
  const authority = Layer.succeed(MissionService.MissionAuthority, scope);
  const snapshotPort = Layer.succeed(MissionRetroCheckpointStore.MissionRetroSnapshotPort, {
    readSnapshot: (command: Command) =>
      Effect.sync(() => {
        calls.count += 1;
        return snapshot(command);
      }),
  });
  const base = Layer.mergeAll(
    MissionRetroCheckpointStore.layer.pipe(
      Layer.provide(EventStore.layer),
      Layer.provide(Receipts.layer),
      Layer.provide(authority),
      Layer.provide(snapshotPort),
    ),
    MissionService.layer.pipe(
      Layer.provide(EventStore.layer),
      Layer.provide(Receipts.layer),
      Layer.provide(authority),
    ),
    EventStore.layer,
    Receipts.layer,
  );
  return { calls, base };
};

const memory = (h: Harness) => h.base.pipe(Layer.provideMerge(Sqlite.layerMemory));

const captureCmd = (overrides: Partial<Command> = {}): Command => ({
  commandId: CommandId.make("retro-cmd-1"),
  missionId: "mission-1",
  expectedRevision: 0,
  deliveryEpoch: 3,
  sourceThreadId: "thread-origin",
  fromInclusive: 4,
  toExclusive: 12,
  trigger: "milestone",
  ...overrides,
});

const seed = (missionId: string) =>
  Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    yield* service.execute({
      type: "mission.create",
      commandId: CommandId.make(`seed-${missionId}`),
      mission: missionFixture(missionId),
    });
  });

const currentMission = (missionId: string) =>
  Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    return Option.getOrThrow(yield* service.get(MissionId.make(missionId)));
  });

const checkpointsOf = (missionId: string) =>
  Effect.gen(function* () {
    const canonical = yield* currentMission(missionId);
    return canonical.execution?.retroCheckpoints ?? [];
  });

const eventCount = (missionId: string) =>
  Effect.gen(function* () {
    const events = yield* EventStore.OrchestrationEventStore;
    return (yield* events.readMissionEvents(MissionId.make(missionId))).length;
  });

const ok = (
  result: MissionRetroCheckpointStore.MissionRetroCaptureResult,
): MissionRetroCheckpointStore.MissionRetroCapture => {
  assert.isTrue(Result.isSuccess(result));
  return Result.getOrThrow(result);
};

const policyCode = (result: MissionRetroCheckpointStore.MissionRetroCaptureResult): string => {
  assert.isTrue(Result.isFailure(result));
  return Result.isFailure(result) ? result.failure.code : assert.fail("expected policy rejection");
};

const storeCategory = (
  result: Result.Result<unknown, MissionRetroCheckpointStore.MissionRetroCheckpointStoreError>,
): string => {
  assert.isTrue(Result.isFailure(result));
  return Result.isFailure(result) ? result.failure.category : assert.fail("expected store error");
};

it.effect("captures a ready checkpoint with event, projection, and receipt", () =>
  Effect.gen(function* () {
    const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
    yield* seed("mission-1");
    const out = ok(yield* store.capture(captureCmd()));
    assert.isTrue(out.committed);
    assert.isFalse(out.recovered);
    assert.strictEqual(out.checkpoint.status, "queued_ready");
    assert.strictEqual(out.checkpoint.coverage, "full");
    assert.strictEqual(out.checkpoint.requestedReporter, "muse-spark-1.3-contributor");
    assert.strictEqual(out.checkpoint.sourceThreadId, "thread-origin");
    assert.strictEqual(yield* eventCount("mission-1"), 2);
    const canonical = yield* currentMission("mission-1");
    assert.strictEqual(canonical.revision, 1);
    assert.strictEqual((yield* checkpointsOf("mission-1")).length, 1);
    const replay = ok(yield* store.capture(captureCmd()));
    assert.isTrue(replay.recovered);
    assert.isFalse(replay.committed);
    assert.strictEqual(replay.checkpoint.checkpointId, out.checkpoint.checkpointId);
    assert.deepStrictEqual(replay.receipt, out.receipt);
    assert.strictEqual(yield* eventCount("mission-1"), 2);
    assert.strictEqual((yield* currentMission("mission-1")).revision, 1);
  }).pipe(Effect.provide(memory(harness((command) => snapshotFor(command))))),
);

it.effect("commits concurrent duplicate captures once with the same checkpoint", () =>
  Effect.gen(function* () {
    const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
    yield* seed("mission-1");
    const results = yield* Effect.all(
      [store.capture(captureCmd()), store.capture(captureCmd())],
      { concurrency: 2 },
    );
    assert.strictEqual(results.filter(Result.isSuccess).length, 2);
    const captures = results.map(ok);
    assert.strictEqual(captures.filter((capture) => capture.committed).length, 1);
    assert.strictEqual(captures[0]!.checkpoint.checkpointId, captures[1]!.checkpoint.checkpointId);
    assert.strictEqual(yield* eventCount("mission-1"), 2);
    assert.strictEqual((yield* currentMission("mission-1")).revision, 1);
  }).pipe(Effect.provide(memory(harness((command) => snapshotFor(command))))),
);

it.effect("dedups a different command id on the same boundary without new event or revision", () =>
  Effect.gen(function* () {
    const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
    yield* seed("mission-1");
    const first = ok(yield* store.capture(captureCmd()));
    const second = ok(
      yield* store.capture(
        captureCmd({ commandId: CommandId.make("retro-cmd-2"), expectedRevision: 1 }),
      ),
    );
    assert.isTrue(second.recovered);
    assert.isFalse(second.committed);
    assert.strictEqual(second.checkpoint.checkpointId, first.checkpoint.checkpointId);
    assert.strictEqual(second.eventSequence, first.eventSequence);
    assert.strictEqual(yield* eventCount("mission-1"), 2);
    assert.strictEqual((yield* currentMission("mission-1")).revision, 1);
    assert.strictEqual((yield* checkpointsOf("mission-1")).length, 1);
  }).pipe(Effect.provide(memory(harness((command) => snapshotFor(command))))),
);

it.effect("conflicts on the same command id with different canonical bytes", () =>
  Effect.gen(function* () {
    const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
    yield* seed("mission-1");
    ok(yield* store.capture(captureCmd()));
    const changed = yield* store
      .capture(captureCmd({ trigger: "settled", expectedRevision: 1 }))
      .pipe(Effect.result);
    assert.strictEqual(storeCategory(changed), "request_conflict");
    assert.strictEqual(yield* eventCount("mission-1"), 2);
  }).pipe(Effect.provide(memory(harness((command) => snapshotFor(command))))),
);

it.effect("denies foreign scope and stale epoch before any snapshot read with no receipt", () => {
  const h = harness((command) => snapshotFor(command));
  return Effect.gen(function* () {
    const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
    const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
    yield* seed("mission-1");
    assert.strictEqual(h.calls.count, 0);
    const missing = yield* store
      .capture(captureCmd({ commandId: CommandId.make("retro-missing"), missionId: "no-such-mission" }))
      .pipe(Effect.result);
    assert.strictEqual(storeCategory(missing), "scope_denied");
    const stale = yield* store
      .capture(captureCmd({ commandId: CommandId.make("retro-stale"), deliveryEpoch: 2 }))
      .pipe(Effect.result);
    assert.strictEqual(storeCategory(stale), "scope_denied");
    assert.strictEqual(h.calls.count, 0);
    for (const commandId of ["retro-missing", "retro-stale"]) {
      assert.isTrue(
        Option.isNone(yield* receipts.getByCommandId({ commandId: CommandId.make(commandId) })),
      );
    }
    assert.strictEqual(yield* eventCount("mission-1"), 1);
  }).pipe(Effect.provide(memory(h)));
});

/** Runs one fresh-database scenario with its own trusted snapshot shape. */
const scenario = <A, E>(
  snapshot: (command: Command) => Snapshot,
  body: Effect.Effect<
    A,
    E,
    | MissionRetroCheckpointStore.MissionRetroCheckpointStore
    | MissionService.MissionService
    | EventStore.OrchestrationEventStore
    | Receipts.OrchestrationCommandReceiptRepository
  >,
) => body.pipe(Effect.provide(memory(harness(snapshot))));

it.effect("denies recursive origins and routine triggers with durable rejections", () =>
  Effect.gen(function* () {
    yield* scenario(
      (command) => snapshotFor(command, { actualOrigin: "retro_pipeline" }),
      Effect.gen(function* () {
        const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
        const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
        yield* seed("mission-1");
        const cmd = captureCmd({ commandId: CommandId.make("retro-pipeline") });
        assert.strictEqual(policyCode(yield* store.capture(cmd)), "origin_denied");
        // The documented denial is durable: an exact retry returns it with no event.
        assert.strictEqual(policyCode(yield* store.capture(cmd)), "origin_denied");
        const saved = yield* receipts.getByCommandId({ commandId: cmd.commandId });
        assert.isTrue(Option.isSome(saved) && saved.value.status === "rejected");
        assert.strictEqual((yield* checkpointsOf("mission-1")).length, 0);
        assert.strictEqual(yield* eventCount("mission-1"), 1);
      }),
    );
    yield* scenario(
      (command) => snapshotFor(command, { actualOrigin: "reporter" }),
      Effect.gen(function* () {
        const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
        yield* seed("mission-1");
        // Denied even though the caller labels the work a product milestone.
        assert.strictEqual(
          policyCode(yield* store.capture(captureCmd({ commandId: CommandId.make("retro-reporter") }))),
          "origin_denied",
        );
      }),
    );
    yield* scenario(
      (command) => snapshotFor(command),
      Effect.gen(function* () {
        const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
        yield* seed("mission-1");
        assert.strictEqual(
          policyCode(
            yield* store.capture(
              captureCmd({ commandId: CommandId.make("retro-routine"), trigger: "routine_status" }),
            ),
          ),
          "trigger_ineligible",
        );
        assert.strictEqual((yield* checkpointsOf("mission-1")).length, 0);
      }),
    );
  }),
);

it.effect("retains unavailable, unknown, and exhausted capacity as queued_capacity", () =>
  Effect.gen(function* () {
    const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
    yield* seed("mission-1");
    const queued = [
      ok(
        yield* store.capture(
          captureCmd({ commandId: CommandId.make("retro-unknown"), fromInclusive: 0, toExclusive: 2 }),
        ),
      ),
      ok(
        yield* store.capture(
          captureCmd({
            commandId: CommandId.make("retro-unavailable"),
            expectedRevision: 1,
            fromInclusive: 2,
            toExclusive: 4,
          }),
        ),
      ),
      ok(
        yield* store.capture(
          captureCmd({
            commandId: CommandId.make("retro-exhausted"),
            expectedRevision: 2,
            fromInclusive: 12,
            toExclusive: 14,
          }),
        ),
      ),
      ok(
        yield* store.capture(
          captureCmd({
            commandId: CommandId.make("retro-low"),
            expectedRevision: 3,
            fromInclusive: 14,
            toExclusive: 16,
          }),
        ),
      ),
    ];
    // Nothing is dropped for capacity, and no quota is probed with a model:
    // every boundary persists queued for later analysis.
    for (const capture of queued) {
      assert.isTrue(capture.committed);
      assert.strictEqual(capture.checkpoint.status, "queued_capacity");
    }
    assert.strictEqual((yield* checkpointsOf("mission-1")).length, 4);
  }).pipe(
    Effect.provide(
      memory(
        harness((command) =>
          snapshotFor(command, {
            capacity:
              command.commandId === "retro-unknown"
                ? { ...readyCapacity(), state: "unknown" as const }
                : command.commandId === "retro-unavailable"
                  ? { ...readyCapacity(), state: "unavailable" as const }
                  : command.commandId === "retro-exhausted"
                    ? { ...readyCapacity(), exhausted: true }
                    : { ...readyCapacity(), lowReserve: true },
          }),
        ),
      ),
    ),
  ),
);

it.effect("cannot reach queued_ready without an eligible No Fun reporter identity", () =>
  Effect.gen(function* () {
    const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
    yield* seed("mission-1");
    const ids = ["retro-other-company", "retro-wrong-reporter", "retro-no-account"];
    let revision = 0;
    for (const [index, id] of ids.entries()) {
      const out = ok(
        yield* store.capture(
          captureCmd({
            commandId: CommandId.make(id),
            expectedRevision: revision,
            fromInclusive: index * 2,
            toExclusive: index * 2 + 1,
          }),
        ),
      );
      assert.strictEqual(out.checkpoint.status, "queued_capacity");
      revision += 1;
    }
    assert.strictEqual((yield* checkpointsOf("mission-1")).length, ids.length);
  }).pipe(
    Effect.provide(
      memory(
        harness((command) =>
          snapshotFor(command, {
            capacity:
              command.commandId === "retro-other-company"
                ? { ...readyCapacity(), company: "Other" }
                : command.commandId === "retro-wrong-reporter"
                  ? { ...readyCapacity(), reporterIdentity: "someone-else" }
                  : { ...readyCapacity(), accountId: null },
          }),
        ),
      ),
    ),
  ),
);

it.effect("keeps partial snapshot coverage unknown and refuses complete with pending children", () =>
  Effect.gen(function* () {
    yield* scenario(
      (command) =>
        snapshotFor(command, { coverage: "partial", omissions: ["range 6-7 redacted before export"] }),
      Effect.gen(function* () {
        const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
        yield* seed("mission-1");
        const out = ok(yield* store.capture(captureCmd()));
        assert.strictEqual(out.checkpoint.coverage, "unknown");
        assert.deepStrictEqual(out.checkpoint.omissions, ["range 6-7 redacted before export"]);
      }),
    );
    yield* scenario(
      (command) => snapshotFor(command, { pendingChildRuns: true }),
      Effect.gen(function* () {
        const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
        yield* seed("mission-1");
        // Settled work with pending children persists partial, never complete.
        const settled = ok(
          yield* store.capture(
            captureCmd({ commandId: CommandId.make("retro-settled"), trigger: "settled" }),
          ),
        );
        assert.strictEqual(settled.checkpoint.coverage, "unknown");
        assert.deepStrictEqual(settled.checkpoint.omissions, ["pending-child-runs"]);
        assert.strictEqual((yield* checkpointsOf("mission-1")).length, 1);
        assert.strictEqual(
          policyCode(
            yield* store.capture(
              captureCmd({
                commandId: CommandId.make("retro-complete"),
                expectedRevision: 1,
                fromInclusive: 20,
                toExclusive: 22,
                trigger: "complete",
              }),
            ),
          ),
          "pending_children_complete",
        );
      }),
    );
  }),
);

it.effect("denies the 65th checkpoint without dropping retained history", () =>
  Effect.gen(function* () {
    const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
    yield* seed("mission-1");
    yield* Effect.forEach(
      Array.from({ length: 64 }, (_, index) => index),
      (index) =>
        store.capture(
          captureCmd({
            commandId: CommandId.make(`retro-fill-${index}`),
            expectedRevision: index,
            fromInclusive: index * 10,
            toExclusive: index * 10 + 5,
          }),
        ),
      { concurrency: 1 },
    );
    assert.strictEqual((yield* checkpointsOf("mission-1")).length, 64);
    assert.strictEqual(
      policyCode(
        yield* store.capture(
          captureCmd({
            commandId: CommandId.make("retro-overflow"),
            expectedRevision: 64,
            fromInclusive: 640,
            toExclusive: 645,
          }),
        ),
      ),
      "checkpoint_bound",
    );
    assert.strictEqual((yield* checkpointsOf("mission-1")).length, 64);
    assert.strictEqual((yield* currentMission("mission-1")).revision, 64);
  }).pipe(Effect.provide(memory(harness((command) => snapshotFor(command))))),
);

it.effect("rolls back event and projection when its command receipt cannot be reserved", () => {
  let failRetroReceipts = false;
  const stubReceipts = Layer.succeed(Receipts.OrchestrationCommandReceiptRepository, {
    insertIfAbsent: (receipt: Receipts.OrchestrationCommandReceipt) =>
      failRetroReceipts && receipt.commandType === "mission.retro-capture"
        ? Effect.succeed(false)
        : Effect.succeed(true),
    upsert: () => Effect.void,
    getByCommandId: () => Effect.succeed(Option.none()),
  });
  const authority = Layer.succeed(MissionService.MissionAuthority, scope);
  const snapshotPort = Layer.succeed(MissionRetroCheckpointStore.MissionRetroSnapshotPort, {
    readSnapshot: (command: Command) => Effect.succeed(snapshotFor(command)),
  });
  const provided = Layer.mergeAll(
    MissionRetroCheckpointStore.layer.pipe(
      Layer.provide(EventStore.layer),
      Layer.provide(stubReceipts),
      Layer.provide(authority),
      Layer.provide(snapshotPort),
    ),
    MissionService.layer.pipe(
      Layer.provide(EventStore.layer),
      Layer.provide(stubReceipts),
      Layer.provide(authority),
    ),
    EventStore.layer,
    stubReceipts,
  ).pipe(Layer.provideMerge(Sqlite.layerMemory));
  return Effect.gen(function* () {
    const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
    const service = yield* MissionService.MissionService;
    yield* service.execute({
      type: "mission.create",
      commandId: CommandId.make("seed-mission-1"),
      mission: missionFixture("mission-1"),
    });
    failRetroReceipts = true;
    const failed = yield* store.capture(captureCmd()).pipe(Effect.result);
    assert.strictEqual(storeCategory(failed), "request_conflict");
    assert.strictEqual(yield* eventCount("mission-1"), 1);
    assert.strictEqual((yield* currentMission("mission-1")).revision, 0);
    assert.strictEqual((yield* checkpointsOf("mission-1")).length, 0);
  }).pipe(Effect.provide(provided));
});

it.effect("restores the committed checkpoint across close/reopen with no repeats", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "combined-v3-retro-" });
      const databasePath = `${directory}/state.sqlite`;
      const h = harness((command) => snapshotFor(command));
      const run = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          | MissionRetroCheckpointStore.MissionRetroCheckpointStore
          | MissionService.MissionService
          | EventStore.OrchestrationEventStore
          | Receipts.OrchestrationCommandReceiptRepository
        >,
      ) => effect.pipe(Effect.provide(h.base.pipe(Layer.provideMerge(Sqlite.layerFromPath(databasePath)))));
      const first = yield* run(
        Effect.gen(function* () {
          const service = yield* MissionService.MissionService;
          yield* service.execute({
            type: "mission.create",
            commandId: CommandId.make("seed-mission-1"),
            mission: missionFixture("mission-1"),
          });
          const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
          return ok(yield* store.capture(captureCmd()));
        }),
      );
      assert.isTrue(first.committed);
      const second = yield* run(
        Effect.gen(function* () {
          const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
          const out = ok(yield* store.capture(captureCmd()));
          assert.isTrue(out.recovered);
          assert.isFalse(out.committed);
          return out;
        }),
      );
      assert.strictEqual(second.checkpoint.checkpointId, first.checkpoint.checkpointId);
      assert.deepStrictEqual(second.receipt, first.receipt);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("preserves checkpoints across a generic mission replacement", () =>
  Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
    yield* seed("mission-1");
    const first = ok(yield* store.capture(captureCmd()));
    const canonical = yield* currentMission("mission-1");
    const replaced = yield* service.execute({
      type: "mission.replace",
      commandId: CommandId.make("replace-1"),
      mission: { ...canonical, revision: canonical.revision + 1 },
      expectedRevision: canonical.revision,
      epoch: 3,
      authority: { ...AUTHORITY },
      // A forged execution would be ignored; the canonical one carries forward.
      // (Proposing checkpoints here must not duplicate or erase them.)
    });
    assert.isTrue(replaced.committed);
    const after = yield* currentMission("mission-1");
    assert.strictEqual(after.revision, 2);
    const checkpoints = after.execution?.retroCheckpoints ?? [];
    assert.strictEqual(checkpoints.length, 1);
    assert.strictEqual(checkpoints[0]!.checkpointId, first.checkpoint.checkpointId);
  }).pipe(Effect.provide(memory(harness((command) => snapshotFor(command))))),
);

it.effect("rejects snapshots whose root, range, team, or fingerprint disagree", () =>
  Effect.gen(function* () {
    yield* scenario(
      (command) => snapshotFor(command, { sourceThreadId: "other-thread" }),
      Effect.gen(function* () {
        const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
        yield* seed("mission-1");
        assert.strictEqual(
          policyCode(yield* store.capture(captureCmd({ commandId: CommandId.make("retro-thread") }))),
          "source_mismatch",
        );
      }),
    );
    yield* scenario(
      (command) => snapshotFor(command, { fromInclusive: 99, toExclusive: 100 }),
      Effect.gen(function* () {
        const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
        yield* seed("mission-1");
        assert.strictEqual(
          policyCode(yield* store.capture(captureCmd({ commandId: CommandId.make("retro-range") }))),
          "source_mismatch",
        );
      }),
    );
    yield* scenario(
      (command) => snapshotFor(command, { teamId: "foreign" }),
      Effect.gen(function* () {
        const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
        yield* seed("mission-1");
        const denied = yield* store
          .capture(captureCmd({ commandId: CommandId.make("retro-team") }))
          .pipe(Effect.result);
        assert.strictEqual(storeCategory(denied), "scope_denied");
      }),
    );
    yield* scenario(
      (command) => snapshotFor(command, { snapshotFingerprint: "not-a-sha256" }),
      Effect.gen(function* () {
        const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
        yield* seed("mission-1");
        // A malformed fingerprint cannot become a descriptor: decode fails closed.
        const denied = yield* store
          .capture(captureCmd({ commandId: CommandId.make("retro-print") }))
          .pipe(Effect.result);
        assert.strictEqual(storeCategory(denied), "persistence");
        assert.strictEqual((yield* checkpointsOf("mission-1")).length, 0);
      }),
    );
  }),
);

it.effect("replays an alias command receipt without creating a second checkpoint", () =>
  Effect.gen(function* () {
    const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
    yield* seed("mission-1");
    const first = ok(yield* store.capture(captureCmd()));
    const alias = captureCmd({ commandId: CommandId.make("retro-alias"), expectedRevision: 1 });
    const saved = ok(yield* store.capture(alias));
    const replay = ok(yield* store.capture(alias));
    assert.deepStrictEqual(replay.receipt, saved.receipt);
    assert.strictEqual(replay.checkpoint.checkpointId, first.checkpoint.checkpointId);
    assert.strictEqual(yield* eventCount("mission-1"), 2);
  }).pipe(Effect.provide(memory(harness((command) => snapshotFor(command))))),
);

it.effect("binds expected revision as caller bytes on exact receipt replay", () =>
  Effect.gen(function* () {
    const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
    yield* seed("mission-1");
    ok(yield* store.capture(captureCmd()));
    const changed = yield* store.capture(captureCmd({ expectedRevision: 1 })).pipe(Effect.result);
    assert.strictEqual(storeCategory(changed), "request_conflict");
  }).pipe(Effect.provide(memory(harness((command) => snapshotFor(command))))),
);

it.effect("keeps a writer-profile reporter queued for capacity", () =>
  Effect.gen(function* () {
    const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
    yield* seed("mission-1");
    const captured = ok(yield* store.capture(captureCmd()));
    assert.strictEqual(captured.checkpoint.status, "queued_capacity");
  }).pipe(Effect.provide(memory(harness((command) => snapshotFor(command, {
    capacity: { ...readyCapacity(), profile: "muse-focused" },
  }))))),
);

it.effect("rejects a pending-child omission beyond the bound without losing history", () =>
  Effect.gen(function* () {
    const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
    yield* seed("mission-1");
    const result = yield* store.capture(captureCmd({ trigger: "settled" }));
    assert.strictEqual(policyCode(result), "source_mismatch");
    assert.strictEqual((yield* checkpointsOf("mission-1")).length, 0);
    assert.strictEqual(yield* eventCount("mission-1"), 1);
  }).pipe(Effect.provide(memory(harness((command) => snapshotFor(command, {
    pendingChildRuns: true,
    omissions: Array.from({ length: 16 }, (_, index) => `omission-${index}`),
  }))))),
);

it.effect("dedups concurrent different command IDs on one captured boundary", () =>
  Effect.gen(function* () {
    const store = yield* MissionRetroCheckpointStore.MissionRetroCheckpointStore;
    yield* seed("mission-1");
    const results = yield* Effect.all([
      store.capture(captureCmd()),
      store.capture(captureCmd({ commandId: CommandId.make("retro-concurrent-alias") })),
    ], { concurrency: 2 });
    const captures = results.map(ok);
    assert.strictEqual(captures.filter((capture) => capture.committed).length, 1);
    assert.strictEqual(captures[0]!.checkpoint.checkpointId, captures[1]!.checkpoint.checkpointId);
    assert.strictEqual(yield* eventCount("mission-1"), 2);
  }).pipe(Effect.provide(memory(harness((command) => snapshotFor(command))))),
);

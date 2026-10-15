/**
 * Runs `FactoryEvents` against T3's real orchestration layers (see
 * contract.testkit.ts). It answers one question on every upstream sync: does
 * a thread's id still reach `runStatusChanges` within seconds of its run
 * completing, and only for runs that change after the stream started?
 */
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import {
  SIMPLE_PROMPT,
  TERMINAL_RUN_STATUSES,
  createProject,
  initRepoWithCommit,
  layerGit,
  layerRuntime,
  projectId,
} from "./contract.testkit.ts";
import * as Events from "./events.ts";
import * as Sessions from "./sessions.ts";

it.live(
  "tells the factory a thread's run changed within 10 s of the run completing, and replays no history",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-events-" });
        const repo = path.join(base, "repo");
        const worktreesDir = path.join(base, "worktrees");
        yield* fs.makeDirectory(repo);
        yield* fs.makeDirectory(worktreesDir);
        const baseRef = yield* initRepoWithCommit(repo);

        yield* Effect.gen(function* () {
          yield* createProject(repo);
          const sessions = yield* Sessions.FactorySessions;
          const events = yield* Events.FactoryEvents;
          const sink = yield* EventSink.EventSinkV2;

          const launch = (name: string, ref = baseRef) =>
            sessions.launch({
              commandId: `softfac:factory-events-contract:${name}`,
              projectId,
              title: `Factory events ${name}`,
              baseRef: ref,
              startFromOrigin: false,
              message: SIMPLE_PROMPT,
              model: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
            });
          /** The statuses a thread's run goes through, each change once, up to its terminal one. */
          const statusesUntilTerminal = (threadId: ThreadId) =>
            sink.stream({ threadId, eventType: "run.updated" }).pipe(
              Stream.filterMap((stored) =>
                stored.event.type === "run.updated"
                  ? Result.succeed(stored.event.payload.status as Sessions.RunStatus)
                  : Result.failVoid,
              ),
              Stream.changes,
              Stream.takeUntil((status) => TERMINAL_RUN_STATUSES.has(status)),
              Stream.runCollect,
            );

          // Every id the stream emits, with when it arrived. The consumer
          // starts before anything is launched, so this half is live.
          const arrivals = yield* Queue.unbounded<{ readonly id: string; readonly at: number }>();
          yield* events.runStatusChanges.pipe(
            Stream.mapEffect((id) =>
              Clock.currentTimeMillis.pipe(Effect.map((at) => ({ id, at }))),
            ),
            Stream.runForEach((arrival) => Queue.offer(arrivals, arrival)),
            Effect.forkScoped,
          );

          const launchedA = yield* launch("a");
          const statusesA = yield* statusesUntilTerminal(ThreadId.make(launchedA.threadId));
          assert.strictEqual(statusesA.at(-1), "completed");
          const terminalAt = yield* Clock.currentTimeMillis;

          // One id per status change A's run went through, the last of them
          // (the completion) within 10 s of the terminal event. A missing
          // emission leaves this waiting; the bound only guards a hang.
          const arrivedA = yield* Queue.takeN(arrivals, statusesA.length).pipe(
            Effect.timeout("60 seconds"),
          );
          assert.deepStrictEqual(
            arrivedA.map((arrival) => arrival.id),
            statusesA.map(() => launchedA.threadId),
          );
          assert.isBelow(arrivedA.at(-1)!.at - terminalAt, 10_000);
          assert.strictEqual((yield* sessions.status(launchedA.threadId)).run, "completed");

          // The run is history now. Replay precedes live, so a stream that
          // replayed history would emit A's id (lower sequence) before B's.
          // Start the consumer before anything else is launched.
          yield* EffectWorker.OrchestrationEffectWorkerV2.use((worker) => worker.drain());
          const next = yield* events.runStatusChanges.pipe(
            Stream.take(1),
            Stream.runHead,
            Effect.timeout("60 seconds"),
            Effect.forkScoped,
          );

          // B starts from a ref the repo does not have, so its worktree cannot
          // be prepared and its run fails before any provider turn: a status
          // change on a new thread that needs no second replay transcript.
          const launchedB = yield* launch("b", "factory-events-contract-no-such-ref");
          const first = yield* Fiber.join(next);
          assert.isTrue(first._tag === "Some");
          if (first._tag !== "Some") return;
          assert.notStrictEqual(first.value, launchedA.threadId);
          assert.strictEqual(first.value, launchedB.threadId);

          // Let B's run end so the harness does not tear down under it.
          yield* statusesUntilTerminal(ThreadId.make(launchedB.threadId));
        }).pipe(Effect.provide(layerRuntime({ repo, worktreesDir })));
      }),
    ).pipe(Effect.provide(Layer.merge(layerGit, NodeServices.layer))),
  120_000,
);

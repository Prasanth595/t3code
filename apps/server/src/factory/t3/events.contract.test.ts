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
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

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

          const launch = (name: string) =>
            sessions.launch({
              commandId: `softfac:factory-events-contract:${name}`,
              projectId,
              title: `Factory events ${name}`,
              baseRef,
              startFromOrigin: false,
              message: SIMPLE_PROMPT,
              model: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
            });
          const untilTerminal = (threadId: ThreadId) =>
            sink.stream({ threadId, eventType: "run.updated" }).pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "run.updated" &&
                  TERMINAL_RUN_STATUSES.has(stored.event.payload.status),
              ),
              Stream.take(1),
              Stream.runDrain,
            );

          // Thread A finishes before anyone listens: it is history.
          const a = yield* launch("a");
          yield* untilTerminal(ThreadId.make(a.threadId));

          // The factory wakes on an id and reads the thread, so the stream
          // is done once an id leads to a completed run.
          const seen = yield* Ref.make<ReadonlyArray<string>>([]);
          const arrived = yield* events.runStatusChanges.pipe(
            Stream.tap((id) => Ref.update(seen, (ids) => [...ids, id])),
            Stream.mapEffect((id) => sessions.status(id).pipe(Effect.map((s) => ({ id, s })))),
            Stream.filter(({ s }) => s.run === "completed"),
            Stream.take(1),
            Stream.mapEffect(({ id }) =>
              Clock.currentTimeMillis.pipe(Effect.map((at) => ({ id, at }))),
            ),
            Stream.runHead,
            Effect.timeout("60 seconds"),
            Effect.forkScoped,
          );

          const b = yield* launch("b");
          yield* untilTerminal(ThreadId.make(b.threadId));
          const terminalAt = yield* Clock.currentTimeMillis;

          const head = yield* Fiber.join(arrived);
          assert.isTrue(head._tag === "Some");
          if (head._tag !== "Some") return;
          assert.strictEqual(head.value.id, b.threadId);
          assert.isBelow(head.value.at - terminalAt, 10_000);
          // Never A, whose run only exists in history.
          assert.isFalse((yield* Ref.get(seen)).includes(a.threadId));
        }).pipe(Effect.provide(layerRuntime({ repo, worktreesDir })));
      }),
    ).pipe(Effect.provide(Layer.merge(layerGit, NodeServices.layer))),
  120_000,
);

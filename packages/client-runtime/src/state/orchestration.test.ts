import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import { Atom, AtomRegistry } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createOrchestrationEnvironmentAtoms } from "./orchestration.ts";

it.effect.each([
  "turnDiff",
  "fullThreadDiff",
  "workflowScript",
  "turnItem",
  "threadFind",
  "threadFindProgressive",
  "worktreeThreadIds",
] as const)("opts %s into temporary data without changing caller inputs", (operation) =>
  Effect.gen(function* () {
    const received = yield* Queue.unbounded<unknown>();
    const unary = (input: unknown) =>
      Queue.offer(received, input).pipe(Effect.andThen(Effect.never));
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: { environmentId: EnvironmentId.make("temporary-reads") },
      state: yield* SubscriptionRef.make({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected" as const,
      }),
      session: yield* SubscriptionRef.make(
        Option.some({
          client: {
            [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: unary,
            [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: unary,
            [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: unary,
            [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: unary,
            [ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds]: unary,
            [ORCHESTRATION_V2_WS_METHODS.searchThread]: unary,
            [ORCHESTRATION_V2_WS_METHODS.searchThreadStream]: (input: unknown) =>
              Stream.unwrap(Queue.offer(received, input).pipe(Effect.as(Stream.never))),
          },
        } as unknown as RpcSession),
      ),
    } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
    const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
    const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
      _id,
      stream,
    ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
    const runtime = Atom.runtime(
      Layer.mergeAll(
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
          run,
          followStream,
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected HTTP request")),
        ),
      ),
    );
    const atoms = createOrchestrationEnvironmentAtoms(runtime);
    const threadId = ThreadId.make("temporary-thread");
    const environmentId = supervisor.target.environmentId;
    const workflow = { threadId, scriptPath: "/repo/task.ts" };
    const turnItem = { threadId, itemId: TurnItemId.make("item") };
    const search = { threadId, query: "needle" };
    const worktree = { worktreePath: "/repo/worktree" };
    const turnDiff = { threadId, fromTurnCount: 0, toTurnCount: 1 };
    const fullThreadDiff = { threadId, toTurnCount: 1 };
    const cases = {
      turnDiff: [atoms.turnDiff({ environmentId, input: turnDiff }), turnDiff],
      fullThreadDiff: [
        atoms.fullThreadDiff({ environmentId, input: fullThreadDiff }),
        fullThreadDiff,
      ],
      workflowScript: [atoms.workflowScript({ environmentId, input: workflow }), workflow],
      turnItem: [atoms.turnItem({ environmentId, input: turnItem }), turnItem],
      threadFind: [atoms.threadFind({ environmentId, input: search }), search],
      threadFindProgressive: [
        atoms.threadFindProgressive({ environmentId, input: search }),
        search,
      ],
      worktreeThreadIds: [atoms.worktreeThreadIds({ environmentId, input: worktree }), worktree],
    } as const;
    const registry = AtomRegistry.make();
    yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
    const [atom, input] = cases[operation];
    const unmount = registry.mount<unknown>(atom);
    yield* Effect.addFinalizer(() => Effect.sync(unmount));
    expect(yield* Queue.take(received)).toEqual({ ...input, acceptTemporaryThreads: true });
    expect(input).not.toHaveProperty("acceptTemporaryThreads");
  }),
);

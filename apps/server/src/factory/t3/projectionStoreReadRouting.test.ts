// @effect-diagnostics nodeBuiltinImport:off - the database is a real file in a temp directory.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe } from "vite-plus/test";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { useTempDirs } from "../ledger/testSupport.ts";
import { seededThreadId, seedProjection } from "./projectionFixture.testkit.ts";
import * as Routed from "./projectionStoreReadRouting.ts";
import { connectionsOf } from "./spanConnections.testkit.ts";

const tempDir = useTempDirs();

const routedStore = () =>
  Routed.layer.pipe(
    Layer.provideMerge(
      SqlitePersistence.layerFromPath(NodePath.join(tempDir("routing"), "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

describe("the routed projection store", () => {
  it.effect("reads the shell snapshot and the pull request threads on the reader", () =>
    Effect.gen(function* () {
      yield* seedProjection([{ pullRequests: true }, {}]);
      const store = yield* Routed.ProjectionStoreV2;
      assert.deepStrictEqual(yield* connectionsOf(store.getShellSnapshot()), new Set(["reader"]));
      assert.deepStrictEqual(
        yield* connectionsOf(store.getThreadsWithPullRequests()),
        new Set(["reader"]),
      );
    }).pipe(Effect.provide(routedStore())),
  );

  it.effect("leaves every other read on the writer, and the answers unchanged", () =>
    Effect.gen(function* () {
      yield* seedProjection([{ pullRequests: true }, {}]);
      const store = yield* Routed.ProjectionStoreV2;
      const id = ThreadId.make(seededThreadId(1));
      assert.deepStrictEqual(yield* connectionsOf(store.getThread(id)), new Set(["writer"]));
      assert.deepStrictEqual(
        (yield* store.getThreadsWithPullRequests()).map((thread) => thread.id),
        [id],
      );
      assert.strictEqual((yield* store.getShellSnapshot()).threads.length, 2);
    }).pipe(Effect.provide(routedStore())),
  );
});

import { assert, it } from "@effect/vitest";
import { ClaudeSessionAdoptInput, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Journal from "./ClaudeSessionJournal.ts";

const operationId = "10000000-0000-4000-8000-000000000003";
const scope = {
  contractVersion: 1,
  environmentId: "fixture",
  projectId: "fixture",
  threadId: "10000000-0000-4000-8000-000000000001",
};
const input = Schema.decodeUnknownSync(ClaudeSessionAdoptInput)({
  ...scope,
  operationId,
  expectedEpoch: null,
  providerInstanceId: "claude-fixture",
  nativeId: "10000000-0000-4000-8000-000000000002",
  selection: {
    profile: "manual-selected-v1",
    model: "claude-sonnet-4-6",
    runtimeMode: "approval-required",
  },
  sourceStopped: {
    kind: "operator-stopped",
    knownPreviousProcess: null,
    terminal: {
      boot: operationId,
      socket: { device: "1", inode: "2" },
      workspaceId: "w",
      tabId: "t",
      paneId: "p",
      terminalId: "terminal",
      pty: { device: "136", inode: "1" },
      shell: { pid: 424242, start: "1", boot: operationId },
    },
  },
});
const layer = Journal.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect(
  "persists exact operation requests and refuses changed semantics across reconstruction",
  () =>
    Effect.gen(function* () {
      const journal = yield* Journal.ClaudeSessionJournal;
      const first = yield* journal.begin("adopt", input);
      assert.equal(first.completed, false);
      assert.deepEqual(first.request, input);
      assert.deepEqual(yield* journal.begin("adopt", input), first);
      const conflict = yield* journal
        .begin("adopt", { ...input, selection: { ...input.selection, model: "claude-opus-4-6" } })
        .pipe(Effect.flip);
      assert.equal(conflict.code, "operation-conflict");
      const reconstructed = yield* Effect.gen(function* () {
        const fresh = yield* Journal.ClaudeSessionJournal;
        return yield* fresh.operation(operationId);
      }).pipe(Effect.provide(Journal.layer));
      assert.deepEqual(reconstructed, first);
      assert.equal(yield* journal.get(ThreadId.make(scope.threadId)), null);
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT * FROM orchestration_v2_native_operations`).length, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect("uses canonical sorted JSON hashes while retaining optional-field semantics", () =>
  Effect.gen(function* () {
    const journal = yield* Journal.ClaudeSessionJournal;
    const first = yield* journal.begin("adopt", input);
    const reversed = Object.fromEntries(Object.entries(input).reverse());
    assert.deepEqual(
      yield* journal.begin(
        "adopt",
        yield* Schema.decodeUnknownEffect(ClaudeSessionAdoptInput)(reversed),
      ),
      first,
    );
    const conflict = yield* journal
      .begin("adopt", { ...input, selection: { ...input.selection, effort: "high" } })
      .pipe(Effect.flip);
    assert.equal(conflict.code, "operation-conflict");
  }).pipe(Effect.provide(layer)),
);

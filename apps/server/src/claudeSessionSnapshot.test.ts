import * as Path from "effect/Path";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { captureClaudeSessionSnapshot } from "./claudeSessionSnapshot.ts";

const nativeId = "10000000-0000-4000-8000-000000000002";
const userId = "10000000-0000-4000-8000-000000000010";
const assistantId = "10000000-0000-4000-8000-000000000011";
const abandonedId = "10000000-0000-4000-8000-000000000012";
const setup = Effect.fn("ClaudeSnapshotTest.setup")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectory({ prefix: "claude-snapshot-owned-" });
  const cwd = path.join(root, "repo");
  const projectsRoot = path.join(root, "config", "projects");
  const project = path.join(projectsRoot, "fixture-project");
  yield* fs.makeDirectory(cwd, { recursive: true });
  yield* fs.makeDirectory(project, { recursive: true });
  const transcript = path.join(project, `${nativeId}.jsonl`);
  const rows = [
    {
      type: "user",
      uuid: userId,
      parentUuid: null,
      sessionId: nativeId,
      cwd,
      timestamp: "2026-10-26T00:00:00.000Z",
      message: { role: "user", content: "fixture prompt" },
    },
    {
      type: "assistant",
      uuid: abandonedId,
      parentUuid: userId,
      sessionId: nativeId,
      cwd,
      message: { role: "assistant", content: [{ type: "text", text: "abandoned" }] },
    },
    {
      type: "assistant",
      uuid: assistantId,
      parentUuid: userId,
      sessionId: nativeId,
      cwd,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "active" },
          { type: "thinking", thinking: "retained typed content" },
        ],
      },
    },
  ];
  const bytes = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  yield* fs.writeFileString(transcript, bytes);
  yield* fs.writeFileString(
    path.join(project, "20000000-0000-4000-8000-000000000002.jsonl"),
    "newer unrelated transcript\n",
  );
  return { fs, path, root, cwd, projectsRoot, transcript, rows, bytes };
});

it.effect(
  "reads exactly one immutable UUID through SDK SessionStore without rewriting source",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      const snapshot = yield* Effect.tryPromise(() =>
        captureClaudeSessionSnapshot({
          nativeId,
          cwd: fixture.cwd,
          projectsRoot: fixture.projectsRoot,
        }),
      );
      assert.equal(snapshot.info.sessionId, nativeId);
      assert.equal(snapshot.info.cwd, fixture.cwd);
      assert.deepEqual(
        snapshot.messages.map((message) => message.uuid),
        [userId, assistantId],
      );
      assert.deepEqual(snapshot.messages[1]?.message, fixture.rows[2]?.message);
      assert.equal(yield* fixture.fs.readFileString(fixture.transcript), fixture.bytes);
      const again = yield* Effect.tryPromise(() =>
        captureClaudeSessionSnapshot({
          nativeId,
          cwd: fixture.cwd,
          projectsRoot: fixture.projectsRoot,
        }),
      );
      assert.deepEqual(again, snapshot);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses partial, foreign and conflicting history before producing an authoritative snapshot",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      for (const bytes of [
        fixture.bytes + '{"type":',
        fixture.bytes.replaceAll(nativeId, "30000000-0000-4000-8000-000000000002"),
        fixture.bytes +
          JSON.stringify({ ...fixture.rows[0], message: { role: "user", content: "conflict" } }) +
          "\n",
        fixture.bytes.replaceAll(fixture.cwd, "/foreign"),
      ]) {
        yield* fixture.fs.writeFileString(fixture.transcript, bytes);
        const result = yield* Effect.tryPromise(() =>
          captureClaudeSessionSnapshot({
            nativeId,
            cwd: fixture.cwd,
            projectsRoot: fixture.projectsRoot,
          }),
        ).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects hardlink and symlink aliases instead of granting another physical owner", () =>
  Effect.gen(function* () {
    const fixture = yield* setup();
    const alias = fixture.path.join(fixture.projectsRoot, "alias");
    yield* fixture.fs.makeDirectory(alias);
    yield* fixture.fs.link(fixture.transcript, fixture.path.join(alias, `${nativeId}.jsonl`));
    const input = { nativeId, cwd: fixture.cwd, projectsRoot: fixture.projectsRoot };
    assert.equal(
      (yield* Effect.tryPromise(() => captureClaudeSessionSnapshot(input)).pipe(Effect.result))
        ._tag,
      "Failure",
    );
    const other = yield* setup();
    const rootAlias = other.path.join(other.root, "projects-alias");
    yield* other.fs.symlink(other.projectsRoot, rootAlias);
    assert.equal(
      (yield* Effect.tryPromise(() =>
        captureClaudeSessionSnapshot({
          nativeId,
          cwd: other.cwd,
          projectsRoot: rootAlias,
        }),
      ).pipe(Effect.result))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

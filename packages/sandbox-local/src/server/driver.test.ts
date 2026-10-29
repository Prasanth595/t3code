import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  SandboxId,
  SandboxInstanceId,
  type SandboxCreateRequest,
} from "@t3tools/sandbox-core/schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { LocalSandboxDriver } from "./driver.ts";

const INSTANCE_ID = SandboxInstanceId.make("local");

const openAt = (root: string) =>
  LocalSandboxDriver.open({
    instanceId: INSTANCE_ID,
    config: { root },
  });

describe("LocalSandboxDriver", () => {
  it.effect("creates, resumes, and retries a directory sandbox", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-local-" });
      const opened = yield* openAt(root);
      const probed = yield* opened.probe;
      assert.equal(probed.available, true);

      const created = yield* opened.create({
        displayName: "One",
        idempotencyKey: "sticky",
      } satisfies SandboxCreateRequest);
      assert.equal(created.state, "ready");
      assert.equal(created.displayName, "One");
      assert.equal(created.endpoint, null);
      assert.equal(created.workspacePath, path.join(yield* fs.realPath(root), created.id));
      assert.equal(
        yield* fs.exists(path.join(created.workspacePath ?? root, "sandbox.json")),
        true,
      );

      const listed = yield* opened.list;
      assert.deepEqual(
        listed.map((sandbox) => sandbox.id),
        [created.id],
      );

      const loaded = yield* opened.get(created.id);
      assert.equal(loaded.displayName, "One");

      const retried = yield* opened.create({
        displayName: "Two",
        idempotencyKey: "sticky",
      });
      assert.equal(retried.id, created.id);
      assert.equal(retried.displayName, "One");

      const other = yield* opened.create({ idempotencyKey: "other" });
      assert.notEqual(other.id, created.id);
      assert.equal((yield* opened.list).length, 2);

      const [first, second] = yield* Effect.all(
        [opened.create({ idempotencyKey: "race" }), opened.create({ idempotencyKey: "race" })],
        { concurrency: 2 },
      );
      assert.equal(first.id, second.id);
      assert.equal((yield* opened.list).length, 3);

      const stopped = yield* opened.stop(created.id);
      assert.equal(stopped.state, "stopped");
      assert.equal((yield* opened.stop(created.id)).state, "stopped");
      const retryStopped = yield* opened.create({ idempotencyKey: "sticky" });
      assert.equal(retryStopped.id, created.id);
      assert.equal(retryStopped.state, "stopped");
      const resumed = yield* opened.start(created.id);
      assert.equal(resumed.state, "ready");

      const missing = yield* opened.get(SandboxId.make("missing")).pipe(Effect.flip);
      assert.equal(missing._tag, "SandboxNotFoundError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps sandboxes from one root out of another", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-root-a-" });
      const otherRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-root-b-" });
      const first = yield* openAt(root);
      const second = yield* LocalSandboxDriver.open({
        instanceId: SandboxInstanceId.make("other"),
        config: { root: otherRoot },
      });
      const created = yield* first.create({ idempotencyKey: "shared" });
      assert.equal((yield* second.list).length, 0);
      const missing = yield* second.get(created.id).pipe(Effect.flip);
      assert.equal(missing._tag, "SandboxNotFoundError");

      const shared = yield* LocalSandboxDriver.open({
        instanceId: SandboxInstanceId.make("shared"),
        config: { root },
      });
      const sameKey = yield* shared.create({ idempotencyKey: "shared" });
      assert.notEqual(sameKey.id, created.id);
      assert.equal((yield* shared.list).map((sandbox) => sandbox.id).join(","), sameKey.id);
      assert.equal((yield* first.get(sameKey.id).pipe(Effect.flip))._tag, "SandboxNotFoundError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects configuration and records that leave the root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const relative = yield* LocalSandboxDriver.open({
        instanceId: INSTANCE_ID,
        config: { root: "relative/sandboxes" },
      }).pipe(Effect.flip);
      assert.equal(relative._tag, "SandboxConfigError");

      const decoded = yield* LocalSandboxDriver.openUnknown({
        instanceId: INSTANCE_ID,
        config: { root: 1 },
      }).pipe(Effect.flip);
      assert.equal(decoded._tag, "SandboxConfigError");

      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-parent-" });
      const missingRoot = path.join(parent, "missing", "sandboxes");
      const unavailable = yield* openAt(missingRoot);
      assert.equal((yield* unavailable.probe).available, false);
      const createError = yield* unavailable.create({}).pipe(Effect.flip);
      assert.equal(createError._tag, "SandboxDriverError");
      assert.equal(yield* fs.exists(path.join(parent, "missing")), false);

      const absentRoot = path.join(parent, "sandboxes");
      const absent = yield* openAt(absentRoot);
      const absentStop = yield* absent.stop(SandboxId.make("missing")).pipe(Effect.flip);
      assert.equal(absentStop._tag, "SandboxNotFoundError");
      assert.equal(yield* fs.exists(absentRoot), false);

      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-boundary-" });
      const opened = yield* openAt(root);
      const created = yield* opened.create({ displayName: "Kept" });
      const recordPath = path.join(root, created.id, "sandbox.json");
      yield* fs.writeFileString(recordPath, "{");
      const corrupt = yield* opened.get(created.id).pipe(Effect.flip);
      assert.equal(corrupt._tag, "SandboxDriverError");
      const retry = yield* opened.create({ idempotencyKey: "keep" }).pipe(Effect.flip);
      assert.equal(retry._tag, "SandboxDriverError");
      assert.deepEqual(yield* fs.readDirectory(root), [created.id]);
      assert.deepEqual(yield* opened.list, []);

      yield* fs.writeFileString(recordPath, JSON.stringify({ id: "otherid", state: "stopped" }));
      const mismatched = yield* opened.get(created.id).pipe(Effect.flip);
      assert.equal(mismatched._tag, "SandboxDriverError");

      if ((yield* HostProcess.Platform) !== "win32") {
        const outside = path.join(parent, "linked.json");
        const outsideRecord = JSON.stringify({ id: created.id, state: "stopped" });
        yield* fs.writeFileString(outside, outsideRecord);
        yield* fs.remove(recordPath);
        yield* fs.symlink(outside, recordPath);
        const linked = yield* opened.get(created.id).pipe(Effect.flip);
        assert.equal(linked._tag, "SandboxPathEscapesError");
        assert.equal(yield* fs.readFileString(outside), outsideRecord);
        const stopped = yield* opened.stop(created.id).pipe(Effect.flip);
        assert.equal(stopped._tag, "SandboxPathEscapesError");
        assert.equal(yield* fs.readFileString(outside), outsideRecord);

        const outsideDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-outside-" });
        const outsideFile = path.join(outsideDir, "record.json");
        yield* fs.writeFileString(outsideFile, "kept\n");
        yield* fs.symlink(outsideDir, path.join(root, created.id, "linkdir"));
        yield* fs.remove(recordPath);
        yield* fs.symlink(path.join("linkdir", "record.json"), recordPath);
        const throughParent = yield* opened.stop(created.id).pipe(Effect.flip);
        assert.equal(throughParent._tag, "SandboxPathEscapesError");
        const throughParentStart = yield* opened.start(created.id).pipe(Effect.flip);
        assert.equal(throughParentStart._tag, "SandboxPathEscapesError");
        assert.equal(yield* fs.readFileString(outsideFile), "kept\n");

        const linkRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-linkdir-" });
        const linkedDriver = yield* openAt(linkRoot);
        const made = yield* linkedDriver.create({});
        const directory = path.join(linkRoot, made.id);
        yield* fs.remove(directory, { recursive: true });
        yield* fs.symlink(linkRoot, directory);
        const linkedGet = yield* linkedDriver.get(made.id).pipe(Effect.flip);
        assert.equal(linkedGet._tag, "SandboxPathEscapesError");
        const linkedStop = yield* linkedDriver.stop(made.id).pipe(Effect.flip);
        assert.equal(linkedStop._tag, "SandboxPathEscapesError");
        assert.equal(yield* fs.exists(path.join(linkRoot, "sandbox.json")), false);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

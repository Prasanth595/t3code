import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";

import * as ProcessRunner from "../processRunner.ts";
import * as ProjectFileReader from "./ProjectFileReader.ts";

const onDarwin = Layer.succeed(HostProcess.Platform, "darwin");

/** Every read outlives the deadline, like an open() waiting on a macOS privacy prompt. */
const makeBlockedReader = () => {
  const reads: Array<string> = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) => {
      reads.push(input.args.at(-1) ?? "");
      return Effect.succeed({
        stdout: "",
        stderr: "",
        code: null,
        timedOut: true,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      });
    },
  });
  const layer = Layer.effect(ProjectFileReader.ProjectFileReader, ProjectFileReader.make()).pipe(
    Layer.provide(Layer.mergeAll(Layer.succeed(ProcessRunner.ProcessRunner, runner), onDarwin)),
  );
  return { reads, layer };
};

/** The real runner on darwin's code path, with stub binaries standing in for cat and find. */
const layerWithBinaries = (binaries?: { readonly cat: string; readonly find: string }) =>
  Layer.effect(ProjectFileReader.ProjectFileReader, ProjectFileReader.make(binaries)).pipe(
    Layer.provide(Layer.mergeAll(ProcessRunner.layer, onDarwin)),
  );

const writeStub = Effect.fn("ProjectFileReader.test.writeStub")(function* (
  stubPath: string,
  script: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.writeFileString(stubPath, `#!/bin/sh\n${script}\n`);
  yield* fileSystem.chmod(stubPath, 0o755);
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("ProjectFileReader", () => {
  it.layer(NodeServices.layer)("readFileString", (it) => {
    it.effect("skips a path whose read timed out until the retry window passes", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-project-file-" });
        const settingsPath = path.join(cwd, "settings.local.json");
        yield* fileSystem.writeFileString(settingsPath, "{}");
        const { reads, layer } = makeBlockedReader();

        yield* Effect.gen(function* () {
          const reader = yield* ProjectFileReader.ProjectFileReader;
          assert.isUndefined(yield* reader.readFileString(settingsPath));
          assert.isUndefined(yield* reader.readFileString(settingsPath));
          assert.deepEqual(reads, [settingsPath]);

          yield* TestClock.adjust("5 minutes");
          assert.isUndefined(yield* reader.readFileString(settingsPath));
          assert.deepEqual(reads, [settingsPath, settingsPath]);
        }).pipe(Effect.provide(layer));
      }),
    );

    it.effect("never spawns a read for a missing path or a directory such as .git", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-project-file-" });
        yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
        const { reads, layer } = makeBlockedReader();

        yield* Effect.gen(function* () {
          const reader = yield* ProjectFileReader.ProjectFileReader;
          assert.isUndefined(yield* reader.readFileString(path.join(cwd, ".git")));
          assert.isUndefined(yield* reader.readFileString(path.join(cwd, "missing.json")));
          assert.isUndefined(yield* reader.readDirectory(path.join(cwd, "missing")));
        }).pipe(Effect.provide(layer));
        assert.deepEqual(reads, []);
      }),
    );

    it.effect("ignores a file over 1 MiB instead of returning a prefix", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-project-file-" });
        const filePath = path.join(cwd, "t3.json");
        yield* fileSystem.writeFileString(filePath, `"${"x".repeat(1024 * 1024)}"`);

        const reader = yield* ProjectFileReader.ProjectFileReader;
        assert.isUndefined(yield* reader.readFileString(filePath));
      }).pipe(Effect.provide(ProjectFileReader.layer)),
    );
  });

  it.live("reads files and lists directories through cat and find on darwin", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-project-file-" });
      const skillsDir = path.join(tempDir, "skills");
      yield* fileSystem.makeDirectory(path.join(skillsDir, "review"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(skillsDir, "multi\nline"));
      yield* fileSystem.writeFileString(path.join(skillsDir, "review", "SKILL.md"), "# Review");
      const linkedSkillsDir = path.join(tempDir, "linked-skills");
      yield* fileSystem.symlink(skillsDir, linkedSkillsDir);

      yield* Effect.gen(function* () {
        const reader = yield* ProjectFileReader.ProjectFileReader;
        assert.strictEqual(
          yield* reader.readFileString(path.join(skillsDir, "review", "SKILL.md")),
          "# Review",
        );
        assert.deepEqual([...((yield* reader.readDirectory(skillsDir)) ?? [])].sort(), [
          "multi\nline",
          "review",
        ]);
        assert.deepEqual([...((yield* reader.readDirectory(linkedSkillsDir)) ?? [])].sort(), [
          "multi\nline",
          "review",
        ]);
      }).pipe(Effect.provide(layerWithBinaries()));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("kills a cat or find that outlives the deadline and skips the path afterwards", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-project-file-" });
      const settingsPath = path.join(tempDir, "settings.local.json");
      yield* fileSystem.writeFileString(settingsPath, "{}");
      const skillsDir = path.join(tempDir, "skills");
      yield* fileSystem.makeDirectory(skillsDir);
      const pidsPath = path.join(tempDir, "pids");
      // Like a child stuck in an open() that waits on a privacy prompt.
      const stuck = path.join(tempDir, "stuck");
      yield* writeStub(stuck, `echo $$ >> '${pidsPath}'\nexec sleep 1000`);

      yield* Effect.gen(function* () {
        const reader = yield* ProjectFileReader.ProjectFileReader;
        assert.isUndefined(yield* reader.readFileString(settingsPath));
        assert.isUndefined(yield* reader.readFileString(settingsPath));
        assert.isUndefined(yield* reader.readDirectory(skillsDir));
        assert.isUndefined(yield* reader.readDirectory(skillsDir));
      }).pipe(Effect.provide(layerWithBinaries({ cat: stuck, find: stuck })));

      const pids = (yield* fileSystem.readFileString(pidsPath)).trim().split("\n");
      assert.lengthOf(pids, 2);
      for (const pid of pids) {
        assert.throws(() => process.kill(Number(pid), 0), /ESRCH/);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("ignores a read whose output grew past 1 MiB after the stat", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-project-file-" });
      const filePath = path.join(tempDir, "t3.json");
      yield* fileSystem.writeFileString(filePath, "{}");
      const flood = path.join(tempDir, "flood");
      yield* writeStub(flood, "head -c 2000000 /dev/zero | tr '\\0' 'x'");

      yield* Effect.gen(function* () {
        const reader = yield* ProjectFileReader.ProjectFileReader;
        assert.isUndefined(yield* reader.readFileString(filePath));
      }).pipe(Effect.provide(layerWithBinaries({ cat: flood, find: "/usr/bin/find" })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

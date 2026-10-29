import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as LfsObjects from "./LfsObjects.ts";

function layerWith(run: ProcessRunner.ProcessRunner["Service"]["run"]) {
  return LfsObjects.layer.pipe(
    Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run })),
    Layer.provideMerge(NodeServices.layer),
  );
}

function output(stdout: string, code = 0): ProcessRunner.ProcessRunOutput {
  return {
    stdout,
    stderr: "",
    code: ChildProcessSpawner.ExitCode(code),
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  };
}

describe("LfsObjects", () => {
  it.effect(
    "shares concurrent storage discovery within a workspace and keeps workspaces separate",
    () => {
      const calls: ProcessRunner.ProcessRunInput[] = [];
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        const objects = yield* LfsObjects.LfsObjects;
        const oid = "ab".repeat(32);
        const cwd = path.resolve("workspace");
        const storage = path.join(cwd, "custom storage", "objects");
        const paths = yield* Effect.all(
          [objects.localPath(cwd, oid), objects.localPath(cwd, oid)],
          { concurrency: 2 },
        );
        expect(paths).toEqual([0, 1].map(() => path.join(storage, "ab", "ab", oid)));
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ command: "git", args: ["lfs", "env"], cwd });
        yield* objects.localPath(path.resolve("another workspace"), oid);
        expect(calls).toHaveLength(2);
        expect(yield* objects.localPath(cwd, "../outside")).toBeNull();
        expect(calls).toHaveLength(2);
      }).pipe(
        Effect.provide(
          layerWith((input) =>
            Effect.sync(() => {
              calls.push(input);
              return output(`LocalMediaDir=${input.cwd}/custom storage/objects\r\n`);
            }),
          ),
        ),
      );
    },
  );

  it.effect(
    "reports unavailable storage when Git LFS fails or provides no absolute object directory",
    () =>
      Effect.gen(function* () {
        for (const result of [
          output("", 1),
          output("LocalMediaDir=relative/objects\n"),
          output(""),
        ]) {
          const resolved = yield* Effect.gen(function* () {
            const objects = yield* LfsObjects.LfsObjects;
            return yield* objects.localPath("workspace", "ab".repeat(32));
          }).pipe(Effect.provide(layerWith(() => Effect.succeed(result))));
          expect(resolved).toBeNull();
        }
      }),
  );
});

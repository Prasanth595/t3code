import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  detectManagedPackage,
  managedUninstallMessage,
  managedUpdateMessage,
} from "./packageManager.ts";
import * as ProcessRunner from "../processRunner.ts";

const runnerReturning = (stdout: string, code: number) =>
  ProcessRunner.ProcessRunner.of({
    run: () =>
      Effect.succeed({
        stdout,
        stderr: "",
        code: ChildProcessSpawner.ExitCode(code),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
  });

it.layer(NodeServices.layer)("t3 package ownership", (it) => {
  it.effect("reports the pacman package that owns the running executable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const entry = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-pacman-" }),
        "opt/t3code-fork-server/t3",
      );
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.writeFileString(entry, "");

      const managed = yield* detectManagedPackage(entry).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runnerReturning("t3code-fork\n", 0)),
      );

      assert.strictEqual(managed?.name, "t3code-fork");
    }),
  );

  it.effect("stays out of the way when pacman does not own the executable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const entry = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-pacman-" }),
        "runtime/versions/1.0.0/t3",
      );
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.writeFileString(entry, "");

      const managed = yield* detectManagedPackage(entry).pipe(
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          runnerReturning("error: No package owns /tmp/t3\n", 1),
        ),
      );

      assert.isUndefined(managed);
    }),
  );

  it.effect("points update and uninstall at pacman", () =>
    Effect.sync(() => {
      const managed = { name: "t3code-fork", rebuildCommand: "yay -Bi /home/henry/pkgbuilds/t3" };
      assert.include(managedUpdateMessage(managed), "yay -Bi /home/henry/pkgbuilds/t3");
      assert.include(managedUninstallMessage(managed), "sudo pacman -Rns t3code-fork");
      assert.notInclude(
        managedUpdateMessage({ name: "t3code-fork", rebuildCommand: undefined }),
        "yay",
      );
    }),
  );
});

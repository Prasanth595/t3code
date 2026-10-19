// @effect-diagnostics nodeBuiltinImport:off - Executes the generated launcher with native cmd.exe on Windows.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeStreamConsumers from "node:stream/consumers";

import { repointLauncher, resolveLauncherPath } from "./update.ts";

it.layer(NodeServices.layer)("t3 update launcher", (it) => {
  it.effect("repoints a symlink that lives in a runtime versions tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const oldExe = path.join(root, "runtime/versions/1.0.0/t3");
      const newExe = path.join(root, "runtime/versions/2.0.0/t3");
      const launcher = path.join(root, "bin/t3");
      for (const file of [oldExe, newExe]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.symlink(oldExe, launcher);

      const repointed = yield* repointLauncher({
        launchedAs: launcher,
        versionsDir: path.join(root, "runtime/versions"),
        targetEntryPath: newExe,
      });

      assert.deepStrictEqual(Option.getOrUndefined(repointed), launcher);
      assert.equal(yield* fs.readLink(launcher), newExe);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("leaves a plain copy or a foreign symlink alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const newExe = path.join(root, "runtime/versions/2.0.0/t3");
      const copy = path.join(root, "copy/t3");
      const foreign = path.join(root, "foreign/t3");
      const elsewhere = path.join(root, "elsewhere/t3");
      const otherHome = path.join(root, "other/runtime/versions/1.0.0/t3");
      const otherLauncher = path.join(root, "other/bin/t3");
      for (const file of [newExe, copy, elsewhere, otherHome]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(foreign), { recursive: true });
      yield* fs.symlink(elsewhere, foreign);
      yield* fs.makeDirectory(path.dirname(otherLauncher), { recursive: true });
      yield* fs.symlink(otherHome, otherLauncher);

      for (const launchedAs of [copy, foreign, otherLauncher, undefined]) {
        const repointed = yield* repointLauncher({
          launchedAs,
          versionsDir: path.join(root, "runtime/versions"),
          targetEntryPath: newExe,
        });
        assert.equal(repointed._tag, "None", launchedAs ?? "undefined");
      }
      assert.equal(yield* fs.readLink(foreign), elsewhere);
      assert.equal(yield* fs.readLink(otherLauncher), otherHome);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("finds the launcher a bare command name resolved to on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const launcher = path.join(root, "bin/t3");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.writeFileString(launcher, "");

      const bare = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcess.InvokedAs, "t3"),
        Effect.provideService(HostProcess.Environment, {
          PATH: `${path.join(root, "missing")}:${path.join(root, "bin")}`,
        }),
        Effect.provideService(HostProcess.WorkingDirectory, root),
      );
      const relative = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcess.InvokedAs, "./bin/t3"),
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
        Effect.provideService(HostProcess.WorkingDirectory, root),
      );
      const absent = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcess.InvokedAs, "t3"),
        Effect.provideService(HostProcess.Environment, { PATH: path.join(root, "missing") }),
        Effect.provideService(HostProcess.WorkingDirectory, root),
      );

      assert.equal(bare, launcher);
      assert.equal(relative, launcher);
      assert.equal(absent, undefined);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("repoints a Windows shim without losing arguments, exit status, or codepage", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const versions = path.join(root, "Déry home/runtime/versions");
      const oldExe = path.join(versions, "1.0.0/t3.exe");
      const newExe = path.join(versions, "2.0.0/t3.exe");
      const bin = path.join(root, "bin");
      const shim = path.join(bin, "t3.cmd");
      yield* fs.makeDirectory(path.dirname(newExe), { recursive: true });
      yield* fs.makeDirectory(bin);
      yield* fs.writeFileString(shim, `@echo off\r\n"${oldExe}" %*\r\n`);

      const repointed = yield* repointLauncher({
        launchedAs: oldExe,
        versionsDir: versions,
        targetEntryPath: newExe,
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, { PATH: bin }),
      );
      assert.equal(Option.getOrUndefined(repointed), shim);

      if (HostProcess.Platform.defaultValue() !== "win32") {
        // Other hosts cannot execute cmd; check the emitted contract as a limited fallback.
        const contents = yield* fs.readFileString(shim);
        assert.ok(contents.includes("setlocal EnableExtensions DisableDelayedExpansion"));
        assert.match(contents, /chcp 65001 >nul\r?\n/);
        assert.ok(contents.includes(`"${newExe}" %*`));
        assert.match(contents, /set "T3EC=%ERRORLEVEL%"\r?\nif defined T3CP chcp %T3CP% >nul/);
        assert.match(contents, /exit \/b %T3EC%/);
        yield* repointLauncher({
          launchedAs: newExe,
          versionsDir: versions,
          targetEntryPath: path.join(root, "runtime/versions/2.0.0/t3.exe"),
        }).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.Environment, { PATH: bin }),
        );
        assert.ok(!(yield* fs.readFileString(shim)).includes("chcp"));
        return;
      }

      yield* fs.copyFile(HostProcess.ExecutablePath.defaultValue(), newExe);
      yield* fs.writeFileString(
        path.join(bin, "fixture.cjs"),
        "console.log(JSON.stringify(process.argv.slice(2))); process.exit(Number(process.argv[2]));",
      );
      yield* fs.writeFileString(
        path.join(bin, "run.cmd"),
        [
          "@echo off",
          'for /f "tokens=2 delims=:." %%c in (\'chcp\') do set "TEST_CP=%%c"',
          "chcp 437 >nul",
          "for /f \"tokens=2 delims=:.\" %%c in ('chcp') do echo BEFORE=%%c",
          'set "T3CP=caller-codepage"',
          'set "T3EC=caller-status"',
          'call t3.cmd fixture.cjs %1 "one two" three',
          'set "TEST_EXIT=%ERRORLEVEL%"',
          'if not "%T3CP%:%T3EC%"=="caller-codepage:caller-status" exit /b 99',
          "for /f \"tokens=2 delims=:.\" %%c in ('chcp') do echo AFTER=%%c",
          "chcp %TEST_CP% >nul",
          "exit /b %TEST_EXIT%",
          "",
        ].join("\r\n"),
      );
      yield* Effect.tryPromise(async () => {
        for (const status of [0, 42]) {
          const child = NodeChildProcess.spawn("cmd.exe", ["/d", "/c", "run.cmd", `${status}`], {
            cwd: bin,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 10_000,
          });
          const [exitCode, stdout, stderr] = await Promise.all([
            new Promise<number | null>((resolve, reject) => {
              child.once("error", reject);
              child.once("close", resolve);
            }),
            NodeStreamConsumers.text(child.stdout),
            NodeStreamConsumers.text(child.stderr),
          ]);
          assert.equal(exitCode, status, stderr);
          assert.ok(stdout.includes(JSON.stringify([`${status}`, "one two", "three"])));
          assert.match(stdout, /BEFORE=\s*437\r?\n/);
          assert.match(stdout, /AFTER=\s*437\r?\n/);
        }
      });
    }).pipe(Effect.scoped),
  );
});

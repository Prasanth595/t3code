import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import { afterEach, vi } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import {
  repointLauncher,
  resolveLauncherPath,
  resolveNewestVersion,
  resolveNextStep,
} from "./update.ts";

afterEach(() => vi.restoreAllMocks());

it.effect("authenticates each release page until the requested channel is found", () =>
  Effect.gen(function* () {
    const pages: string[] = [];
    const httpClient = HttpClient.make((request) => {
      const url = new URL(request.url);
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(url.pathname, "/repos/pingdotgg/t3code/releases");
      assert.equal(request.headers.accept, "application/vnd.github+json");
      assert.equal(request.headers.authorization, "Bearer gh-token");
      const page = url.searchParams.get("page") ?? "";
      pages.push(page);
      const tag_name = page === "1" ? "v1.2.4-preview.20260101.1" : "v1.2.3";
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json([{ tag_name }])));
    });
    const version = yield* resolveNewestVersion("stable").pipe(
      Effect.provideService(HostProcess.Environment, { GH_TOKEN: "gh-token" }),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    assert.equal(version, "1.2.3");
    assert.deepStrictEqual(pages, ["1", "2"]);
  }),
);

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

  it.effect("tells npm users how to move the t3 their package still pins", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const executable = path.join(root, ".t3/runtime/versions/1.0.0/t3");
      const prefix = path.join(root, "node");
      const npmGlobal = path.join(prefix, "lib/node_modules/t3/bin/t3.mjs");
      const npx = path.join(root, ".npm/_npx/abc/node_modules/t3/bin/t3.mjs");
      const projectLocal = path.join(root, "project/node_modules/t3/bin/t3.mjs");
      yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.writeFileString(executable, "");
      for (const launcher of [npmGlobal, npx, projectLocal]) {
        yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
        yield* fs.writeFileString(launcher, "");
        yield* fs.writeFileString(
          path.join(path.dirname(launcher), "../package.json"),
          `{"name":"t3","version":"${packageJson.version}","bin":{"t3":"./bin/t3.mjs"}}`,
        );
      }
      yield* fs.makeDirectory(path.join(prefix, "bin"));
      yield* fs.symlink(npmGlobal, path.join(prefix, "bin/t3"));
      const realPrefix = yield* fs.realPath(prefix);
      const stillRuns = `The t3 npm package still runs ${packageJson.version}.`;

      for (const [launcher, targetVersion, expected] of [
        [
          npmGlobal,
          "9.9.9",
          `${stillRuns} Run \`npm install --global --prefix ${realPrefix} t3@9.9.9\` to move to 9.9.9.`,
        ],
        [npx, "9.9.9", `${stillRuns} Run \`npx t3@9.9.9\` to move to 9.9.9.`],
        [
          projectLocal,
          "9.9.9",
          `${stillRuns} Update it to t3@9.9.9 with the package manager that installed it.`,
        ],
        [undefined, "9.9.9", "Run /runtime/versions/9.9.9/t3"],
        [npmGlobal, packageJson.version, `Run /runtime/versions/${packageJson.version}/t3`],
        [npx, packageJson.version, `Run /runtime/versions/${packageJson.version}/t3`],
        [projectLocal, packageJson.version, `Run /runtime/versions/${packageJson.version}/t3`],
        [undefined, packageJson.version, `Run /runtime/versions/${packageJson.version}/t3`],
      ] as const) {
        const nextStep = yield* resolveNextStep({
          repointed: false,
          entryPath: `/runtime/versions/${targetVersion}/t3`,
          targetVersion,
        }).pipe(
          Effect.provideService(HostProcess.ExecutablePath, executable),
          Effect.provideService(HostProcess.Arguments, [executable, executable]),
          Effect.provideService(HostProcess.IsExecutable, true),
          Effect.provideService(
            HostProcess.Environment,
            launcher === undefined ? {} : { T3CODE_NPM_LAUNCHER_PATH: launcher },
          ),
        );
        assert.equal(nextStep, expected, launcher ?? "standalone");
      }
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );
});

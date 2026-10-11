// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { type FxAdapterV2 } from "./adapter.ts";
import { FxDriver } from "./driver.ts";

const fixturesDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const SIGNED_IN_STATUS = NodeFS.readFileSync(
  NodePath.join(fixturesDir, "fx-status-signed-in.json"),
  "utf8",
);
const MODELS_JSON = NodeFS.readFileSync(NodePath.join(fixturesDir, "fx-models.json"), "utf8");

const testLayer = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("fx driver tests must not make an HTTP request")),
    ),
  ),
);

function fakeFx(directory: string) {
  return writeFakeCli({
    directory,
    name: "fx",
    source: [
      "const args = process.argv.slice(2);",
      'if (args[0] === "--version") {',
      '  process.stdout.write("fx 0.0.13\\n");',
      "  process.exit(0);",
      "}",
      'if (args[0] === "status" && args[1] === "--json") {',
      `  process.stdout.write(${JSON.stringify(SIGNED_IN_STATUS)});`,
      "  process.exit(0);",
      "}",
      'if (args[0] === "models" && args[1] === "--json") {',
      `  process.stdout.write(${JSON.stringify(MODELS_JSON)});`,
      "  process.exit(0);",
      "}",
      "process.exit(3);",
      "",
    ].join("\n"),
  });
}

it.layer(testLayer)("FxDriver", (it) => {
  it.effect("disables text generation and feeds the probed default model to the adapter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fx-driver-" });
      const instance = yield* FxDriver.create({
        instanceId: ProviderInstanceId.make("fx-probe"),
        displayName: "fx test",
        enabled: true,
        environment: [],
        config: { ...FxDriver.defaultConfig(), enabled: true, binaryPath: fakeFx(dir) },
      });

      const snapshot = yield* instance.snapshot.refresh;
      expect(snapshot.supportsTextGeneration).toBe(false);
      expect(snapshot.auth).toEqual({ status: "authenticated", label: "fx login" });
      expect(yield* (instance.orchestrationAdapter as FxAdapterV2).currentFxDefaultModel).toBe(
        "anthropic/claude-opus-5.5",
      );
      const titleError = yield* Effect.flip(
        instance.textGeneration.generateThreadTitle({
          cwd: dir,
          message: "name this thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("fx"),
            model: "default",
          } satisfies ModelSelection,
        }),
      );
      expect(titleError.operation).toBe("generateThreadTitle");
      expect(titleError.detail).toBe("fx does not provide application text generation yet.");
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("lists discovered skills on the workspace snapshot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fx-driver-skills-" });
      const home = path.join(dir, "home");
      const workspace = path.join(home, "project");
      const skillDir = path.join(workspace, ".fx", "skills", "review");
      yield* fs.makeDirectory(skillDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(skillDir, "SKILL.md"),
        ["---", "name: review", "description: Review the diff.", "---"].join("\n"),
      );
      const instance = yield* FxDriver.create({
        instanceId: ProviderInstanceId.make("fx-skills"),
        displayName: "fx test",
        enabled: true,
        environment: [{ name: "HOME", value: home, sensitive: false }],
        config: { ...FxDriver.defaultConfig(), enabled: true, binaryPath: fakeFx(dir) },
      });

      const snapshotForCwd = instance.snapshotForCwd;
      if (snapshotForCwd === undefined) {
        throw new Error("fx driver did not provide snapshotForCwd");
      }
      const snapshot = yield* snapshotForCwd(workspace);
      expect(snapshot.skills).toEqual([
        {
          name: "review",
          path: path.join(skillDir, "SKILL.md"),
          scope: "project",
          enabled: true,
          description: "Review the diff.",
        },
      ]);
    }).pipe(Effect.scoped),
  );
});

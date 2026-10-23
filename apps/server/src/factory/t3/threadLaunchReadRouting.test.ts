// @effect-diagnostics nodeBuiltinImport:off - the database is a real file in a temp directory.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { useTempDirs } from "../ledger/testSupport.ts";
import { seedProjection } from "./projectionFixture.testkit.ts";
import * as Routed from "./projectionStoreReadRouting.ts";
import { connectionsOf } from "./spanConnections.testkit.ts";

const tempDir = useTempDirs();

const layerPlatform = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({}),
);
const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-factory-thread-launch-routing-",
});

/**
 * Upstream's runtime layer as server.ts builds it, over a file database so the reader worker
 * exists. ThreadLaunchService's prepare loop reads the shell snapshot through
 * ThreadManagementService and the Orchestrator, whose store this layer provides.
 */
const runtime = () =>
  RuntimeLayer.layer.pipe(
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(McpProviderSessions.layer),
    Layer.provideMerge(
      SqlitePersistence.layerFromPath(NodePath.join(tempDir("launch"), "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provide(
      CheckpointStore.layer.pipe(
        Layer.provide(
          VcsDriverRegistry.layer.pipe(
            Layer.provide(VcsProcess.layer),
            Layer.provide(layerServerConfig),
            Layer.provide(layerPlatform),
          ),
        ),
      ),
    ),
    Layer.provide(layerServerConfig),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: () => Effect.succeed(undefined),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(Layer.mock(GitWorkflow.GitWorkflowService)({})),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(layerPlatform),
  );

describe("ThreadLaunchService's shell snapshot", () => {
  it.effect("runs on the reader", () =>
    Effect.gen(function* () {
      yield* seedProjection([{}, {}]).pipe(Effect.provide(Routed.layer));
      const threads = yield* ThreadManagement.ThreadManagementService;
      assert.deepStrictEqual(yield* connectionsOf(threads.getShellSnapshot()), new Set(["reader"]));
      assert.strictEqual((yield* threads.getShellSnapshot()).threads.length, 2);
    }).pipe(Effect.provide(runtime())),
  );
});

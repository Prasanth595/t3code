import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { AcpRegistryDriver } from "@t3tools/provider-acp-registry/server";
import { AcpRegistryProbe } from "@t3tools/provider-acp-registry/testing";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { vi } from "vite-plus/test";

import { GlmDriver } from "./driver.ts";

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
);

const catalog: AcpRegistrySupport.AcpRegistryCatalog["Service"] = {
  search: () => Effect.die("The driver must not search the registry"),
  prepare: () => Effect.die("The driver must not install an agent"),
  inspect: (settings) =>
    Effect.succeed({
      status: "ready",
      agentId: settings.agentId,
      version: "1.0.0",
      distribution: "npx",
    }),
  resolve: () =>
    Effect.fail(
      new AcpRegistrySupport.AcpRegistryError({
        reason: "probe_failed",
        detail: "No sign-in process in this fixture",
      }),
    ),
  uninstallManagedBinary: () => Effect.die("The driver must not uninstall an agent"),
};

const noSpawner = ChildProcessSpawner.make(() => Effect.die("The test must not spawn an agent"));
const discovered = (snapshot: ServerProvider) =>
  snapshot.models.some((model) => model.slug === "glm-discovered");

const nextDiscovery = Effect.fn("test.nextGlmDiscovery")(function (
  snapshot: ManagedServerProvider,
) {
  return snapshot.streamChanges.pipe(
    Stream.filter(discovered),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.forkChild({ startImmediately: true }),
  );
});

const awaitInitialDiscovery = Effect.fn("test.awaitInitialDiscovery")(function* (
  snapshot: ManagedServerProvider,
) {
  const next = yield* nextDiscovery(snapshot);
  const current = yield* snapshot.getSnapshot;
  if (discovered(current)) {
    yield* Fiber.interrupt(next);
    return current;
  }
  return yield* Fiber.join(next);
});

const setup = Effect.fn("test.setupGlmDriver")(function* () {
  const host = yield* ProviderHost.ProviderHost;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const home = path.join(host.paths.baseDir, "glm-home");
  const configHome = path.join(home, ".config");
  yield* fs.makeDirectory(configHome, { recursive: true });
  const probe = vi
    .spyOn(AcpRegistryProbe, "probeAcpRegistryConfiguration")
    .mockImplementation((input) =>
      Effect.succeed({
        probe: {
          instanceId: input.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [{ id: "glm-discovered", name: "GLM", description: null }],
          currentModelId: "glm-discovered",
          configOptions: [],
          sessionManagement: {
            canList: false,
            canLoad: false,
            canResume: false,
            canLogout: false,
            canDelete: false,
            canConfigureProviders: false,
          },
        },
        slashCommands: [],
        skills: [],
      }),
    );
  yield* Effect.addFinalizer(() => Effect.sync(() => probe.mockRestore()));
  const requests: Array<{ readonly url: string; readonly authorization: string | undefined }> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({ url: request.url, authorization: request.headers.authorization });
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          code: 200,
          data: {
            limits: [
              { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 10 + requests.length },
            ],
          },
        }),
      );
    }),
  );
  const environment = { HOME: home, XDG_CONFIG_HOME: configHome, Z_AI_API_KEY: "ambient-host-key" };
  return { home, configHome, probe, requests, client, environment };
});

it.layer(layerTest)("GlmDriver", (it) => {
  it.effect("refreshes instance quota even while ACP discovery is cached", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup();
        const instance = yield* GlmDriver.create({
          instanceId: ProviderInstanceId.make("glm_work"),
          displayName: "Work GLM",
          enabled: true,
          environment: [
            { name: "Z_AI_API_KEY", value: "instance-key", sensitive: true },
            {
              name: "ACP_GLM_BASE_URL",
              value: "https://open.bigmodel.cn/api/coding/paas/v4",
              sensitive: false,
            },
          ],
          config: GlmDriver.defaultConfig(),
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
          Effect.provideService(HostProcess.Environment, fixture.environment),
          Effect.provideService(HostProcess.HomeDirectory, fixture.home),
          Effect.provideService(HttpClient.HttpClient, fixture.client),
        );
        const initial = yield* awaitInitialDiscovery(instance.snapshot);
        expect(initial.driver).toBe("glm");
        expect(instance.acpSessionManagement?.identityDriver).toBe("acpRegistry");
        expect(fixture.probe).toHaveBeenCalledTimes(1);
        for (let refresh = 0; refresh < 2; refresh += 1) {
          const previousRequests = fixture.requests.length;
          const enriched = yield* nextDiscovery(instance.snapshot);
          yield* instance.snapshot.refresh;
          const published = yield* Fiber.join(enriched);
          expect(fixture.requests).toHaveLength(previousRequests + 1);
          expect(published.usageLimits?.windows[0]?.usedPercent).toBe(10 + fixture.requests.length);
          expect(fixture.probe).toHaveBeenCalledTimes(1);
        }
        expect(fixture.requests.every((request) => request.authorization === "instance-key")).toBe(
          true,
        );
        expect(
          fixture.requests.every(
            (request) => request.url === "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect("ignores the host key when this GLM instance has no credentials", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup();
        const instance = yield* GlmDriver.create({
          instanceId: ProviderInstanceId.make("glm_no_credentials"),
          displayName: undefined,
          enabled: true,
          environment: [],
          config: GlmDriver.defaultConfig(),
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
          Effect.provideService(HostProcess.Environment, fixture.environment),
          Effect.provideService(HostProcess.HomeDirectory, fixture.home),
          Effect.provideService(HttpClient.HttpClient, fixture.client),
        );
        yield* awaitInitialDiscovery(instance.snapshot);
        const snapshot = yield* instance.snapshot.refresh;
        expect(snapshot.usageLimits?.unavailable?.reason).toBe("unsupported");
        expect(fixture.requests).toEqual([]);
      }),
    ),
  );

  it.effect("keeps disabled GLM and unrelated ACP instances from querying GLM quota", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup();
        const instances = yield* Effect.all([
          GlmDriver.create({
            instanceId: ProviderInstanceId.make("glm_disabled"),
            displayName: undefined,
            enabled: false,
            environment: [{ name: "Z_AI_API_KEY", value: "unused-key", sensitive: true }],
            config: GlmDriver.defaultConfig(),
          }),
          AcpRegistryDriver.create({
            instanceId: ProviderInstanceId.make("acpRegistry_kilo"),
            displayName: undefined,
            enabled: true,
            environment: [{ name: "Z_AI_API_KEY", value: "unused-key", sensitive: true }],
            config: { ...AcpRegistryDriver.defaultConfig(), agentId: "kilo" },
          }),
        ]).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
          Effect.provideService(HostProcess.Environment, fixture.environment),
          Effect.provideService(HostProcess.HomeDirectory, fixture.home),
          Effect.provideService(HttpClient.HttpClient, fixture.client),
        );
        const [disabled, unrelated] = instances;
        yield* awaitInitialDiscovery(unrelated.snapshot);
        expect((yield* disabled.snapshot.refresh).status).toBe("disabled");
        expect((yield* unrelated.snapshot.refresh).usageLimits).toBeUndefined();
        expect(fixture.requests).toEqual([]);
        expect(fixture.probe.mock.calls.every(([input]) => input.settings.agentId === "kilo")).toBe(
          true,
        );
      }),
    ),
  );
});

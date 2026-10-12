import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  DeviceHostUnavailableError,
  DeviceId,
  DeviceOperationError,
  LOCAL_DEVICE_HOST_ID,
  ThreadId,
  type DeviceServiceState,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { NodeRuntimeUnavailableError } from "@t3tools/shared/nodeRuntime";

import * as DeviceService from "./DeviceService.ts";
import { DeviceToolchainInstallError } from "./DeviceToolchain.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const isHostUnavailable = Schema.is(DeviceHostUnavailableError);
const isToolchainInstallError = Schema.is(DeviceToolchainInstallError);

const baseState: DeviceServiceState = {
  hosts: [],
  hostStatus: "idle",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: false,
  agentAccessEnabled: false,
  hubBasePath: "/api/device-hub",
  revision: 0,
};

describe("DeviceService.stateStream", () => {
  it.effect("emits the current snapshot and then every published change", () =>
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<DeviceServiceState>();
      const current = yield* Ref.make(baseState);
      const service: Pick<DeviceService.DeviceService["Service"], "state" | "subscribe"> = {
        state: Ref.get(current),
        subscribe: PubSub.subscribe(pubsub),
      };

      const collected = yield* DeviceService.stateStream(
        service as DeviceService.DeviceService["Service"],
      ).pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
      yield* Effect.yieldNow;
      for (const revision of [1, 2]) {
        const next = { ...baseState, revision, hostStatus: "ready" as const };
        yield* Ref.set(current, next);
        yield* PubSub.publish(pubsub, next);
      }
      const seen = yield* Fiber.join(collected);
      expect(seen.map((state) => state.revision)).toEqual([0, 1, 2]);
    }),
  );
});

const fixture = Effect.fn("fixture")(function* (
  onBoot: Effect.Effect<void> = Effect.void,
  bootError?: string,
  failListAfterShutdown = false,
  runtimeFailure?: NodeRuntimeUnavailableError | DeviceHost.DeviceHostError,
  inspectError = false,
  installTool?: Parameters<typeof DeviceService.makeWithHosts>[3],
  agentFailure?: DeviceHost.DeviceHostTimeoutError,
) {
  const settings = yield* Ref.make(DEFAULT_SERVER_SETTINGS);
  const starts: string[] = [];
  const agentStarts: string[] = [];
  const agentStops: string[] = [];
  const requests: string[] = [];
  let booted = false;
  let shutDown = false;
  const ready: DeviceHost.DeviceHostReady = {
    nodePath: process.execPath,
    hub: { origin: "http://device.test" },
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    run: () => Effect.succeed({ code: 0, stdout: "Pixel_API_35\n", stderr: "" }),
  };
  const host: DeviceHost.DeviceHost["Service"] = {
    ...(inspectError
      ? {
          inspect: Effect.fail(
            new DeviceHost.DeviceHostError({
              hostId: LOCAL_DEVICE_HOST_ID,
              step: "probe",
              cause: new Error("offline"),
            }),
          ),
        }
      : {}),
    id: LOCAL_DEVICE_HOST_ID,
    summary: Effect.succeed({
      id: LOCAL_DEVICE_HOST_ID,
      kind: "local",
      label: "Test server",
      platforms: [{ platform: "android", available: true }],
      hubInstalled: true,
      agentDeviceInstalled: false,
    }),
    platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
    ensureReady: (onPhase) =>
      Effect.gen(function* () {
        if (runtimeFailure) return yield* runtimeFailure;
        starts.push("start");
        yield* onPhase("installing", "Updating device hub from 0.9.0 to 0.10.1…");
        return ready;
      }),
    ensureAgentReady: (onPhase) =>
      Effect.gen(function* () {
        if (agentFailure) return yield* agentFailure;
        if (runtimeFailure) return yield* runtimeFailure;
        agentStarts.push("start");
        yield* onPhase("starting");
        return {
          ...ready,
          agentDevice: { baseUrl: "http://agent.test", token: "test", entryPath: "/agent" },
        };
      }),
    current: Effect.succeed(null),
    stopAgent: Effect.sync(() => {
      agentStops.push("stop");
    }),
    stop: Effect.sync(() => {
      starts.push("stop");
    }),
  };
  const service = yield* DeviceService.makeWithHosts(
    new Map([[host.id, host]]),
    undefined,
    undefined,
    installTool,
  ).pipe(
    Effect.provide(NodeCrypto.layer),
    Effect.provideService(DeviceHost.DeviceHost, host),
    Effect.provideService(
      ServerSettings.ServerSettingsService,
      ServerSettings.ServerSettingsService.of({
        updateProviderInstance: () => Effect.die("Unexpected provider mutation"),
        withSettingsSnapshot: (use) => Effect.flatMap(Ref.get(settings), use),
        start: Effect.void,
        ready: Effect.void,
        getSettings: Ref.get(settings),
        updateSettings: (patch) =>
          Ref.updateAndGet(settings, (current) => ({
            ...current,
            enableDeviceSupport: patch.enableDeviceSupport ?? current.enableDeviceSupport,
            enableAgentDeviceAccess:
              patch.enableAgentDeviceAccess ?? current.enableAgentDeviceAccess,
            deviceOnboardingCompleted:
              patch.deviceOnboardingCompleted ?? current.deviceOnboardingCompleted,
          })),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          requests.push(request.url);
          if (request.url.includes("/api/screenshot")) {
            return HttpClientResponse.fromWeb(
              request,
              new Response(new Uint8Array([137, 80, 78, 71])),
            );
          }
          if (request.url.endsWith("/shutdown")) {
            shutDown = true;
            booted = false;
            return HttpClientResponse.fromWeb(request, Response.json({ ok: true }));
          }
          if (shutDown && failListAfterShutdown) {
            return HttpClientResponse.fromWeb(
              request,
              new Response("Discovery busy", { status: 503 }),
            );
          }
          if (request.url.endsWith("/boot")) {
            yield* onBoot;
            booted = true;
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                bootError ? { ok: false, error: bootError } : { ok: true, serial: "emulator-5554" },
              ),
            );
          }
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              simulators: [],
              emulators: booted
                ? [
                    {
                      id: "emulator-5554",
                      name: "Pixel_API_35",
                      platform: "android",
                      version: "Android 15",
                      booted: true,
                      physical: false,
                    },
                  ]
                : [],
            }),
          );
        }),
      ),
    ),
  );
  return { service, starts, agentStarts, agentStops, requests, settings };
});

const installGuidance =
  "Device tool installation failed. Check npm's debug log on the environment server. Review filesystem permissions, registry access, and npm policies such as min-release-age or before, then retry.";
const unsafeDiagnostic = "UNSAFE_NPM_DIAGNOSTIC https://private:credential@registry.test/package";

describe("device installation diagnostics", () => {
  it.effect.each(["installing device support", "installing agent tools"])(
    "explains $0 failures through readiness, listing, and retry",
    (step) =>
      Effect.gen(function* () {
        const toolchainFailure = new DeviceToolchainInstallError({
          tool: step === "installing device support" ? "expo-device-hub" : "agent-device",
          step: "running npm install",
          exitCode: 1,
          cause: { stderr: unsafeDiagnostic },
        });
        const failure = new DeviceHost.DeviceHostError({
          hostId: LOCAL_DEVICE_HOST_ID,
          step,
          cause: toolchainFailure,
        });
        const { service, settings } = yield* fixture(Effect.void, undefined, false, failure);
        yield* Ref.update(settings, (current) => ({
          ...current,
          enableDeviceSupport: true,
          enableAgentDeviceAccess: true,
        }));
        for (const operation of [service.readiness(), service.agentReadinessIfSupported()]) {
          const error = yield* operation.pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "DeviceHostUnavailableError",
            hostId: LOCAL_DEVICE_HOST_ID,
            reason: installGuidance,
          });
          if (isHostUnavailable(error)) expect(error.cause).toBe(failure);
          expect(error.message).not.toContain(unsafeDiagnostic);
          expect((yield* service.state).hostStatuses[LOCAL_DEVICE_HOST_ID]).toEqual({
            status: "failed",
            detail: installGuidance,
          });
        }
        for (const operation of [service.list, service.retryHost(LOCAL_DEVICE_HOST_ID)]) {
          const state = yield* operation;
          expect(state.hostStatusDetail).toBe(installGuidance);
          expect(state.hostStatuses[LOCAL_DEVICE_HOST_ID]).toEqual({
            status: "failed",
            detail: installGuidance,
          });
          expect(state.hostStatusDetail).not.toContain(unsafeDiagnostic);
        }
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    {
      step: "probe",
      reason: "Could not connect to this host over SSH.",
      detail: "Device host local failed while probe.",
    },
    {
      step: "start",
      reason: "Device support failed during start.",
      detail: "Device host local failed while start.",
    },
    {
      step: "agent-start",
      reason: "Device support failed during agent-start.",
      detail: "Device host local failed while agent-start.",
    },
  ])("preserves the $step explanation", ({ step, reason, detail }) =>
    Effect.gen(function* () {
      const failure = new DeviceHost.DeviceHostError({
        hostId: LOCAL_DEVICE_HOST_ID,
        step,
        cause: new Error(unsafeDiagnostic),
      });
      const { service, settings } = yield* fixture(Effect.void, undefined, false, failure);
      yield* Ref.update(settings, (current) => ({
        ...current,
        enableDeviceSupport: true,
        enableAgentDeviceAccess: true,
      }));
      for (const operation of [service.readiness(), service.agentReadinessIfSupported()]) {
        const error = yield* operation.pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "DeviceHostUnavailableError", reason });
        if (isHostUnavailable(error)) expect(error.cause).toBe(failure);
        expect(error.message).not.toContain(unsafeDiagnostic);
        expect((yield* service.state).hostStatuses[LOCAL_DEVICE_HOST_ID]).toEqual({
          status: "failed",
          detail,
        });
      }
    }).pipe(Effect.scoped),
  );

  it.effect("preserves agent startup timeout guidance and its typed cause", () =>
    Effect.gen(function* () {
      const failure = new DeviceHost.DeviceHostTimeoutError({
        hostId: LOCAL_DEVICE_HOST_ID,
        timeoutMs: 1234,
      });
      const { service, settings } = yield* fixture(
        Effect.void,
        undefined,
        false,
        undefined,
        false,
        undefined,
        failure,
      );
      yield* Ref.update(settings, (current) => ({
        ...current,
        enableDeviceSupport: true,
        enableAgentDeviceAccess: true,
      }));
      const error = yield* service.agentReadinessIfSupported().pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "DeviceHostUnavailableError",
        reason: "Agent tools did not start within 1234 ms.",
      });
      if (isHostUnavailable(error)) expect(error.cause).toBe(failure);
      expect((yield* service.state).hostStatuses[LOCAL_DEVICE_HOST_ID]).toEqual({
        status: "failed",
        detail: "Device host local did not start agent tools within 1234 ms.",
      });
    }).pipe(Effect.scoped),
  );
});

const productionFixture = Effect.fn("productionFixture")(function* (
  run: ProcessRunner.ProcessRunner["Service"]["run"],
) {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-diagnostic-" });
  const host = DeviceHost.DeviceHost.of({
    id: LOCAL_DEVICE_HOST_ID,
    summary: Effect.succeed({
      id: LOCAL_DEVICE_HOST_ID,
      kind: "local",
      label: "Test server",
      platforms: [{ platform: "ios", available: true }],
      hubInstalled: false,
      agentDeviceInstalled: false,
    }),
    platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
    ensureReady: () => Effect.die("Unexpected hub startup"),
    ensureAgentReady: () => Effect.die("Unexpected agent startup"),
    current: Effect.succeed(null),
    stop: Effect.die("Unexpected hub stop"),
    stopAgent: Effect.die("Unexpected agent stop"),
  });
  return yield* Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const service = yield* DeviceService.make;
    return { service, settings };
  }).pipe(
    Effect.provide([
      ServerConfig.layerTest(baseDir, baseDir),
      ServerSettings.layerTest({ deviceHosts: [] }),
    ]),
    Effect.provideService(DeviceHost.DeviceHost, host),
    Effect.provideService(ProcessRunner.ProcessRunner, { run }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected HTTP request")),
    ),
    Effect.provideService(NetService.NetService, {
      canListenOnHost: () => Effect.die("Unexpected network access"),
      isPortAvailableOnLoopback: () => Effect.die("Unexpected network access"),
      hasListenerOnHost: () => Effect.die("Unexpected network access"),
      reserveLoopbackPort: () => Effect.die("Unexpected network access"),
      findAvailablePort: () => Effect.die("Unexpected network access"),
    }),
    Effect.provide(NodeCrypto.layer),
  );
});

describe("production device installation mappings", () => {
  it.effect.each([
    {
      operation: "hub",
      stderr: `npm error code ETARGET\nnpm error notarget No matching version found with a date before 10/9/2026.\n${unsafeDiagnostic}`,
    },
    { operation: "agent", stderr: `npm error code EACCES\n${unsafeDiagnostic}` },
    { operation: "agentCli", stderr: `npm error code E401\n${unsafeDiagnostic}` },
  ] as const)(
    "explains real toolchain failures for $operation without changing consent or lifecycle state",
    ({ operation, stderr }) =>
      Effect.gen(function* () {
        const result = {
          code: ChildProcessSpawner.ExitCode(1),
          stdout: "",
          stderr,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
        const invocations: string[] = [];
        const { service, settings } = yield* productionFixture((input) =>
          Effect.sync(() => {
            expect(input.command).toBe("npm");
            invocations.push(input.command);
            return result;
          }),
        );
        const beforeState = yield* service.state;
        const beforeSettings = yield* settings.getSettings;
        const install =
          operation === "agentCli"
            ? service.agentCli.pipe(Effect.asVoid)
            : service.updateTool(operation).pipe(Effect.asVoid);
        for (let attempt = 0; attempt < 2; attempt++) {
          const error = yield* install.pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "DeviceHostUnavailableError",
            hostId: LOCAL_DEVICE_HOST_ID,
            reason: installGuidance,
          });
          expect(error.message).toBe(`Device host local is unavailable: ${installGuidance}`);
          expect(error.message).not.toContain(unsafeDiagnostic);
          if (isHostUnavailable(error)) {
            expect(error.cause).toBeInstanceOf(DeviceToolchainInstallError);
            if (isToolchainInstallError(error.cause)) {
              expect(error.cause.tool).toBe(
                operation === "hub" ? "expo-device-hub" : "agent-device",
              );
              expect(error.cause.step).toBe("running npm install");
              expect(error.cause.exitCode).toBe(1);
              expect(error.cause.cause).toBe(result);
            }
          }
          expect(yield* service.state).toEqual(beforeState);
          expect(yield* settings.getSettings).toEqual(beforeSettings);
        }
        expect(invocations).toEqual(["npm", "npm"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves missing Node guidance for the production agent CLI", () =>
    Effect.gen(function* () {
      const { service } = yield* productionFixture(() => Effect.die("Unexpected npm install"));
      const error = yield* service.agentCli.pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "DeviceHostUnavailableError",
        reason:
          "Device automation requires Node.js. Install Node.js and make sure node is on PATH, then retry.",
      });
      if (isHostUnavailable(error)) {
        expect(error.cause).toBeInstanceOf(NodeRuntimeUnavailableError);
      }
    }).pipe(
      Effect.provideService(HostProcess.IsExecutable, true),
      Effect.provideService(HostProcess.ExecutablePath, "/missing/t3"),
      Effect.provideService(HostProcess.Environment, { PATH: "" }),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );
});

describe("device setup consent", () => {
  it.effect(
    "preserves missing-runtime guidance and causes through manual and agent readiness",
    () =>
      Effect.gen(function* () {
        const underlying = new Error("private lookup diagnostics");
        const runtimeFailure = new NodeRuntimeUnavailableError({
          feature: "Local device support",
          cause: underlying,
        });
        const { service, settings, requests } = yield* fixture(
          Effect.void,
          undefined,
          false,
          runtimeFailure,
        );
        yield* Ref.update(settings, (current) => ({
          ...current,
          enableDeviceSupport: true,
          enableAgentDeviceAccess: true,
        }));
        for (const readiness of [service.readiness(), service.agentReadinessIfSupported()]) {
          const error = yield* readiness.pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "DeviceHostUnavailableError",
            reason:
              "Local device support requires Node.js. Install Node.js and make sure node is on PATH, then retry.",
            cause: runtimeFailure,
          });
          expect(error.message).not.toContain(underlying.message);
        }
        expect((yield* service.state).hostStatuses[LOCAL_DEVICE_HOST_ID]).toMatchObject({
          status: "failed",
          detail:
            "Local device support requires Node.js. Install Node.js and make sure node is on PATH, then retry.",
        });
        expect(requests).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect("listing and provider startup do not start helpers before consent", () =>
    Effect.gen(function* () {
      const { service, starts, requests } = yield* fixture();
      expect((yield* service.list).hostStatus).toBe("disabled");
      expect(yield* service.readinessIfSupported()).toBeNull();
      const readiness = yield* service.readiness().pipe(Effect.result);
      expect(readiness._tag).toBe("Failure");
      expect(starts).toEqual([]);
      expect(requests).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "explicit setup discovers never-booted AVDs; disabling stops helpers and blocks agents",
    () =>
      Effect.gen(function* () {
        const { service, starts, settings } = yield* fixture();
        const state = yield* service.configure({ enabled: true });
        expect((yield* Ref.get(settings)).enableDeviceSupport).toBe(true);
        expect(state.devices.map((device) => [device.id, device.booted])).toEqual([
          ["Pixel_API_35", false],
        ]);
        expect(starts).toEqual(["start"]);
        const disabled = yield* service.configure({ enabled: false });
        expect(disabled.hostStatus).toBe("disabled");
        expect(disabled.devices).toEqual([]);
        expect((yield* Ref.get(settings)).enableDeviceSupport).toBe(false);
        expect(yield* service.readinessIfSupported()).toBeNull();
        expect(starts).toEqual(["start", "stop"]);
      }).pipe(Effect.scoped),
  );

  it.effect("boots a stopped Android AVD and uses its emulator serial without duplicating it", () =>
    Effect.gen(function* () {
      const { service, requests } = yield* fixture();
      yield* service.configure({ enabled: true });
      const session = yield* service.open({
        threadId: ThreadId.make("thread-1"),
        deviceId: "Pixel_API_35",
        platform: "android",
      });
      expect(session.deviceId).toBe("emulator-5554");
      expect(requests.filter((url) => url.endsWith("/boot"))).toHaveLength(1);
      const state = yield* service.state;
      expect(state.devices.map((device) => device.id)).toEqual(["emulator-5554"]);
      expect(state.bootingDevices).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("installs agent support only after the separate agent permission", () =>
    Effect.gen(function* () {
      const { service, agentStarts, agentStops, settings } = yield* fixture();
      yield* service.configure({ enabled: true });
      expect(agentStarts).toEqual([]);
      expect(yield* service.agentReadinessIfSupported()).toBeNull();

      yield* service.configure({ agentAccessEnabled: true });
      expect(agentStarts).toEqual(["start"]);
      expect((yield* Ref.get(settings)).enableAgentDeviceAccess).toBe(true);
      expect((yield* service.state).agentAccessEnabled).toBe(true);

      yield* service.configure({ agentAccessEnabled: false, onboardingCompleted: true });
      expect(agentStops).toEqual(["stop"]);
      expect((yield* service.state).onboardingCompleted).toBe(true);
      expect((yield* Ref.get(settings)).deviceOnboardingCompleted).toBe(true);
    }).pipe(Effect.scoped),
  );
});

it.effect("publishes boot progress and does not restore sessions after support is disabled", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const { service } = yield* fixture(
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
    );
    yield* service.configure({ enabled: true });
    const opening = yield* service
      .open({ threadId: ThreadId.make("thread-1"), deviceId: "Pixel_API_35", platform: "android" })
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(started);
    expect((yield* service.state).bootingDevices?.map((device) => device.name)).toEqual([
      "Pixel_API_35",
    ]);
    yield* service.configure({ enabled: false });
    yield* Deferred.succeed(finish, undefined);
    expect((yield* Fiber.join(opening))._tag).toBe("Failure");
    const state = yield* service.state;
    expect(state.hostStatus).toBe("disabled");
    expect(state.devices).toEqual([]);
    expect(state.sessions).toEqual([]);
    expect(state.bootingDevices).toEqual([]);
  }).pipe(Effect.scoped),
);

describe("device discovery after server restart", () => {
  it.effect("captures an explicit device before any client lists devices", () =>
    Effect.gen(function* () {
      const { service, settings, requests } = yield* fixture();
      yield* Ref.update(settings, (current) => ({ ...current, enableDeviceSupport: true }));
      expect((yield* service.state).devices).toEqual([]);
      const capture = yield* service.screenshot({ deviceId: DeviceId.make("Pixel_API_35") });
      expect(capture.device.id).toBe("Pixel_API_35");
      expect(Array.from(capture.png)).toEqual([137, 80, 78, 71]);
      expect(requests.some((url) => url.endsWith("/api/devices"))).toBe(true);
    }).pipe(Effect.scoped),
  );
});

it.effect.each([
  {
    diagnostic: "Insufficient disk space at /private/user/path",
    reason: "disk_space",
    message: "not enough free disk space",
  },
  {
    diagnostic: "Timed out spawning /private/user/command",
    reason: "timeout",
    message: "did not become ready in time",
  },
  {
    diagnostic: "Unexpected failure: secret-token",
    reason: "launch_failed",
    message: "could not start",
  },
] as const)("normalizes boot failure: $reason", ({ diagnostic, message }) =>
  Effect.gen(function* () {
    const { service } = yield* fixture(Effect.void, diagnostic);
    yield* service.configure({ enabled: true });
    const error = yield* service
      .open({
        threadId: ThreadId.make("boot-failure"),
        deviceId: "Pixel_API_35",
        platform: "android",
      })
      .pipe(Effect.flip);
    expect(error._tag).toBe("DeviceBootError");
    expect(error.message).toContain(message);
    expect(error.message).not.toContain(diagnostic);
    expect((yield* service.state).bootingDevices).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("keeps shutdown successful when subsequent discovery fails", () =>
  Effect.gen(function* () {
    const { service } = yield* fixture(Effect.void, undefined, true);
    yield* service.configure({ enabled: true });
    const threadId = ThreadId.make("shutdown-refresh");
    const session = yield* service.open({
      threadId,
      deviceId: "Pixel_API_35",
      platform: "android",
    });
    yield* service.close({ threadId, deviceId: session.deviceId, shutdown: true });
    const state = yield* service.state;
    expect(state.sessions).toEqual([]);
    expect(state.devices.find((device) => device.id === session.deviceId)?.booted).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect.each(["shutdown", "close"] as const)(
  "%s releases iOS capture so reopening uses a fresh session",
  (operation) =>
    Effect.gen(function* () {
      const deviceId = DeviceId.make("11111111-1111-1111-1111-111111111111");
      const threadId = ThreadId.make("capture-recovery");
      let booted = true;
      let capture: number | null = null;
      let generation = 0;
      const ready: DeviceHost.DeviceHostReady = {
        nodePath: process.execPath,
        hub: { origin: "http://device.test" },
        helpers: { serveSimAxSettings: null, serveSimCli: null },
        run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
      };
      const host: DeviceHost.DeviceHost["Service"] = {
        id: LOCAL_DEVICE_HOST_ID,
        summary: Effect.succeed({
          id: LOCAL_DEVICE_HOST_ID,
          kind: "local",
          label: "Simulator host",
          platforms: [{ platform: "ios", available: true }],
          hubInstalled: true,
          agentDeviceInstalled: false,
        }),
        platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
        ensureReady: () => Effect.succeed(ready),
        ensureAgentReady: () => Effect.die("Agent access is not used in this test"),
        current: Effect.succeed(ready),
        stopAgent: Effect.void,
        stop: Effect.void,
      };
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname;
          if (path === "/api/devices") {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                emulators: [],
                simulators: [
                  {
                    id: deviceId,
                    name: "iPhone",
                    platform: "ios",
                    version: "26",
                    physical: false,
                    booted,
                  },
                ],
              }),
            );
          }
          if (path === "/vendor/serve-sim/grid/api/start") capture ??= ++generation;
          else if (path === "/vendor/serve-sim/grid/api/shutdown") {
            if (request.body._tag !== "Uint8Array") throw new Error("Missing shutdown body");
            expect(decodeJson(new TextDecoder().decode(request.body.body))).toEqual({
              udid: deviceId,
            });
            capture = null;
            booted = false;
          } else if (path === "/api/devices/shutdown") {
            // This route powers off without releasing serve-sim's cached capture.
            booted = false;
          } else if (path === "/api/devices/boot") booted = true;
          else throw new Error(`Unexpected hub path: ${path}`);
          return HttpClientResponse.fromWeb(request, Response.json({ ok: true, id: deviceId }));
        }),
      );
      const service = yield* DeviceService.makeWithHosts(new Map([[host.id, host]])).pipe(
        Effect.provide(NodeCrypto.layer),
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const input = { threadId, deviceId, platform: "ios" as const };
      yield* service.open(input);
      expect(capture).toBe(1);
      if (operation === "shutdown") yield* service.shutdown(input);
      else yield* service.close({ threadId, deviceId, shutdown: true });
      expect(capture).toBeNull();
      expect((yield* service.state).sessions).toEqual([]);
      yield* service.open(input);
      expect(capture).toBe(2);
      expect((yield* service.state).sessions).toHaveLength(1);
    }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
);

it.effect.each([
  { hubReports: "off", outcome: "succeeds" },
  { hubReports: "booted", outcome: "fails" },
  { hubReports: "missing", outcome: "fails" },
] as const)(
  "iOS shutdown $outcome when serve-sim rejects it and the hub reports the simulator $hubReports",
  ({ hubReports, outcome }) =>
    Effect.gen(function* () {
      const deviceId = DeviceId.make("22222222-2222-2222-2222-222222222222");
      const paths: string[] = [];
      // The device list is stale until shutdown re-reads it from the hub.
      let listed: "booted" | "off" | "missing" = "booted";
      const ready: DeviceHost.DeviceHostReady = {
        nodePath: process.execPath,
        hub: { origin: "http://device.test" },
        helpers: { serveSimAxSettings: null, serveSimCli: null },
        run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
      };
      const host: DeviceHost.DeviceHost["Service"] = {
        id: LOCAL_DEVICE_HOST_ID,
        summary: Effect.succeed({
          id: LOCAL_DEVICE_HOST_ID,
          kind: "local",
          label: "Simulator host",
          platforms: [{ platform: "ios", available: true }],
          hubInstalled: true,
          agentDeviceInstalled: false,
        }),
        platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
        ensureReady: () => Effect.succeed(ready),
        ensureAgentReady: () => Effect.die("Agent access is not used in this test"),
        current: Effect.succeed(ready),
        stopAgent: Effect.void,
        stop: Effect.void,
      };
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname;
          paths.push(path);
          if (path === "/api/devices") {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                emulators: [],
                simulators:
                  listed === "missing"
                    ? []
                    : [
                        {
                          id: deviceId,
                          name: "iPhone",
                          platform: "ios",
                          version: "26",
                          physical: false,
                          booted: listed === "booted",
                        },
                      ],
                // A partial listing still decodes; it must not read as "off".
                errors: listed === "missing" ? [{ message: "simctl list failed" }] : [],
              }),
            );
          }
          if (path === "/vendor/serve-sim/grid/api/shutdown") {
            // serve-sim runs `simctl shutdown` bare and returns its failure as-is.
            listed = hubReports;
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                { ok: false, error: "Unable to shutdown device in current state: Shutdown" },
                { status: 500 },
              ),
            );
          }
          throw new Error(`Unexpected hub path: ${path}`);
        }),
      );
      const service = yield* DeviceService.makeWithHosts(new Map([[host.id, host]])).pipe(
        Effect.provide(NodeCrypto.layer),
        Effect.provideService(HttpClient.HttpClient, http),
      );
      yield* service.list;
      const exit = yield* Effect.exit(service.shutdown({ deviceId, platform: "ios" }));
      expect(paths.filter((path) => path.endsWith("shutdown"))).toEqual([
        "/vendor/serve-sim/grid/api/shutdown",
      ]);
      if (outcome === "succeeds") {
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(
          (yield* service.state).devices.find((device) => device.id === deviceId)?.booted,
        ).toBe(false);
      } else {
        expect(Exit.isFailure(exit)).toBe(true);
        expect(
          (yield* service.state).devices.find((device) => device.id === deviceId)?.booted,
        ).toBe(true);
      }
    }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
);

it.effect("retry keeps device and agent consent unchanged", () =>
  Effect.gen(function* () {
    const { service, starts, agentStarts } = yield* fixture();
    yield* service.retryHost(LOCAL_DEVICE_HOST_ID);
    expect(starts).toEqual([]);
    expect(agentStarts).toEqual([]);
    yield* service.configure({ enabled: true });
    yield* service.retryHost(LOCAL_DEVICE_HOST_ID);
    expect(agentStarts).toEqual([]);
    yield* service.configure({ agentAccessEnabled: true });
    const before = agentStarts.length;
    yield* service.retryHost(LOCAL_DEVICE_HOST_ID);
    expect(agentStarts.length).toBe(before + 1);
  }).pipe(Effect.scoped),
);

it.effect("publishes update detail for the correct host", () =>
  Effect.gen(function* () {
    const { service } = yield* fixture();
    const changes = yield* service.subscribe;
    yield* service.configure({ enabled: true });
    const states = yield* PubSub.takeAll(changes);
    expect(
      states.some(
        (state) => state.hostStatuses.local?.detail === "Updating device hub from 0.9.0 to 0.10.1…",
      ),
    ).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect("host retry exposes actionable failure without internal IDs or diagnostics", () =>
  Effect.gen(function* () {
    const { service, settings } = yield* fixture(
      Effect.void,
      undefined,
      false,
      new DeviceHost.DeviceHostError({
        hostId: LOCAL_DEVICE_HOST_ID,
        step: "probe",
        cause: "private diagnostics",
      }),
    );
    yield* Ref.update(settings, (current) => ({ ...current, enableDeviceSupport: true }));
    const state = yield* service.retryHost(LOCAL_DEVICE_HOST_ID);
    expect(state.supportsHostRetry).toBe(true);
    expect(state.hostStatuses[LOCAL_DEVICE_HOST_ID]).toEqual({
      status: "failed",
      detail: "Could not connect to this host over SSH.",
    });
  }).pipe(Effect.scoped),
);

it.effect("version discovery does not grant consent or start device tools", () =>
  Effect.gen(function* () {
    const { service, starts, agentStarts, requests } = yield* fixture();
    const state = yield* service.inspect;
    expect(state.supportsToolInspection).toBe(true);
    expect(state.hostStatus).toBe("disabled");
    expect(state.hosts).toHaveLength(1);
    expect(starts).toEqual([]);
    expect(agentStarts).toEqual([]);
    expect(requests).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("failed read-only discovery preserves lifecycle status and installed inventory", () =>
  Effect.gen(function* () {
    const { service, starts } = yield* fixture(Effect.void, undefined, false, undefined, true);
    const state = yield* service.inspect;
    expect(state.supportsToolInspection).toBe(true);
    expect(state.hostStatus).toBe("disabled");
    expect(state.hosts[0]?.hubInstalled).toBe(true);
    expect(state.hosts[0]?.toolInspectionError).toContain("Reconnect the host");
    expect(starts).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect(
  "manual updates install only the selected tool without enabling access or starting helpers",
  () =>
    Effect.gen(function* () {
      const installed: string[] = [];
      const { service, starts, agentStarts, requests } = yield* fixture(
        Effect.void,
        undefined,
        false,
        undefined,
        false,
        (tool) =>
          Effect.sync(() => {
            installed.push(tool);
          }),
      );
      const before = yield* service.state;
      const state = yield* service.updateTool("agent");
      expect(installed).toEqual(["agent"]);
      expect(state.supportsToolUpdate).toBe(true);
      expect(state.hostStatus).toBe(before.hostStatus);
      expect(state.agentAccessEnabled).toBe(before.agentAccessEnabled);
      expect(state.revision).toBeGreaterThan(before.revision);
      expect(starts).toEqual([]);
      expect(agentStarts).toEqual([]);
      expect(requests).toEqual([]);
      yield* service.updateTool("hub");
      expect(installed).toEqual(["agent", "hub"]);
    }).pipe(Effect.scoped),
);

it.effect("failed manual installation leaves lifecycle state unchanged and can be retried", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const { service, starts, agentStarts } = yield* fixture(
      Effect.void,
      undefined,
      false,
      undefined,
      false,
      () =>
        Effect.suspend(() =>
          ++attempts === 1
            ? Effect.fail(
                new DeviceOperationError({
                  operation: "update device tool",
                  reason: "command_failed",
                  cause: new Error("offline"),
                }),
              )
            : Effect.void,
        ),
    );
    const before = yield* service.state;
    const result = yield* service.updateTool("agent").pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(yield* service.state).toEqual(before);
    yield* service.updateTool("agent");
    expect(attempts).toBe(2);
    expect(starts).toEqual([]);
    expect(agentStarts).toEqual([]);
  }).pipe(Effect.scoped),
);

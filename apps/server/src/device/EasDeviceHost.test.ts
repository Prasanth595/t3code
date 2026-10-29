import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { EasDeviceHostConfig } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as EasDeviceHost from "./EasDeviceHost.ts";

const APP_ID = "d763fcb8-d37c-41ea-a773-b54a0ab4a454";

const config = (overrides: Partial<EasDeviceHostConfig> = {}): EasDeviceHostConfig => ({
  kind: "eas",
  id: "eas",
  label: "EAS Simulator",
  appId: APP_ID,
  accessToken: "expo-token",
  maxSessionMinutes: 25,
  idleMinutes: 5,
  maxConcurrentSessions: 2,
  ...overrides,
});

interface Gate {
  readonly requested: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}
const makeGate = Effect.all({
  requested: Deferred.make<void>(),
  release: Deferred.make<void>(),
});

/** Expo's API and one session's preview host, recording what was asked of them. */
const fakeExpo = (
  options: {
    readonly status?: () => string;
    readonly failCreate?: boolean;
    /** Expo answers the create with GraphQL errors: a refusal. */
    readonly rejectCreate?: boolean;
    readonly failStop?: () => boolean;
    readonly failList?: () => boolean;
    readonly active?: ReadonlyArray<{ id: string; status: string; name: string }>;
    readonly previewGate?: Gate;
    readonly createGate?: Gate;
    /** Holds the first session read it answers with a gate. */
    readonly sessionGate?: () => Gate | undefined;
    readonly activeIncludesCreated?: boolean;
    readonly failPreview?: boolean;
    readonly androidDiscovery?: unknown;
    readonly omitCreatedFromActive?: boolean;
  } = {},
) => {
  const calls: Array<{ operation: string; variables: Record<string, unknown> }> = [];
  const previews: string[] = [];
  let created = 0;
  let createdName = "";
  let previewFails = options.failPreview ?? false;
  let createFails = options.failCreate ?? false;
  let sessionGated = false;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const url = new URL(request.url);
      if (/^https:\/\/preview(?:-\d+)?\.test$/.test(url.origin)) {
        previews.push(request.url);
        const index = /preview-(\d+)/.exec(url.hostname)?.[1];
        expect(request.headers.authorization).toBe(
          `Bearer preview-token${index ? `-${index}` : ""}`,
        );
        if (options.previewGate) {
          yield* Deferred.succeed(options.previewGate.requested, undefined);
          yield* Deferred.await(options.previewGate.release);
        }
        if (previewFails) {
          return HttpClientResponse.fromWeb(request, new Response("bad gateway", { status: 502 }));
        }
        const body =
          url.pathname === "/api"
            ? { device: "UDID-1" }
            : url.pathname === "/vendor/serve-emu/api"
              ? (options.androidDiscovery ?? { ok: true, serial: "emulator-5554", devices: [] })
              : null;
        return HttpClientResponse.fromWeb(
          request,
          url.pathname.endsWith("/screenshot")
            ? new Response(Uint8Array.of(137, 80, 78, 71), {
                headers: { "content-type": "image/png" },
              })
            : Response.json(body),
        );
      }
      const body =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as {
              query: string;
              variables: Record<string, { name?: string } & Record<string, unknown>>;
            })
          : { query: "", variables: {} };
      expect(request.headers.authorization).toBe("Bearer expo-token");
      const operation = /(?:query|mutation) (\w+)/.exec(body.query)?.[1] ?? "unknown";
      calls.push({ operation, variables: body.variables });
      if (operation === "T3CreateEasSimulatorSession") {
        createdName = body.variables.input?.name ?? "";
        if (options.createGate) {
          yield* Deferred.succeed(options.createGate.requested, undefined);
          yield* Deferred.await(options.createGate.release);
        }
        if (createFails)
          return HttpClientResponse.fromWeb(request, new Response("bad gateway", { status: 502 }));
        if (options.rejectCreate)
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ errors: [{ message: "Not allowed" }] }),
          );
      }
      if (operation === "T3StopEasSimulatorSession" && options.failStop?.()) {
        return HttpClientResponse.fromWeb(request, new Response("bad gateway", { status: 502 }));
      }
      if (operation === "T3ActiveEasSimulatorSessions" && options.failList?.()) {
        return HttpClientResponse.fromWeb(request, new Response("bad gateway", { status: 502 }));
      }
      const sessionGate =
        operation === "T3EasSimulatorSession" ? options.sessionGate?.() : undefined;
      if (sessionGate && !sessionGated) {
        sessionGated = true;
        yield* Deferred.succeed(sessionGate.requested, undefined);
        yield* Deferred.await(sessionGate.release);
      }
      const data =
        operation === "T3EasSimulatorAvailability"
          ? {
              app: {
                byId: {
                  ownerAccount: {
                    name: "pingdotgg",
                    accountFeatureGates: { "device-run-sessions": true },
                  },
                },
              },
            }
          : operation === "T3CreateEasSimulatorSession"
            ? { deviceRunSession: { createDeviceRunSession: { id: `session-${++created}` } } }
            : operation === "T3ActiveEasSimulatorSessions"
              ? {
                  app: {
                    byId: {
                      deviceRunSessionsPaginated: {
                        edges: [
                          ...(options.omitCreatedFromActive
                            ? []
                            : [{ node: { id: "orphan", status: "NEW", name: createdName } }]),
                          {
                            node: {
                              id: "someone-else",
                              status: "IN_PROGRESS",
                              name: "T3 Code · EAS Simulator · 000000",
                            },
                          },
                          ...(options.active ?? []).map((node) => ({ node })),
                          ...(options.activeIncludesCreated && created > 0
                            ? [
                                {
                                  node: {
                                    id: `session-${created}`,
                                    status: "STARTING",
                                    name: createdName,
                                  },
                                },
                              ]
                            : []),
                        ],
                      },
                    },
                  },
                }
              : operation === "T3EasSimulatorSession"
                ? {
                    deviceRunSessions: {
                      byId: {
                        id: body.variables.id,
                        status: options.status?.() ?? "IN_PROGRESS",
                        remoteConfig: {
                          __typename: "AgentDeviceRunSessionRemoteConfig",
                          agentDeviceRemoteSessionUrl: "https://agent.test",
                          agentDeviceRemoteSessionToken: "agent-token",
                          webPreviewToken:
                            String(body.variables.id) === "session-1"
                              ? "preview-token"
                              : `preview-token-${String(body.variables.id).split("-")[1]}`,
                          previewApiUrl:
                            String(body.variables.id) === "session-1"
                              ? "https://preview.test?token=preview-token"
                              : `https://preview-${String(body.variables.id).split("-")[1]}.test`,
                        },
                      },
                    },
                  }
                : {
                    deviceRunSession: {
                      ensureDeviceRunSessionStopped: { id: body.variables.id, status: "STOPPED" },
                    },
                  };
      return HttpClientResponse.fromWeb(request, Response.json({ data }));
    }),
  );
  const named = (operation: string) => calls.filter((call) => call.operation === operation);
  const stopped = () => named("T3StopEasSimulatorSession").map((call) => call.variables.id);
  const allowPreview = () => {
    previewFails = false;
  };
  const allowCreate = () => {
    createFails = false;
  };
  return { http, named, stopped, allowPreview, allowCreate, previews };
};

const layer = Layer.mergeAll(
  ProcessRunner.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-eas-host-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const makeHost = (
  expo: ReturnType<typeof fakeExpo>,
  hostConfig: EasDeviceHostConfig,
  scope: Scope.Scope,
) =>
  EasDeviceHost.make(hostConfig).pipe(
    Effect.provideService(HttpClient.HttpClient, expo.http),
    Effect.provideService(Scope.Scope, scope),
  );

describe("EAS Simulator host", () => {
  it.effect.each(["ios", "android"] as const)(
    "starts a bounded %s session and routes its stream and agent to that session",
    (platform) =>
      Effect.gen(function* () {
        const expo = fakeExpo();
        const scope = yield* Scope.make();
        const host = yield* makeHost(expo, config(), scope);
        const ready = yield* host.ensureReady(() => Effect.void);
        const catalog = (yield* ready.devices.list).devices;
        expect(catalog.map((device) => [device.id, device.booted])).toEqual([
          ["eas-ios", false],
          ["eas-android", false],
        ]);
        expect(yield* host.platformAvailability(platform)).toMatchObject({
          platform,
          available: true,
        });
        expect(
          yield* ready.devices.boot(catalog.find((device) => device.platform === platform)!),
        ).toBe("session-1");
        expect(expo.named("T3CreateEasSimulatorSession")[0]?.variables.input).toMatchObject({
          appId: APP_ID,
          platform: platform.toUpperCase(),
          type: "AGENT_DEVICE",
          maxRunTimeMinutes: 25,
          maxIdleTimeMinutes: 5,
        });
        const running = (yield* ready.devices.list).devices.find(
          (device) => device.id === "session-1",
        )!;
        expect(running).toMatchObject({
          booted: true,
          platform,
          name: platform === "ios" ? "iPhone (EAS Simulator)" : "Android (EAS Simulator)",
        });
        const remote = platform === "ios" ? "UDID-1" : "emulator-5554";
        expect(yield* ready.devices.agentEndpoint!("session-1")).toEqual({
          baseUrl: "https://agent.test",
          token: "agent-token",
          agentDeviceId: remote,
        });
        const vendor = platform === "ios" ? "serve-sim" : "serve-emu";
        const route = platform === "ios" ? "/helper/session-1/webrtc/offer" : "/webrtc/offer";
        expect(
          yield* ready.upstream!(
            `/vendor/${vendor}${route}`,
            new URLSearchParams("device=session-1"),
          ),
        ).toEqual({
          url: `https://preview.test${platform === "ios" ? "/helper/UDID-1" : "/vendor/serve-emu"}/webrtc/offer?device=${remote}`,
          headers: { authorization: "Bearer preview-token" },
          protocols: [`${vendor}.token.preview-token`],
        });
        expect(Array.from(yield* ready.devices.screenshot(running))).toEqual([137, 80, 78, 71]);
        expect(expo.previews).toEqual([
          `https://preview.test${platform === "ios" ? "/api" : "/vendor/serve-emu/api"}`,
          `https://preview.test${platform === "ios" ? "" : "/vendor/serve-emu"}/api/screenshot?device=${remote}`,
        ]);
        expect(
          yield* ready.upstream!("/vendor/serve-sim/helper/%E0/config", new URLSearchParams()),
        ).toBeNull();
        yield* Scope.close(scope, Exit.void);
        expect(expo.stopped()).toEqual(["session-1"]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("refuses to start past its session limit", () =>
    Effect.gen(function* () {
      const expo = fakeExpo();
      const host = yield* makeHost(expo, config({ maxConcurrentSessions: 1 }), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      yield* ready.devices.boot(catalogDevice!);
      const refused = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(refused.message).toBe(
        "EAS Simulator is unavailable: EAS Simulator is limited to 1 running session. Close one in the Device panel first.",
      );
      expect(expo.named("T3CreateEasSimulatorSession")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("isolates iOS and Android sessions even when remote device IDs collide", () =>
    Effect.gen(function* () {
      const expo = fakeExpo();
      const scope = yield* Scope.make();
      const host = yield* makeHost(expo, config({ maxConcurrentSessions: 3 }), scope);
      const ready = yield* host.ensureReady(() => Effect.void);
      const catalog = (yield* ready.devices.list).devices;
      const ios = catalog.find((device) => device.platform === "ios")!;
      const android = catalog.find((device) => device.platform === "android")!;
      expect(yield* ready.devices.boot(ios)).toBe("session-1");
      expect(yield* ready.devices.boot(android)).toBe("session-2");
      expect(yield* ready.devices.boot(android)).toBe("session-3");
      for (const index of [2, 3]) {
        for (const route of ["/api", "/ws", "/webrtc/offer", "/webrtc/close", "/api/screenshot"]) {
          expect(
            yield* ready.upstream!(
              `/vendor/serve-emu${route}`,
              new URLSearchParams(`device=session-${index}`),
            ),
          ).toEqual({
            url: `https://preview-${index}.test/vendor/serve-emu${route}?device=emulator-5554`,
            headers: { authorization: `Bearer preview-token-${index}` },
            protocols: [`serve-emu.token.preview-token-${index}`],
          });
        }
      }
      for (const [route, query] of [
        ["/vendor/serve-emu/api", ""],
        ["/vendor/serve-emu/api", "device=unknown"],
        ["/vendor/serve-emu/api", "device=session-1"],
        ["/vendor/serve-sim/api", "device=session-2"],
        ["/vendor/serve-emu/api", "device=session-2&device=session-3"],
        ["/vendor/serve-sim/helper/session-1/config", "device=session-2"],
        ["/vendor/serve-sim/helper/%E0/config", "device=session-1"],
      ])
        expect(yield* ready.upstream!(route!, new URLSearchParams(query))).toBeNull();
      expect(
        yield* ready.upstream!("/vendor/serve-sim/api", new URLSearchParams("device=session-1")),
      ).toMatchObject({ url: "https://preview.test/api?device=UDID-1" });
      expect(yield* ready.upstream!("/vendor/serve-sim/api", new URLSearchParams())).toMatchObject({
        url: "https://preview.test/api",
      });
      yield* ready.devices.shutdown({ id: "session-2", platform: "android" });
      expect(expo.stopped()).toEqual(["session-2"]);
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toEqual([
        "eas-ios",
        "eas-android",
        "session-1",
        "session-3",
      ]);
      yield* Scope.close(scope, Exit.void);
      expect(expo.stopped()).toEqual(["session-2", "session-1", "session-3"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect.each([{ serial: "" }, { currentSerial: "emulator-5554" }, { serial: 42 }])(
    "stops a billed Android session when device discovery is invalid (%j)",
    (androidDiscovery) =>
      Effect.gen(function* () {
        const gate = yield* makeGate;
        const expo = fakeExpo({ androidDiscovery, previewGate: gate });
        const scope = yield* Scope.make();
        const host = yield* makeHost(expo, config(), scope);
        const ready = yield* host.ensureReady(() => Effect.void);
        const boot = ready.devices
          .boot({
            id: "eas-android",
            platform: "android",
            name: "Android",
            version: "Cloud",
            booted: false,
            physical: false,
          })
          .pipe(Effect.flip, Effect.forkChild);
        const fiber = yield* boot;
        yield* Deferred.await(gate.requested);
        yield* Deferred.succeed(gate.release, undefined);
        yield* TestClock.adjust("10 seconds");
        const failure = yield* Fiber.join(fiber);
        expect(failure._tag).toBe("DeviceBootError");
        expect(expo.stopped()).toEqual(["session-1"]);
        yield* Scope.close(scope, Exit.void);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "keeps a refused create's record for the reaper without counting it after a restart",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const server = yield* ServerConfig.ServerConfig;
        const ledger = path.join(server.stateDir, "device", "eas", "eas.json");
        // Expo refuses the create and lists nothing.
        const expo = fakeExpo({ rejectCreate: true, omitCreatedFromActive: true });
        const first = yield* Scope.make();
        const host = yield* makeHost(expo, config({ maxConcurrentSessions: 1 }), first);
        const ready = yield* host.ensureReady(() => Effect.void);
        const [catalogDevice] = (yield* ready.devices.list).devices;
        yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
        const entries = JSON.parse(yield* fs.readFileString(ledger)) as Array<{
          refused?: boolean;
        }>;
        expect(entries.map((entry) => entry.refused)).toEqual([true]);
        yield* Scope.close(first, Exit.void);
        // A later server cannot even list the app: the record must not hold a slot.
        const later = fakeExpo({ failList: () => true });
        const restarted = yield* makeHost(
          later,
          config({ maxConcurrentSessions: 1 }),
          yield* Scope.make(),
        );
        const readyAgain = yield* restarted.ensureReady(() => Effect.void);
        const [device] = (yield* readyAgain.devices.list).devices;
        expect(yield* readyAgain.devices.boot(device!)).toBe("session-1");
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "does not sweep a replacement's session from a listing in flight when its scope closes",
    () =>
      Effect.gen(function* () {
        const gate = yield* makeGate;
        let armed = false;
        const expo = fakeExpo({ sessionGate: () => (armed ? gate : undefined) });
        const first = yield* Scope.make();
        const old = yield* makeHost(expo, config(), first);
        const oldReady = yield* old.ensureReady(() => Effect.void);
        const [catalogDevice] = (yield* oldReady.devices.list).devices;
        expect(yield* oldReady.devices.boot(catalogDevice!)).toBe("session-1");
        // Long enough that the listing reads the session's status and a sweep is due.
        yield* TestClock.adjust("2 minutes");
        armed = true;
        const listing = yield* oldReady.devices.list.pipe(Effect.forkChild);
        yield* Deferred.await(gate.requested);
        // Settings saved while the old listing waits on Expo.
        yield* Scope.close(first, Exit.void);
        const replacement = yield* makeHost(expo, config(), yield* Scope.make());
        const ready = yield* replacement.ensureReady(() => Effect.void);
        const [device] = (yield* ready.devices.list).devices;
        expect(yield* ready.devices.boot(device!)).toBe("session-2");
        yield* Deferred.succeed(gate.release, undefined);
        yield* Fiber.join(listing);
        expect(expo.stopped()).toEqual(["session-1"]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("stops the session a refused create made anyway", () =>
    Effect.gen(function* () {
      // Expo refuses the create but lists a session by its name.
      const expo = fakeExpo({ rejectCreate: true });
      const host = yield* makeHost(expo, config({ maxConcurrentSessions: 1 }), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      const failure = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(failure.message).toContain("Not allowed");
      expect(expo.stopped()).toEqual(["orphan"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("records a session before creating it and refuses to start without the record", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const server = yield* ServerConfig.ServerConfig;
      // A directory where the ledger file should be: it can be neither read nor written.
      yield* fs.makeDirectory(path.join(server.stateDir, "device", "eas", "eas.json"), {
        recursive: true,
      });
      const expo = fakeExpo();
      const host = yield* makeHost(expo, config(), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      const failure = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(failure.message).toContain("could not be read");
      expect(expo.named("T3CreateEasSimulatorSession")).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("keeps a session it could not stop counted, listed, and retried", () =>
    Effect.gen(function* () {
      let stopFails = true;
      const expo = fakeExpo({ failStop: () => stopFails });
      const host = yield* makeHost(expo, config({ maxConcurrentSessions: 1 }), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      yield* ready.devices.boot(catalogDevice!);
      yield* ready.devices.shutdown({ id: "session-1", platform: "ios" }).pipe(Effect.flip);
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toContain("session-1");
      const refused = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(refused.message).toContain("limited to 1 running session");
      stopFails = false;
      yield* ready.devices.list;
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toEqual([
        "eas-ios",
        "eas-android",
      ]);
      expect(expo.stopped().filter((id) => id === "session-1").length).toBeGreaterThanOrEqual(2);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("lets go of a stopping session Expo has ended although its stop keeps failing", () =>
    Effect.gen(function* () {
      let status = "IN_PROGRESS";
      const expo = fakeExpo({ failStop: () => true, status: () => status });
      const host = yield* makeHost(expo, config({ maxConcurrentSessions: 1 }), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      yield* ready.devices.boot(catalogDevice!);
      yield* ready.devices.shutdown({ id: "session-1", platform: "ios" }).pipe(Effect.flip);
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toContain("session-1");
      // Expo ended it by itself: the stop keeps failing, but the status says so.
      status = "STOPPED";
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toEqual([
        "eas-ios",
        "eas-android",
      ]);
      status = "IN_PROGRESS";
      expect(yield* ready.devices.boot(catalogDevice!)).toBe("session-2");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("asks for an EAS project before starting anything when none can be found", () =>
    Effect.gen(function* () {
      const expo = fakeExpo();
      const host = yield* makeHost(expo, config({ appId: undefined }), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      const failure = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(failure.message).toContain("Choose one for this host in Settings");
      expect(expo.named("T3CreateEasSimulatorSession")).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("reports both platforms unavailable on a server with no Expo credential", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-expo-home-" });
      const host = yield* makeHost(
        fakeExpo(),
        config({ accessToken: "" }),
        yield* Scope.make(),
      ).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Environment, {}),
      );
      const platforms = (yield* host.summary).platforms;
      expect(platforms).toMatchObject([
        { platform: "ios", available: false },
        { platform: "android", available: false },
      ]);
      for (const platform of platforms)
        expect(platform.reason).toContain("No Expo credential on the server");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("stops a session that is still starting when the host stops", () =>
    Effect.gen(function* () {
      const previewGate = yield* makeGate;
      const expo = fakeExpo({ previewGate });
      const host = yield* makeHost(expo, config(), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      const booting = yield* ready.devices.boot(catalogDevice!).pipe(Effect.forkChild);
      yield* Deferred.await(previewGate.requested);
      // Never released: stopping must not wait for the session to become ready.
      yield* host.stop;
      expect(expo.stopped()).toEqual(["session-1"]);
      const failure = yield* Fiber.join(booting).pipe(Effect.flip);
      expect(failure.message).toContain("was stopped while the session started");
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toEqual([
        "eas-ios",
        "eas-android",
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  LOCAL_DEVICE_HOST_ID,
  type ServerSettings as Settings,
  type SshDeviceHostConfig,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as DeviceService from "./DeviceService.ts";

it.effect(
  "reconciles settings without publishing no-ops and clears removed or replaced host state",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-reconcile-" });
      const settings = yield* ServerSettings.ServerSettingsService;
      const changes = yield* Queue.unbounded<{ value: Settings; done: Deferred.Deferred<void> }>();
      // Acknowledge only after the downstream reconciliation consumed this settings value.
      const stream = Stream.fromQueue(changes).pipe(
        Stream.flatMap(({ value, done }) =>
          Stream.make(value).pipe(
            Stream.concat(Stream.fromEffect(Deferred.succeed(done, undefined)).pipe(Stream.drain)),
          ),
        ),
      );
      const removedFiles: string[] = [];
      let localSummaryReads = 0;
      const localHost: DeviceHost.DeviceHost["Service"] = {
        id: LOCAL_DEVICE_HOST_ID,
        summary: Effect.sync(() => {
          localSummaryReads++;
          return {
            id: LOCAL_DEVICE_HOST_ID,
            label: "Local",
            kind: "local" as const,
            platforms: [],
            hubInstalled: false,
            agentDeviceInstalled: false,
          };
        }),
        platformAvailability: (platform) => Effect.succeed({ platform, available: false }),
        current: Effect.succeed(null),
        ensureReady: () => Effect.die("Unexpected device launch"),
        ensureAgentReady: () => Effect.die("Unexpected agent launch"),
        stop: Effect.void,
        stopAgent: Effect.void,
      };
      const service = yield* DeviceService.make.pipe(
        Effect.provideService(DeviceHost.DeviceHost, localHost),
        Effect.provideService(ServerSettings.ServerSettingsService, {
          ...settings,
          subscribeChanges: Effect.succeed(stream),
        }),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            remove: (file) =>
              Effect.sync(() => {
                removedFiles.push(file);
              }),
          }),
        ),
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () => Effect.die("Unexpected helper launch"),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected HTTP request")),
        ),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            if (command._tag !== "StandardCommand") return Effect.die("Unexpected pipeline");
            expect(command.args).toContain("-G");
            return Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(123),
                stdout: Stream.make(new TextEncoder().encode("hostname 192.0.2.1\nport 22\n")),
                stderr: Stream.empty,
                all: Stream.empty,
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                stdin: Sink.drain,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
                unref: Effect.succeed(Effect.void),
              }),
            );
          }),
        ),
        Effect.provide(Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NetService.layer)),
      );
      const update = Effect.fnUntraced(function* (deviceHosts: ReadonlyArray<SshDeviceHostConfig>) {
        const value = yield* settings.updateSettings({ deviceHosts: [...deviceHosts] });
        const done = yield* Deferred.make<void>();
        yield* Queue.offer(changes, { value, done });
        yield* Deferred.await(done);
        return yield* service.state;
      });
      const initial = yield* service.state;
      expect(initial.revision).toBe(0);
      const reads = localSummaryReads;
      expect(yield* update([])).toEqual(initial);
      expect(localSummaryReads).toBe(reads);

      const host: SshDeviceHostConfig = { id: "remote", label: "Remote", target: "remote-fixture" };
      const added = yield* update([host]);
      expect(added.hosts.map((entry) => entry.id)).toEqual([LOCAL_DEVICE_HOST_ID, host.id]);
      expect(added.revision).toBe(initial.revision + 1);
      expect(yield* update([{ ...host }])).toEqual(added);
      expect(removedFiles).toEqual([]);

      yield* service.setHostStatus(host.id, { status: "failed", detail: "stale status" });
      const beforeReplacement = yield* service.state;
      const replaced = yield* update([{ ...host, label: "Replacement", port: 2222 }]);
      expect(replaced.hosts.find((entry) => entry.id === host.id)?.label).toBe("Replacement");
      expect(replaced.hostStatuses[host.id]).toBeUndefined();
      expect(replaced.revision).toBe(beforeReplacement.revision + 2);
      expect(removedFiles).toHaveLength(1);

      yield* service.setHostStatus(host.id, { status: "failed", detail: "remove me" });
      const beforeRemoval = yield* service.state;
      const removed = yield* update([]);
      expect(removed.hosts.map((entry) => entry.id)).toEqual([LOCAL_DEVICE_HOST_ID]);
      expect(removed.hostStatuses[host.id]).toBeUndefined();
      expect(removed.revision).toBe(beforeRemoval.revision + 1);
      expect(removedFiles).toHaveLength(2);
      expect(yield* update([])).toEqual(removed);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(ServerSettings.layerTest(), NodeServices.layer)),
    ),
);

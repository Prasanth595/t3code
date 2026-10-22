import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { makeGhProcess } from "./gitHubCliProcess.ts";

function spawnedBusAddress(input: {
  readonly platform?: NodeJS.Platform;
  readonly address?: string;
  readonly files?: ReadonlyArray<string>;
  readonly unreadable?: boolean;
}) {
  const envs: Array<NodeJS.ProcessEnv | undefined> = [];
  const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = (spawn) =>
    Effect.sync(() => {
      envs.push(spawn.env);
      return {
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    });
  return Effect.gen(function* () {
    const gh = yield* makeGhProcess;
    yield* gh.run({ operation: "test", command: "gh", args: ["auth", "status"], cwd: "/" });
    return envs[0]?.DBUS_SESSION_BUS_ADDRESS;
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        TestSourceControlHost.layer({ process: { run } }),
        FileSystem.layerNoop({
          exists: (path) =>
            input.unreadable
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "exists",
                    pathOrDescriptor: path,
                  }),
                )
              : Effect.succeed((input.files ?? []).includes(path)),
        }),
      ),
    ),
    Effect.provideService(HostProcess.Platform, input.platform ?? "linux"),
    Effect.provideService(HostProcess.UserId, 1000),
    Effect.provideService(
      HostProcess.Environment,
      input.address === undefined ? {} : { DBUS_SESSION_BUS_ADDRESS: input.address },
    ),
  );
}

describe("makeGhProcess", () => {
  it.effect("turns the bus off when godbus would have to autolaunch one", () =>
    Effect.gen(function* () {
      expect(yield* spawnedBusAddress({})).toBe("disabled:");
      expect(yield* spawnedBusAddress({ address: "autolaunch:" })).toBe("disabled:");
    }),
  );

  it.effect("leaves a bus godbus can find or was given", () =>
    Effect.gen(function* () {
      expect(yield* spawnedBusAddress({ files: ["/run/user/1000/bus"] })).toBeUndefined();
      expect(yield* spawnedBusAddress({ files: ["/run/user/1000/dbus-session"] })).toBeUndefined();
      expect(yield* spawnedBusAddress({ address: "unix:path=/tmp/bus" })).toBeUndefined();
      expect(yield* spawnedBusAddress({ platform: "darwin" })).toBeUndefined();
      // godbus counts a bus it cannot stat as present, so an unreadable one is left alone too.
      expect(yield* spawnedBusAddress({ unreadable: true })).toBeUndefined();
    }),
  );
});

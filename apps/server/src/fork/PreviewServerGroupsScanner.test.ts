import { it } from "@effect/vitest";
import type { DiscoveredLocalServer } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import { expect } from "vite-plus/test";

import * as PortScanner from "../preview/PortScanner.ts";
import * as ProcessRunner from "../processRunner.ts";
import { PreviewServerGroups } from "./PreviewServerGroups.ts";

const PORT = 5177;

// Upstream skips the listener scan when no terminal and no configured URL exist.
// The groups list every listener, so an active list keeps the scan running.
it.effect.each(["linux", "darwin", "win32"] as const)(
  "scans listeners without terminals while the server groups are active on %s",
  (platform) => {
    let processCalls = 0;
    const observed: Array<ReadonlyArray<DiscoveredLocalServer>> = [];
    const layer = PortScanner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({}),
          Layer.succeed(HostProcess.Platform, platform),
          Layer.succeed(PreviewServerGroups, {
            active: Effect.succeed(true),
            observe: (scan) => Effect.sync(() => observed.push(scan.listeners)),
            listeners: Stream.empty,
          }),
          Layer.succeed(ProcessRunner.ProcessRunner, {
            run: () => {
              processCalls += 1;
              return Effect.succeed({
                stdout: `p1234\ncnode\nn*:${PORT}\n`,
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              });
            },
          }),
          FetchHttpClient.layer.pipe(
            Layer.provide(
              Layer.succeed(FetchHttpClient.Fetch, () =>
                Promise.resolve(
                  new Response("hello", { headers: { "content-type": "text/html" } }),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.scan();
      expect(processCalls).toBeGreaterThan(0);
      if (platform !== "win32") {
        expect(observed.flat()).toMatchObject([{ port: PORT, pid: 1234 }]);
      }
    }).pipe(Effect.provide(layer));
  },
);

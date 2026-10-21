import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopServerOwnership from "./DesktopServerOwnership.ts";

const makeRecord = (overrides?: {
  readonly pid?: number;
  readonly port?: number;
  readonly origin?: string;
  readonly serviceManaged?: boolean;
}): DesktopServerOwnership.DesktopServerRuntimeRecord => ({
  version: 1,
  pid: overrides?.pid ?? process.pid,
  port: overrides?.port ?? 3773,
  origin: overrides?.origin ?? "http://127.0.0.1:3773",
  startedAt: "1970-01-01T00:00:00.000Z",
  ...(overrides?.serviceManaged === undefined ? {} : { serviceManaged: overrides.serviceManaged }),
});

interface HarnessOptions {
  readonly record?: DesktopServerOwnership.DesktopServerRuntimeRecord | null;
  readonly descriptorStatus?: number;
  readonly baseDir: string;
}

const makeHarness = (options: HarnessOptions) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const stateDir = `${options.baseDir}/userdata`;
    const recordPath = `${stateDir}/server-runtime.json`;

    yield* fileSystem.makeDirectory(stateDir, { recursive: true });
    if (options.record) {
      yield* fileSystem.writeFileString(recordPath, JSON.stringify(options.record));
    } else {
      yield* fileSystem.remove(recordPath, { force: true });
    }

    const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
      baseDir: options.baseDir,
      path: { join: (...segments: ReadonlyArray<string>) => segments.join("/") },
    } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

    const layerHttpClient = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(null, { status: options.descriptorStatus ?? 200 }),
          ),
        ),
      ),
    );

    const ownership = yield* DesktopServerOwnership.make.pipe(
      Effect.provide(Layer.mergeAll(layerEnvironment, layerHttpClient)),
    );

    return { ownership, recordPath, stateDir };
  });

describe("DesktopServerOwnership", () => {
  it.effect("reports no owner when the T3 home has no runtime record", () =>
    Effect.gen(function* () {
      const { ownership } = yield* makeHarness({ baseDir: "/tmp/t3-ownership-empty" });
      const owner = yield* ownership.inspect;
      assert.equal(owner._tag, "none");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports no owner when the recorded server is gone", () =>
    Effect.gen(function* () {
      // A pid that is not running: the lock went with it, so the home is free.
      const { ownership } = yield* makeHarness({
        baseDir: "/tmp/t3-ownership-dead",
        record: makeRecord({ pid: 2 ** 22 }),
      });
      const owner = yield* ownership.inspect;
      assert.equal(owner._tag, "none");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a healthy server that answers its environment descriptor", () =>
    Effect.gen(function* () {
      const { ownership } = yield* makeHarness({
        baseDir: "/tmp/t3-ownership-healthy",
        record: makeRecord(),
        descriptorStatus: 200,
      });
      const owner = yield* ownership.inspect;
      assert.equal(owner._tag, "healthy");
      if (owner._tag === "healthy") {
        assert.equal(owner.httpBaseUrl.href, "http://127.0.0.1:3773/");
        assert.equal(owner.record.pid, process.pid);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a stranded server that owns the home but does not answer", () =>
    Effect.gen(function* () {
      const { ownership } = yield* makeHarness({
        baseDir: "/tmp/t3-ownership-stranded",
        record: makeRecord(),
        descriptorStatus: 503,
      });
      const owner = yield* ownership.inspect;
      assert.equal(owner._tag, "stranded");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a service-managed server alone even when it does not answer", () =>
    Effect.gen(function* () {
      const { ownership } = yield* makeHarness({
        baseDir: "/tmp/t3-ownership-service",
        record: makeRecord({ serviceManaged: true }),
        descriptorStatus: 503,
      });
      const owner = yield* ownership.inspect;
      assert.equal(owner._tag, "foreign");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads the runtime record from the T3 home's userdata directory", () =>
    Effect.gen(function* () {
      const { ownership, recordPath } = yield* makeHarness({
        baseDir: "/tmp/t3-ownership-path",
      });
      assert.equal(yield* ownership.runtimeStatePath, recordPath);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ResourceAttribution from "../resourceTelemetry/ResourceAttribution.ts";
import * as Diagnostics from "./TemporaryThreadDiagnostics.ts";
import * as Observability from "./Observability.ts";

it.effect(
  "discard keeps payload-free operational traces in local and OTLP sinks while heap remains blocked",
  () =>
    Effect.gen(function* () {
      const diagnostics = yield* Diagnostics.TemporaryThreadDiagnostics;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const exported: string[] = [];
      const observability = Observability.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ResourceAttribution.ResourceAttribution)({ record: () => Effect.void }),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.sync(() => {
                  exported.push(
                    request.body._tag === "Uint8Array"
                      ? new TextDecoder().decode(request.body.body)
                      : "",
                  );
                  return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
                }),
              ),
            ),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        diagnostics.enter(ThreadId.make("private"));
        diagnostics.leave(ThreadId.make("private"));
        yield* Effect.logError("private-message-sentinel", {
          private: "private-field-sentinel",
        }).pipe(
          Effect.annotateLogs({ private: "private-annotation-sentinel" }),
          Effect.withSpan("private-span-sentinel", {
            attributes: { private: "private-attribute-sentinel" },
          }),
        );
        yield* Effect.void.pipe(Effect.withSpan("private-delayed-success-sentinel"));
        yield* Effect.fail("private-cause-sentinel").pipe(
          Effect.withSpan("private-failure-sentinel"),
          Effect.ignore,
        );
      }).pipe(Effect.provide(observability));
      const local = (yield* fs.exists(config.serverTracePath))
        ? yield* fs.readFileString(config.serverTracePath)
        : "";
      assert.include(local, "Server operation signal");
      assert.include(local, "Server operation failed");
      assert.include(exported.join("\n"), "Server operation signal");
      assert.include(exported.join("\n"), "Server operation failed");
      assert.notInclude(local, "sentinel");
      assert.notInclude(exported.join("\n"), "sentinel");
      assert.isFalse(diagnostics.canSnapshot());
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Diagnostics.layer,
          Layer.effect(
            ServerConfig.ServerConfig,
            Effect.map(ServerConfig.ServerConfig, (config) => ({
              ...config,
              otlpTracesUrl: "https://collector.example/v1/traces",
            })),
          ).pipe(
            Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-private-trace-" })),
            Layer.provide(NodeServices.layer),
          ),
          NodeServices.layer,
        ),
      ),
    ),
);

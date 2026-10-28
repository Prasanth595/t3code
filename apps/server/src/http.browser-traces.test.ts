import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthOrchestrationOperateScope, AuthSessionId, ThreadId } from "@t3tools/contracts";
import {
  layerOtlpSerialization,
  type TraceRecord,
  type TraceSink,
} from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/http";
import type * as OtlpTracer from "effect/observability/OtlpTracer";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerConfig from "./config.ts";
import { layerOtlpTracesProxyRoute } from "./http.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as Diagnostics from "./observability/TemporaryThreadDiagnostics.ts";

it.effect(
  "browser HTTP traces stop before local collection and upstream export during and after discard",
  () =>
    Effect.gen(function* () {
      const diagnostics = yield* Diagnostics.TemporaryThreadDiagnostics;
      const records: TraceRecord[] = [];
      const exports: string[] = [];
      const sink: TraceSink = {
        filePath: "/unused",
        push: (record) => records.push(record),
        flush: Effect.void,
        close: () => Effect.void,
      };
      const layer = layerOtlpTracesProxyRoute.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(Diagnostics.TemporaryThreadDiagnostics, diagnostics),
            BrowserTraceCollector.layer(sink),
            layerOtlpSerialization("http/json"),
            Layer.mock(EnvironmentAuth.EnvironmentAuth)({
              authenticateHttpRequest: () =>
                Effect.succeed({
                  sessionId: AuthSessionId.make("test-session"),
                  subject: "test",
                  method: "bearer-access-token",
                  scopes: [AuthOrchestrationOperateScope],
                }),
            }),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.sync(() => {
                  exports.push(
                    request.body._tag === "Uint8Array"
                      ? new TextDecoder().decode(request.body.body)
                      : "",
                  );
                  return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
                }),
              ),
            ),
            Layer.effect(
              ServerConfig.ServerConfig,
              Effect.map(ServerConfig.ServerConfig, (config) => ({
                ...config,
                otlpTracesUrl: "https://collector.example/v1/traces",
              })),
            ).pipe(
              Layer.provide(
                ServerConfig.layerTest(process.cwd(), { prefix: "t3-browser-export-" }),
              ),
            ),
          ),
        ),
        Layer.provideMerge(NodeServices.layer),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(layer, { disableLogger: true });
      try {
        const send = (name: string) =>
          Effect.promise(() =>
            handler(
              new Request("http://localhost/api/observability/v1/traces", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  resourceSpans: [
                    {
                      resource: { attributes: [], droppedAttributesCount: 0 },
                      scopeSpans: [
                        {
                          scope: { name: "browser" },
                          spans: [
                            {
                              traceId: "00000000000000000000000000000001",
                              spanId: "0000000000000001",
                              parentSpanId: undefined,
                              name,
                              kind: 1,
                              startTimeUnixNano: "0",
                              endTimeUnixNano: "1",
                              attributes: [{ key: "private", value: { stringValue: name } }],
                              droppedAttributesCount: 0,
                              events: [],
                              droppedEventsCount: 0,
                              links: [],
                              droppedLinksCount: 0,
                              status: { code: 0 },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                } satisfies OtlpTracer.TraceData),
              }),
            ),
          );
        expect((yield* send("saved-before")).status).toBe(204);
        expect(exports).toHaveLength(1);
        expect(records).toHaveLength(1);
        diagnostics.enter(ThreadId.make("temporary"));
        expect((yield* send("private-active-sentinel")).status).toBe(204);
        diagnostics.leave(ThreadId.make("temporary"));
        expect((yield* send("private-delayed-sentinel")).status).toBe(204);
        expect(exports).toHaveLength(1);
        expect(records).toHaveLength(1);
        expect(exports[0]).toContain("saved-before");
      } finally {
        yield* Effect.promise(dispose);
      }
    }).pipe(Effect.provide(Diagnostics.layer)),
);

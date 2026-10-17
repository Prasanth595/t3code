import * as AdmissionControl from "./AdmissionControl.ts";
import { afterEach, expect, it } from "vite-plus/test";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Admission from "./Admission.ts";
import * as AdmissionHttp from "./AdmissionHttp.ts";
import * as Orchestrator from "./Orchestrator.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

function fixture(scopes: ReadonlyArray<AuthEnvironmentScope>, address = "127.0.0.1") {
  const { handler, dispose } = HttpRouter.toWebHandler(
    AdmissionHttp.layer.pipe(
      Layer.provideMerge(AdmissionControl.layer),
      Layer.provideMerge(Admission.layer.pipe(Layer.provide(Sqlite.layerMemory))),
      Layer.provideMerge(
        Layer.mock(Orchestrator.OrchestratorV2)({ resumeQueuedRuns: Effect.succeed(0) }),
      ),
      Layer.provideMerge(
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateHttpRequest: () =>
            Effect.succeed({
              sessionId: AuthSessionId.make("operator-test"),
              subject: "operator",
              method: "bearer-access-token",
              scopes,
            }),
        }),
      ),
      Layer.provide(
        HttpRouter.middleware((effect) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            return yield* effect.pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                request.modify({ remoteAddress: Option.some(address) }),
              ),
            );
          }),
        ).layer,
      ),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return (path: string, method = "GET") =>
    handler(new Request(`http://127.0.0.1/api/local/admission${path}`, { method }));
}

it("requires operate for drain/resume and read for status", async () => {
  const read = fixture([AuthOrchestrationReadScope]);
  expect((await read("/drain", "POST")).status).toBe(403);
  expect((await read("/resume", "POST")).status).toBe(403);
  expect((await read("/status")).status).toBe(200);
  const operate = fixture([AuthOrchestrationOperateScope]);
  expect((await operate("/status")).status).toBe(403);
});

it("drains and resumes through the paired operator API", async () => {
  const request = fixture([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
  expect(await (await request("/drain", "POST")).json()).toEqual({
    draining: true,
    running: 0,
    queued: 0,
  });
  expect(await (await request("/status")).json()).toEqual({
    draining: true,
    running: 0,
    queued: 0,
  });
  expect(await (await request("/resume", "POST")).json()).toEqual({
    draining: false,
    running: 0,
    queued: 0,
  });
  expect((await request("/drain")).status).toBe(404);
});

it("refuses a remote socket even with operator scopes", async () => {
  const request = fixture(
    [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    "192.168.1.25",
  );
  expect((await request("/drain", "POST")).status).toBe(403);
});

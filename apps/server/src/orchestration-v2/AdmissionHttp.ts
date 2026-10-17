import { AuthOrchestrationReadScope, AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { authenticateRawRouteWithScope } from "../http.ts";
import * as AdmissionControl from "./AdmissionControl.ts";

const handle = (operation: "status" | "drain" | "resume") =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    // Use the socket, never Host or forwarded headers. The endpoint has no relay/remote surface.
    const address = Option.getOrUndefined(request.remoteAddress);
    if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") {
      return HttpServerResponse.jsonUnsafe({ code: "loopback_required" }, { status: 403 });
    }
    yield* authenticateRawRouteWithScope(
      operation === "status" ? AuthOrchestrationReadScope : AuthOrchestrationOperateScope,
    );
    const control = yield* AdmissionControl.AdmissionControl;
    return yield* control[operation].pipe(
      Effect.map((status) => HttpServerResponse.jsonUnsafe(status)),
      Effect.catch(() =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { code: "admission_unavailable", retryable: true },
            { status: 503 },
          ),
        ),
      ),
    );
  });

export const layer = Layer.mergeAll(
  HttpRouter.add("GET", "/api/local/admission/status", handle("status")),
  HttpRouter.add("POST", "/api/local/admission/drain", handle("drain")),
  HttpRouter.add("POST", "/api/local/admission/resume", handle("resume")),
);

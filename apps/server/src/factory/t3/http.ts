import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerResponse } from "effect/http";

import { FactoryLoop } from "../index.ts";
import { route } from "./auth.ts";

export const STATUS_PATH = "/api/factory/status";

const statusRoute = route(
  "GET",
  STATUS_PATH,
  AuthOrchestrationReadScope,
  Effect.gen(function* () {
    const { status } = yield* FactoryLoop;
    return HttpServerResponse.jsonUnsafe(status);
  }),
);

/**
 * The factory's HTTP routes. server.ts merges this into `layerMakeRoutes`; later routes are
 * added here.
 */
export const FactoryRoutes = Layer.mergeAll(statusRoute);

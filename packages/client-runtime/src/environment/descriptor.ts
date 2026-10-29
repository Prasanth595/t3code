import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { environmentEndpointUrl } from "./endpoint.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiGroupClient } from "../rpc/http.ts";

const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Descriptors fetched by route checks, reusable only before the first route attempt.
 * Verifying the same origin again before sending credentials would cost a round trip.
 */
export class CheckedEnvironmentDescriptors extends Context.Reference<
  ReadonlyMap<string, ExecutionEnvironmentDescriptor>
>("@t3tools/client-runtime/environment/CheckedEnvironmentDescriptors", {
  defaultValue: () => new Map(),
}) {}

export const fetchRemoteEnvironmentDescriptor = Effect.fn(
  "clientRuntime.environment.fetchRemoteEnvironmentDescriptor",
)(function* (input: { readonly httpBaseUrl: string; readonly timeoutMs?: number }) {
  const client = yield* makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "metadata");
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/.well-known/t3/environment"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.descriptor(),
  );
});

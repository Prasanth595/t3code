/**
 * Fork: commands that read and change the per-origin request headers, for
 * example a Cloudflare Access service token. See `requestHeaders.ts`.
 */
import { type RequestHeader, RequestHeaderStore } from "@t3tools/client-runtime/connection";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "./runtime";

export const readRequestHeaders = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:read-request-headers",
  execute: (origin: string) =>
    RequestHeaderStore.pipe(Effect.flatMap((store) => store.get(origin))),
});

export const saveRequestHeaders = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:save-request-headers",
  concurrency: {
    mode: "serial",
    key: (input: { readonly origin: string }) => input.origin,
  },
  execute: (input: { readonly origin: string; readonly headers: ReadonlyArray<RequestHeader> }) =>
    RequestHeaderStore.pipe(Effect.flatMap((store) => store.set(input.origin, input.headers))),
});

/**
 * Moves the headers of `from` to `to` after an environment's address changes,
 * so its token is neither stranded nor lost. Headers already saved for `to`
 * win. `keepFrom` leaves `from` alone while another saved environment uses it.
 */
export const moveRequestHeaders = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:move-request-headers",
  concurrency: { mode: "serial", key: () => "request-headers" },
  execute: (input: { readonly from: string; readonly to: string; readonly keepFrom: boolean }) =>
    RequestHeaderStore.pipe(
      Effect.flatMap((store) =>
        Effect.gen(function* () {
          const moved = yield* store.get(input.from);
          if (moved.length === 0) return;
          if ((yield* store.get(input.to)).length === 0) yield* store.set(input.to, moved);
          if (!input.keepFrom) yield* store.set(input.from, []);
        }),
      ),
    ),
});

// Pairing the factory server from the web UI's pairing page, and the bearer it leaves behind.
// Upstream's pairing exchange sets a cookie session, which cannot work from the desktop's
// custom-scheme origin to 127.0.0.1, so the exchange runs here and the page reloads.
import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import { FORK_FACTORY_SERVER_URL } from "@t3tools/shared/forkIdentity";
import { getPairingTokenFromUrl } from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import { PAIR_FACTORY_SERVER_CHANNEL } from "./factoryServerChannel.ts";
import { usesFactoryServer } from "./factoryServer.ts";
import { readFactoryServerBearer, writeFactoryServerBearer } from "./factoryServerCredential.ts";

export class FactoryServerPairingError extends Schema.TaggedError<FactoryServerPairingError>()(
  "FactoryServerPairingError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** A pairing link (`.../pair#token=...`) or a bare token. */
const credentialFromInput = (input: string): string | null => {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const url = URL.canParse(trimmed) ? new URL(trimmed) : null;
  return url === null ? trimmed : getPairingTokenFromUrl(url);
};

/**
 * The stored bearer, `""` before pairing, and `null` when this build does not use the factory
 * server, so upstream's local-backend token applies.
 */
export const factoryServerBearerToken = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (!usesFactoryServer(environment)) return null;
  return Option.getOrElse(yield* readFactoryServerBearer, () => "");
});

export const pairFactoryServer = DesktopIpc.makeIpcMethod({
  channel: PAIR_FACTORY_SERVER_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.factory.pairFactoryServer")(function* (input) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (!usesFactoryServer(environment)) {
      return yield* new FactoryServerPairingError({
        reason: "This build does not use the factory server.",
      });
    }
    const credential = credentialFromInput(input);
    if (credential === null) {
      return yield* new FactoryServerPairingError({
        reason: "Paste a pairing link from `t3 pair`.",
      });
    }
    const httpClient = yield* HttpClient.HttpClient;
    const session = yield* bootstrapRemoteBearerSession({
      httpBaseUrl: FORK_FACTORY_SERVER_URL,
      credential,
      clientMetadata: { label: "T3 Code Factory Desktop", deviceType: "desktop" },
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.mapError(
        (error) =>
          new FactoryServerPairingError({
            reason:
              error._tag === "RemoteEnvironmentAuthFetchError" ||
              error._tag === "RemoteEnvironmentAuthTimeoutError"
                ? `Could not reach the factory server at ${FORK_FACTORY_SERVER_URL}. Is it running?`
                : "The factory server rejected this pairing link.",
          }),
      ),
    );
    yield* writeFactoryServerBearer(session.access_token).pipe(
      Effect.mapError((error) => new FactoryServerPairingError({ reason: error.message })),
    );
  }),
});

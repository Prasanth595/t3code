import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { RelayWebClientId } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { createBrowserDpopProof, loadOrCreateBrowserDpopKey } from "./dpop";

const layerRelayDpopSigner = Layer.effect(
  ManagedRelay.ManagedRelayDpopSigner,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    return ManagedRelay.ManagedRelayDpopSigner.of({
      thumbprint: loadOrCreateBrowserDpopKey.pipe(
        Effect.map((proofKey) => proofKey.thumbprint),
        Effect.mapError(
          (error) =>
            new ManagedRelay.ManagedRelayDpopKeyLoadError({
              keyStore: "indexed-db",
              cause: error,
            }),
        ),
        Effect.withSpan("web.managedRelayDpopSigner.loadThumbprint"),
      ),
      createProof: Effect.fn("web.managedRelayDpopSigner.createProof")(function* (input) {
        const proofKey = yield* loadOrCreateBrowserDpopKey.pipe(
          Effect.mapError(
            (error) =>
              new ManagedRelay.ManagedRelayDpopProofCreationError({
                method: input.method,
                url: input.url,
                cause: error,
              }),
          ),
        );
        return yield* createBrowserDpopProof({ ...input, proofKey }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.map((proof) => proof.proof),
          Effect.mapError(
            (error) =>
              new ManagedRelay.ManagedRelayDpopProofCreationError({
                method: input.method,
                url: input.url,
                cause: error,
              }),
          ),
        );
      }),
    });
  }),
);

export const layer = (relayUrl: string) =>
  ManagedRelay.layer({ relayUrl, clientId: RelayWebClientId }).pipe(
    Layer.provideMerge(layerRelayDpopSigner),
  );

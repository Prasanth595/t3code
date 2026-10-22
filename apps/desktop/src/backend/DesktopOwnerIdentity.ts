import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";

export class DesktopOwnerIdentity extends Context.Service<
  DesktopOwnerIdentity,
  {
    /**
     * This desktop installation's stable identity for the T3 home. The
     * desktop hands it to the server it starts, and the server persists it in
     * its runtime record, so a later launch can tell its own leftover apart
     * from a server the user started by hand.
     *
     * It is not a credential: it only says which desktop installation
     * started a server.
     */
    readonly ownerId: Effect.Effect<string, PlatformError.PlatformError>;
  }
>()("@t3tools/desktop/backend/DesktopOwnerIdentity") {}

const { logWarning: logOwnerIdentityWarning } =
  DesktopObservability.makeComponentLogger("desktop-owner-identity");

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;

  const ownerIdentityPath = environment.path.join(environment.stateDir, "desktop-owner-id");

  const ownerId = Effect.gen(function* () {
    const existing = yield* fileSystem.readFileString(ownerIdentityPath).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.succeed(Option.none<string>()),
        onSuccess: (contents) => Effect.succeed(Option.some(contents)),
      }),
    );
    if (Option.isSome(existing)) {
      const stored = existing.value.trim();
      // An empty id names no owner: the bootstrap contract rejects it, and a
      // record written with it would be accepted by a later launch.
      if (stored.length > 0) {
        return stored;
      }
    }
    // A failed generation is not papered over with an empty id: the desktop
    // that cannot name itself must not claim a server as its own.
    const generated = yield* crypto.randomUUIDv4();
    yield* fileSystem.writeFileString(ownerIdentityPath, `${generated}\n`).pipe(
      Effect.catchCause((cause) =>
        logOwnerIdentityWarning("could not persist the desktop owner identity", {
          path: ownerIdentityPath,
          cause,
        }).pipe(Effect.asVoid),
      ),
    );
    return generated;
  });

  return DesktopOwnerIdentity.of({ ownerId });
});

export const layer = Layer.effect(DesktopOwnerIdentity, make);

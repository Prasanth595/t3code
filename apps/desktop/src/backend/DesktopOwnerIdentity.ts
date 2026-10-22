import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";

const DesktopOwnerIdentityDocument = Schema.Struct({
  ownerId: Schema.String,
});

const decodeDesktopOwnerIdentity = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopOwnerIdentityDocument),
);

const encodeDesktopOwnerIdentity = Schema.encodeEffect(
  Schema.fromJsonString(DesktopOwnerIdentityDocument),
);

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
    readonly ownerId: Effect.Effect<string>;
  }
>()("@t3tools/desktop/backend/DesktopOwnerIdentity") {}

const { logWarning: logOwnerIdentityWarning } =
  DesktopObservability.makeComponentLogger("desktop-owner-identity");

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;

  const ownerIdentityPath = environment.path.join(environment.stateDir, "desktop-owner.json");

  const ownerId = Effect.gen(function* () {
    const existing = yield* fileSystem.readFileString(ownerIdentityPath).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.succeed(Option.none<string>()),
        onSuccess: (contents) => Effect.succeed(Option.some(contents)),
      }),
    );
    if (Option.isSome(existing)) {
      const decoded = yield* decodeDesktopOwnerIdentity(existing.value.trim()).pipe(Effect.option);
      if (Option.isSome(decoded)) {
        return decoded.value.ownerId;
      }
    }
    const generated = yield* crypto.randomUUIDv4().pipe(Effect.orElseSucceed(() => ""));
    const document = yield* encodeDesktopOwnerIdentity({ ownerId: generated }).pipe(
      Effect.catchCause((cause) =>
        logOwnerIdentityWarning("could not encode the desktop owner identity", {
          path: ownerIdentityPath,
          cause,
        }).pipe(Effect.as("")),
      ),
    );
    yield* fileSystem.writeFileString(ownerIdentityPath, `${document}\n`).pipe(
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

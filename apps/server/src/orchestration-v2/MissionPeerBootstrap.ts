// @effect-diagnostics nodeBuiltinImport:off -- loaded-bundle digests and pinned Ed25519 key comparison.
import { createHash, createPublicKey } from "node:crypto";
import { HostProcessArguments, HostProcessIsExecutable } from "@t3tools/shared/hostProcess";
import { signRelayJwt } from "@t3tools/shared/relayJwt";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { getExistingEnvironmentKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Boot from "./MissionPeerBootIdentity.ts";
import * as Bundle from "./MissionPeerBundleIdentity.ts";
import * as Handshake from "./MissionPeerHandshake.ts";
import * as Store from "./MissionPeerHandshakeStore.ts";
import * as Facts from "./MissionPeerRuntimeFacts.ts";

export class MissionPeerBootstrapError extends Schema.TaggedError<MissionPeerBootstrapError>()(
  "MissionPeerBootstrapError",
  {
    category: Schema.Literals([
      "unsupported_execution",
      "entrypoint_mismatch",
      "identity_mismatch",
      "invalid_config",
      "layout",
      "bounds",
      "read",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Mission peer bootstrap refused (${this.category}).`;
  }
}

/** Private owning-entrypoint input, never request/session/descriptor configuration. */
export interface PeerBootstrapInputs {
  readonly approvedPeer: Handshake.PeerTrustConfig;
  readonly entrypoint: {
    /** Graph mode requires the manifest emitted from the complete vp pack chunk output. */
    readonly format: "packed-module-graph" | "single-file-bundle";
    /** import.meta.url of bin.ts as evaluated in that bundle, not a caller-selected file path. */
    readonly moduleUrl: string;
  };
}

/**
 * Capture the actual process build once at bootstrap. Normal vp pack is a thin
 * bin plus server/shared chunks; graph mode binds those through its build-time
 * manifest. Legacy single-file mode still requires the producer in bin itself.
 */
const captureLoadedBuild = Effect.fn("MissionPeerBootstrap.captureLoadedBuild")(function* (
  entrypoint: PeerBootstrapInputs["entrypoint"],
  bootId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const args = yield* HostProcessArguments;
  const executable = yield* HostProcessIsExecutable;
  // SEA needs its own executable-byte receipt; do not hash its build-time module URL.
  if (
    executable ||
    (entrypoint.format !== "single-file-bundle" && entrypoint.format !== "packed-module-graph") ||
    !args[1]
  ) {
    return yield* new MissionPeerBootstrapError({ category: "unsupported_execution" });
  }
  const ownerUrl = yield* Effect.try({
    try: () => new URL(entrypoint.moduleUrl),
    catch: () => new MissionPeerBootstrapError({ category: "entrypoint_mismatch" }),
  });
  if (ownerUrl.protocol !== "file:" || ownerUrl.search || ownerUrl.hash) {
    return yield* new MissionPeerBootstrapError({ category: "unsupported_execution" });
  }
  const fromUrl = (url: URL) =>
    path.fromFileUrl(url).pipe(
      Effect.flatMap(fs.realPath),
      Effect.mapError((cause) => new MissionPeerBootstrapError({ category: "read", cause })),
    );
  const artifactPath = yield* fromUrl(ownerUrl);
  const producerPath = yield* fromUrl(new URL(import.meta.url));
  const processEntryPath = yield* fs
    .realPath(args[1])
    .pipe(Effect.mapError((cause) => new MissionPeerBootstrapError({ category: "read", cause })));
  if (artifactPath !== processEntryPath || path.basename(artifactPath) !== "bin.mjs") {
    return yield* new MissionPeerBootstrapError({ category: "entrypoint_mismatch" });
  }
  if (entrypoint.format === "packed-module-graph") {
    return yield* Bundle.capture({ entryPath: artifactPath, producerPath, bootId }).pipe(
      Effect.mapError(
        (cause) =>
          new MissionPeerBootstrapError({
            category: cause.category,
            cause,
          }),
      ),
    );
  }
  if (artifactPath !== producerPath) {
    return yield* new MissionPeerBootstrapError({ category: "entrypoint_mismatch" });
  }
  const bytes = yield* Bundle.readBoundedFile(artifactPath, Bundle.MAX_MODULE_BYTES).pipe(
    Effect.mapError((cause) => new MissionPeerBootstrapError({ category: cause.category, cause })),
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { artifactPath, sha256, receiptId: `loaded:${bootId}:sha256:${sha256}` };
});

/**
 * Reuse the existing nonce ledger, facts and handshake. The root provides its
 * migrated SqlClient, existing secret store and environment identity. No keys,
 * config, schema, route, HTTP credentials, or remote request are created here.
 * Share this exact layer with the route and the authenticated HTTP client layer.
 */
export const layer = (inputs: PeerBootstrapInputs) => {
  // Snapshot private configuration before the layer is built or shared.
  const approvedPeer = { ...inputs.approvedPeer };
  const entrypoint = { ...inputs.entrypoint };
  return Layer.unwrap(
    Effect.gen(function* () {
      const pin = yield* Schema.decodeUnknownEffect(Handshake.PeerTrustConfig)(approvedPeer, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(() => new MissionPeerBootstrapError({ category: "invalid_config" })));
      const environment = yield* ServerEnvironmentIdentity;
      const environmentId = yield* environment.getEnvironmentId;
      if (
        environmentId !== pin.sourceEnvironmentId &&
        environmentId !== pin.receiverEnvironmentId
      ) {
        return yield* new MissionPeerBootstrapError({ category: "identity_mismatch" });
      }
      const boot = yield* Boot.MissionPeerBootIdentity;
      const bootId = yield* boot.read;
      const loadedBuild = yield* captureLoadedBuild(entrypoint, bootId);
      if (
        environmentId === pin.receiverEnvironmentId &&
        loadedBuild.sha256 !== pin.receiverBuildSha256
      ) {
        return yield* new Facts.MissionPeerRuntimeFactsError({ category: "build_mismatch" });
      }
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const publicKey =
        environmentId === pin.sourceEnvironmentId ? pin.sourcePublicKey : pin.receiverPublicKey;
      const signer: Handshake.PeerSigner = (input) =>
        Effect.gen(function* () {
          const pair = yield* getExistingEnvironmentKeyPairFromSecretStore(secrets).pipe(
            Effect.mapError((cause) => new Handshake.MissionPeerSigningError({ cause })),
          );
          if (Option.isNone(pair)) {
            return yield* new Handshake.MissionPeerSigningError({
              cause: new Error("Existing environment signing key is unavailable."),
            });
          }
          yield* Effect.try({
            try: () => {
              const expected = createPublicKey(publicKey);
              const stored = createPublicKey(pair.value.publicKey);
              const derived = createPublicKey(pair.value.privateKey);
              const expectedBytes = expected.export({ type: "spki", format: "der" });
              if (
                expected.asymmetricKeyType !== "ed25519" ||
                !expectedBytes.equals(stored.export({ type: "spki", format: "der" })) ||
                !expectedBytes.equals(derived.export({ type: "spki", format: "der" }))
              ) {
                throw new Error("Key mismatch");
              }
            },
            catch: () =>
              new Handshake.MissionPeerSigningError({
                cause: new Error(
                  "Existing environment signing key does not match reviewed peer pins.",
                ),
              }),
          });
          return yield* signRelayJwt({
            privateKey: pair.value.privateKey,
            typ: input.typ,
            payload: input.payload,
          }).pipe(Effect.mapError((cause) => new Handshake.MissionPeerSigningError({ cause })));
        });
      return Handshake.layer(pin, signer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Store.layer,
            Facts.layer({ environmentId, readBootIdentity: boot.read, loadedBuild }),
          ),
        ),
      );
    }),
  ).pipe(Layer.provide(Boot.layer));
};

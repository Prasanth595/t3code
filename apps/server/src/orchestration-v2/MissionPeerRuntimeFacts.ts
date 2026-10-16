// @effect-diagnostics nodeBuiltinImport:off -- build identity is the digest of verified artifact bytes.
import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { HostProtocolId } from "../../../../packages/contracts/src/missionHostProtocol.ts";
import { PeerRuntimeAttestation } from "../../../../packages/contracts/src/missionPeerHandshake.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";

export class MissionPeerRuntimeFactsError extends Schema.TaggedError<MissionPeerRuntimeFactsError>()(
  "MissionPeerRuntimeFactsError",
  {
    category: Schema.Literals(["unavailable", "identity_mismatch", "build_mismatch", "read"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Mission peer runtime facts refused (${this.category}).`;
  }
}

/**
 * Required boot producer and loaded-build receipt from the owning bootstrap.
 * The receipt must identify the bytes actually loaded by this process (including
 * its bundled server), not a nearby checkout, version string, or random ID.
 * No defaults, key lookup, process launch, or ambient configuration are used.
 */
export interface PeerRuntimeInputs {
  readonly environmentId: string;
  readonly readBootIdentity: Effect.Effect<string, MissionPeerRuntimeFactsError>;
  readonly loadedBuild: {
    readonly artifactPath: string;
    readonly sha256: string;
    readonly receiptId: string;
  };
}

export class MissionPeerRuntimeFacts extends Context.Service<
  MissionPeerRuntimeFacts,
  {
    readonly attest: Effect.Effect<PeerRuntimeAttestation, MissionPeerRuntimeFactsError>;
  }
>()("t3/orchestration-v2/MissionPeerRuntimeFacts") {}

export const layer = (inputs: PeerRuntimeInputs | null) =>
  Layer.effect(
    MissionPeerRuntimeFacts,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const environment = yield* ServerEnvironmentIdentity;
      // Capture immutable metadata; never let a later caller replace the build pin.
      const build = inputs === null ? null : { ...inputs.loadedBuild };
      const environmentId = inputs?.environmentId;
      const boot = inputs?.readBootIdentity;
      const attest = Effect.gen(function* () {
        if (build === null || boot === undefined || environmentId === undefined) {
          return yield* new MissionPeerRuntimeFactsError({ category: "unavailable" });
        }
        if ((yield* environment.getEnvironmentId) !== environmentId) {
          return yield* new MissionPeerRuntimeFactsError({ category: "identity_mismatch" });
        }
        const receiverBootId = yield* boot.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(HostProtocolId)),
          Effect.mapError((cause) => new MissionPeerRuntimeFactsError({ category: "read", cause })),
        );
        const bytes = yield* fs
          .readFile(build.artifactPath)
          .pipe(
            Effect.mapError(
              (cause) => new MissionPeerRuntimeFactsError({ category: "read", cause }),
            ),
          );
        const buildSha256 = createHash("sha256").update(bytes).digest("hex");
        if (buildSha256 !== build.sha256) {
          return yield* new MissionPeerRuntimeFactsError({ category: "build_mismatch" });
        }
        return yield* Schema.decodeUnknownEffect(PeerRuntimeAttestation)({
          receiverEnvironmentId: environmentId,
          receiverBootId,
          runtimeBuildId: `sha256:${buildSha256}`,
          buildSha256,
          buildReceiptId: build.receiptId,
          capabilities: {
            protocol: "mission-peer-handshake/v1",
            handlers: ["POST /api/mission-peer/handshake"],
            fencing: "unsupported",
            durableAck: "volatile",
          },
        }).pipe(
          Effect.mapError((cause) => new MissionPeerRuntimeFactsError({ category: "read", cause })),
        );
      });
      return MissionPeerRuntimeFacts.of({ attest });
    }),
  );

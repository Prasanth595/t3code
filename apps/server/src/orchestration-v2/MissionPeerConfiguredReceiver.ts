import { HostProcessUserId } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Bootstrap from "./MissionPeerBootstrap.ts";
import * as Handshake from "./MissionPeerHandshake.ts";
import * as Http from "./MissionPeerHttp.ts";

/** Private owning-bin input, not a request, environment variable or persisted path. */
export class MissionPeerEntrypoint extends Context.Service<
  MissionPeerEntrypoint,
  Bootstrap.PeerBootstrapInputs["entrypoint"]
>()("t3/orchestration-v2/MissionPeerConfiguredReceiver/MissionPeerEntrypoint") {}

/**
 * Opt-in receiver only. Reviewed public peer pins live beside the existing
 * NoFun mission policy; absent configuration mounts no route. This never
 * creates pins, credentials, keys, outbound clients or execution authority.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const filename = path.join(config.stateDir, "nofun", "mission-peer.json");
    const invalid = () => new Bootstrap.MissionPeerBootstrapError({ category: "invalid_config" });
    const stat = yield* fs.stat(filename).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) => error.reason._tag === "NotFound"
          ? Effect.succeedNone
          : Effect.fail(invalid()),
      }),
    );
    if (Option.isNone(stat)) return Layer.empty;
    const uid = yield* HostProcessUserId;
    if (
      stat.value.type !== "File" ||
      (stat.value.mode & 0o077) !== 0 ||
      Number(stat.value.size) > 65536 ||
      (uid !== undefined && Option.isSome(stat.value.uid) && stat.value.uid.value !== uid) ||
      (yield* fs.realPath(filename)) !== filename
    ) return yield* invalid();
    const text = yield* fs.readFileString(filename).pipe(Effect.mapError(invalid));
    if (new TextEncoder().encode(text).byteLength > 65536) return yield* invalid();
    const approvedPeer = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Handshake.PeerTrustConfig),
    )(text, { onExcessProperty: "error" }).pipe(Effect.mapError(invalid));
    const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
    if (environmentId === approvedPeer.sourceEnvironmentId && environmentId !== approvedPeer.receiverEnvironmentId) {
      return Layer.empty;
    }
    const entrypoint = yield* Effect.serviceOption(MissionPeerEntrypoint);
    if (Option.isNone(entrypoint)) {
      return yield* new Bootstrap.MissionPeerBootstrapError({ category: "unsupported_execution" });
    }
    return Http.routeLayer.pipe(
      Layer.provide(Bootstrap.layer({ approvedPeer, entrypoint: entrypoint.value })),
    );
  }),
);

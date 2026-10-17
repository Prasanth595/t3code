import { HostProcessUserId } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as Bootstrap from "./MissionPeerBootstrap.ts";
import * as Handshake from "./MissionPeerHandshake.ts";

/** One reviewed public pin snapshot shared by the receiver and outbound consumer. */
export class MissionPeerConfiguration extends Context.Service<
  MissionPeerConfiguration,
  Option.Option<Handshake.PeerTrustConfig>
>()("t3/orchestration-v2/MissionPeerConfiguration") {}

export const layer = Layer.effect(
  MissionPeerConfiguration,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const filename = path.join(config.stateDir, "nofun", "mission-peer.json");
    const invalid = () => new Bootstrap.MissionPeerBootstrapError({ category: "invalid_config" });
    const stat = yield* fs.stat(filename).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeedNone : Effect.fail(invalid()),
      }),
    );
    if (Option.isNone(stat)) return Option.none<Handshake.PeerTrustConfig>();
    const uid = yield* HostProcessUserId;
    if (
      stat.value.type !== "File" ||
      (stat.value.mode & 0o077) !== 0 ||
      Number(stat.value.size) > 65536 ||
      (uid !== undefined && Option.isSome(stat.value.uid) && stat.value.uid.value !== uid) ||
      (yield* fs.realPath(filename)) !== filename
    )
      return yield* invalid();
    const text = yield* fs.readFileString(filename).pipe(Effect.mapError(invalid));
    if (new TextEncoder().encode(text).byteLength > 65536) return yield* invalid();
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Handshake.PeerTrustConfig))(
      text,
      { onExcessProperty: "error" },
    ).pipe(Effect.map(Option.some), Effect.mapError(invalid));
  }),
);

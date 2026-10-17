import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Bootstrap from "./MissionPeerBootstrap.ts";
import * as Configuration from "./MissionPeerConfiguration.ts";
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
    const configured = yield* Configuration.MissionPeerConfiguration;
    if (Option.isNone(configured)) return Layer.empty;
    const approvedPeer = configured.value;
    const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
    if (
      environmentId === approvedPeer.sourceEnvironmentId &&
      environmentId !== approvedPeer.receiverEnvironmentId
    ) {
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

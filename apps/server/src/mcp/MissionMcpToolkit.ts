import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import { McpServer } from "effect/ai";

import * as MissionMcpAuthority from "./MissionMcpAuthority.ts";
import * as MissionMcpService from "./MissionMcpService.ts";
import * as MissionHandlers from "./toolkits/mission/handlers.ts";
import { MissionToolkit } from "./toolkits/mission/tools.ts";

/**
 * Optional mission MCP toolkit registration. This layer wires descriptors to
 * handlers to the real service and the real authority resolver, and nothing
 * else: root supplies the same SqlClient, projections, events, receipts,
 * registry, environment, invocation scope, and trusted policy it already
 * injects, and root owns activation. There is no default policy, no global
 * catalog merge, and no server start here.
 *
 * Root composition usage (root-owned, NOT wired here):
 *   Layer.mergeAll(MissionMcpToolkit.layerMissionToolkit, ...).pipe(
 *     Layer.provideMerge(McpServer.layerHttp(...)),
 *     Layer.provideMerge(Sqlite.layer...),
 *     ...
 *   )
 */
export const layerMissionToolkit = McpServer.toolkit(MissionToolkit).pipe(
  Layer.provide(MissionHandlers.layer),
  Layer.provide(MissionMcpService.layer),
  Layer.provide(MissionMcpAuthority.layer),
);

export { MissionToolkit };

// A missing trusted server policy keeps the tools out of the application catalog.
// Explicitly configured disabled policies still expose bounded denial responses.
export const layerOptionalMissionToolkit = Layer.unwrap(
  Effect.serviceOption(MissionMcpAuthority.MissionMcpTrustedPolicy).pipe(
    Effect.map((policy) =>
      Option.isNone(policy)
        ? Layer.empty
        : layerMissionToolkit.pipe(
            Layer.provide(Layer.succeed(MissionMcpAuthority.MissionMcpTrustedPolicy, policy.value)),
            Layer.provide(EventStore.layer),
            Layer.provide(Receipts.layer),
          ),
    ),
  ),
);

import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as MissionMcpService from "../../MissionMcpService.ts";
import { MissionToolkit } from "./tools.ts";

/**
 * Tiny mission handlers: each call reads the ambient invocation scope and
 * delegates to the one injected MissionMcpService. No parallel framework, no
 * new database handles, no registration in the main tool catalog.
 */
const handlers = {
  mission_get: (input: { readonly id: string }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* MissionMcpService.MissionMcpService;
      return yield* service.get(scope, input);
    }),
  mission_execute: (input: unknown) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* MissionMcpService.MissionMcpService;
      return yield* service.execute(scope, input);
    }),
} satisfies Parameters<typeof MissionToolkit.toLayer>[0];

export const layer = MissionToolkit.toLayer(handlers);

export { MissionToolkit };

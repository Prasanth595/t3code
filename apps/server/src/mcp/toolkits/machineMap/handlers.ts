import { type MapToolName, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { isMachineRequestNamespace } from "../../../fork/machineMap/machineAccess.ts";
import * as MachineMap from "../../../fork/machineMap/MachineMap.ts";
import * as MachinePeers from "../../../fork/machineMap/MachinePeers.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MachineMapToolkit } from "./tools.ts";

/**
 * An agent on another machine reaches these tools only through `machine_tool_call`. It must not
 * use the map role or the arrows of this machine, so a machine session gets none of them.
 */
const refuseMachineCaller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    isMachineRequestNamespace(scope.requestNamespace)
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Machine map tools are not available to another machine.",
          }),
        )
      : Effect.succeed(scope),
  ),
);

const toFailure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message: error.message });

/** MM-806: the portal records the calling thread and its title with each change. */
const callThroughPortal = (tool: MapToolName, input: unknown) =>
  Effect.gen(function* () {
    const scope = yield* refuseMachineCaller;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const machineMap = yield* MachineMap.MachineMap;
    const threadId = scope.thread?.threadId ?? null;
    const shell =
      threadId === null
        ? null
        : yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    return yield* machineMap
      .callMapTool({ tool, input, threadId, threadTitle: shell?.title ?? null })
      .pipe(Effect.mapError(toFailure));
  });

export const layer = McpToolAccess.toLayer(MachineMapToolkit, {
  machines_read: McpToolAccess.reads(() => callThroughPortal("machines_read", {})),
  machines_resources: McpToolAccess.reads((input) =>
    callThroughPortal("machines_resources", input),
  ),
  machines_set_access: McpToolAccess.writes((input) =>
    callThroughPortal("machines_set_access", input),
  ),
  machines_set_setting: McpToolAccess.writes((input) =>
    callThroughPortal("machines_set_setting", input),
  ),
  machines_command: McpToolAccess.writes((input) => callThroughPortal("machines_command", input)),
  machines_queue_cancel: McpToolAccess.writes((input) =>
    callThroughPortal("machines_queue_cancel", input),
  ),
  machines_undo: McpToolAccess.writes((input) => callThroughPortal("machines_undo", input)),
  machines_preset: McpToolAccess.writes((input) => callThroughPortal("machines_preset", input)),
  // Joining changes the settings and the auth of this server, like an environment setting.
  machines_join: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* refuseMachineCaller;
      // MM-919: joining sets the portal and turns the map on, so an agent never does it.
      // `t3 machine-map join` on a headless machine has no thread. A joined machine refuses a
      // second join while the map is on (`MachineMap.join`).
      if (scope.thread !== undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Agents do not join the machine map. Run t3 machine-map join on the machine.",
        });
      }
      const machineMap = yield* MachineMap.MachineMap;
      return yield* machineMap.join(input).pipe(Effect.mapError(toFailure));
    }),
  ),
  machine_tool_call: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      yield* refuseMachineCaller;
      const peers = yield* MachinePeers.MachinePeers;
      return yield* peers
        .callTool({ machine: input.machine, tool: input.tool, input: input.input ?? {} })
        .pipe(Effect.mapError(toFailure));
    }),
  ),
});

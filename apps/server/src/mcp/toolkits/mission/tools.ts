import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as MissionMcpService from "../../MissionMcpService.ts";

/**
 * Mission toolkit descriptors only. This module registers nothing in the
 * main tool catalog: root later wires the actual authority resolver and
 * activation. Handlers live in ./handlers.ts.
 */
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  MissionMcpService.MissionMcpService,
];

export const MissionGetTool = Tool.make("mission_get", {
  description:
    "Read the calling thread's current mission aggregate. Needs an agent running inside a T3 thread with the orchestration capability; MCP clients signed in from outside a thread are unsupported. Only the mission's current delivery manager thread may read it. Returns the durable mission or a missing status.",
  parameters: MissionMcpService.MissionMcpGetInput,
  success: MissionMcpService.MissionMcpGetResult,
  failure: MissionMcpService.MissionMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a mission")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const MissionExecuteTool = Tool.make("mission_execute", {
  description:
    "Create or replace the calling thread's mission through the existing MissionService CAS path on the same SQL, receipts, events, and replay. Needs an agent running inside a T3 thread with the orchestration capability; MCP clients signed in from outside a thread are unsupported. The command id keys idempotent replay: retrying the exact command returns its durable receipt without a duplicate event. Team, environment and caller authority come from the trusted server resolver; manager ownership and epoch are checked against the canonical mission.",
  parameters: MissionMcpService.MissionMcpExecuteInput,
  success: MissionMcpService.MissionMcpExecuteResult,
  failure: MissionMcpService.MissionMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Execute a mission command")
  .annotate(Tool.Destructive, true);

export const MissionToolkit = Toolkit.make(MissionGetTool, MissionExecuteTool);

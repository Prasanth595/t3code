/**
 * Fork: machine map agent tools (`apps/machine-map/SPEC.md`, MM-801). The `machines_*` tools run
 * through the portal connection of this machine, and the portal checks the map role of this
 * machine on every call (MM-802, MM-805). `machine_tool_call` goes to the other machine directly.
 */
import {
  MachineMapClientState,
  MachineMapJoinInput,
  MapToolInputs,
  type MapToolName,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as MachineMap from "../../../fork/machineMap/MachineMap.ts";
import * as MachinePeers from "../../../fork/machineMap/MachinePeers.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    MachineMap.MachineMap,
    MachinePeers.MachinePeers,
  ],
};

const MAP_ROLE_NOTE =
  "It runs through the machine map portal, which checks the map role of this machine. With the role `propose`, or when a change raises access for this machine, the change waits in the portal Inbox for the owner.";

const mapTool = <const Name extends Exclude<MapToolName, "machines_read">>(
  name: Name,
  description: string,
) =>
  Tool.make(name, {
    ...shared,
    description: `${description} ${MAP_ROLE_NOTE}`,
    parameters: MapToolInputs[name],
    success: Schema.Unknown,
  });

// MCP needs an object root for parameters, so the tool without inputs declares none.
const MachinesReadTool = Tool.make("machines_read", {
  ...shared,
  description: `Read the machine map: machines, presence and status, arrows, settings, the queue and the history. ${MAP_ROLE_NOTE}`,
  success: Schema.Unknown,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const MachinesSetAccessTool = mapTool(
  "machines_set_access",
  "Set what machine `from` can do on machine `to`: the level (none, read, standard, admin), agent tools, and an optional expiry in minutes after which the arrow returns to its current level.",
).annotate(Tool.Destructive, true);

const MachinesSetSettingTool = mapTool(
  "machines_set_setting",
  "Set or clear a managed setting: the shared value, or the override of one machine when machineId is set. Scope is `server` (T3 server settings) or `client` (desktop app settings).",
).annotate(Tool.Destructive, true);

const MachinesCommandTool = mapTool(
  "machines_command",
  "Send a command to one machine, such as restartServer, stopAllAgents, startThread or collectDiagnostics. An offline machine gets it when it connects; delivery `idle` waits until no agent runs there. Commands expire after 24 hours unless expiresInMinutes says otherwise.",
).annotate(Tool.Destructive, true);

const MachinesQueueCancelTool = mapTool(
  "machines_queue_cancel",
  "Cancel a queued command that its machine did not take yet.",
).annotate(Tool.Destructive, true);

const MachinesUndoTool = mapTool(
  "machines_undo",
  "Undo one revision of the map. The undo is a new revision.",
).annotate(Tool.Destructive, true);

const MachinesPresetTool = mapTool(
  "machines_preset",
  "Save the current arrows as a preset, apply a saved preset, or lock down (every arrow and map role becomes none).",
).annotate(Tool.Destructive, true);

const MachinesJoinTool = Tool.make("machines_join", {
  ...shared,
  description:
    "Join this machine to the machine map with a one-time join code from the portal (Add machine). It saves the machine token in the server secret store, turns on the machineMap setting and connects. Omit portalUrl to keep the portal of the machineMap setting.",
  parameters: MachineMapJoinInput,
  success: MachineMapClientState,
}).annotate(Tool.Destructive, true);

const MachineToolCallTool = Tool.make("machine_tool_call", {
  ...shared,
  description:
    "Call a T3 Code tool on another machine of the map, as this machine. The arrow from this machine to that machine must allow agent tools, and its level limits what the tool can do there. `machine` is the machine id or name; `tool` is a T3 Code MCP tool name such as t3_thread_list.",
  parameters: Schema.Struct({
    machine: TrimmedNonEmptyString,
    tool: TrimmedNonEmptyString,
    input: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  success: Schema.Unknown,
}).annotate(Tool.Destructive, true);

export const MachineMapToolkit = Toolkit.make(
  MachinesReadTool,
  MachinesSetAccessTool,
  MachinesSetSettingTool,
  MachinesCommandTool,
  MachinesQueueCancelTool,
  MachinesUndoTool,
  MachinesPresetTool,
  MachinesJoinTool,
  MachineToolCallTool,
);

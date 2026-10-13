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

/** Appended to every tool that runs through the portal. */
const PORTAL_NOTE =
  "The call goes through the portal connection of this machine, and the portal checks the map role of this machine (machines_read shows it). It fails when this machine has no portal connection, when the portal does not answer within 30 seconds, and while the owner's emergency pause is on. Only the owner can end the pause, in the portal.";

/** Appended to every map change. */
const MAP_WRITE_NOTE =
  'With the map role `edit`, the change applies at once and the result is {"_tag":"applied","revision":n}. With the role `propose`, or when the change raises access of this machine, the change waits in the portal Inbox and the result is {"_tag":"proposed","proposalId":"...","reason":"map-role"|"self-escalation"}. The owner approves or rejects a proposal; it expires after 24 hours. Each applied change is a revision that machines_undo can reverse. An offline machine applies the change when it connects.';

const mapTool = <const Name extends Exclude<MapToolName, "machines_read" | "machines_resources">>(
  name: Name,
  description: string,
) =>
  Tool.make(name, {
    ...shared,
    description: `${description} ${PORTAL_NOTE}`,
    parameters: MapToolInputs[name],
    success: Schema.Unknown,
  });

// MCP needs an object root for parameters, so the tool without inputs declares none.
const MachinesReadTool = Tool.make("machines_read", {
  ...shared,
  description: `Read the machine map. Call it first to find machine ids, map roles, revision numbers and command ids. Needs the map role \`read\`. Changes nothing. The result is {"_tag":"read", map, presence, commands, history, proposals, resources}: map holds the machines, arrows, managed settings and presets, and the owner's display data: notes (sticky notes with text and a place) and pairPlacements (where the owner put pair cards), which no machine applies; presence.<machineId> holds online, lastSeenAt and status (build, running turns, supported commands, clients); resources holds latest.<machineId> (the newest resource sample), thresholds.<machineId> (health thresholds) and alerts (the active health alerts); history holds the newest 50 revisions and makes most of the size, often more than 50,000 characters. ${PORTAL_NOTE}`,
  success: Schema.Unknown,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const MachinesResourcesTool = Tool.make("machines_resources", {
  ...shared,
  description: `Read the resource history of the machine with id machineId (from machines_read): CPU, memory, disk, swap and agent processes. Range \`hour\` and \`day\` give one point a minute, \`month\` one point an hour; the default is \`hour\`. The result is {"_tag":"resources", history, alerts}: alerts holds the health alerts of that machine that were active in the range. Needs the map role \`read\`. Changes nothing. ${PORTAL_NOTE}`,
  parameters: MapToolInputs.machines_resources,
  success: Schema.Unknown,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const MachinesSetAccessTool = mapTool(
  "machines_set_access",
  `Set the arrow from machine \`from\` to machine \`to\`: its access level, whether agents on \`from\` can call tools on \`to\`, and an optional expiry. \`from\` and \`to\` are machine ids from machines_read. Use it to give or remove access between two machines. A lower level ends the sessions of \`from\` on \`to\` at once. The owner keeps full access to every machine whatever the arrows say. Needs the map role \`propose\` or \`edit\`. ${MAP_WRITE_NOTE}`,
).annotate(Tool.Destructive, true);

const MachinesSetSettingTool = mapTool(
  "machines_set_setting",
  `Set or clear a managed setting: the shared value of every machine, or the override of one machine when machineId (a machine id from machines_read) is set. \`key\` is a top-level settings key, for example recoverInterruptedTurns. Only settings that the owner added to the map (Manage, in the portal Settings view) work; another key fails. Each machine applies the value live through its settings service. Needs the map role \`propose\` or \`edit\`. ${MAP_WRITE_NOTE}`,
).annotate(Tool.Destructive, true);

const MachinesCommandTool = mapTool(
  "machines_command",
  'Send a one-time command to the machine with id machineId (from machines_read), for example {"_tag":"stopAllAgents"} or {"_tag":"collectDiagnostics"}. Use only a command that the machine lists in presence.<machineId>.status.commands. Needs the map role `edit`; a command never becomes a proposal and cannot be undone. restartServer and stopAllAgents stop the running agent turns on that machine, the turn of the caller too when it runs there. An offline machine gets the command when it connects; delivery `idle` also waits until no agent runs there. A queued command expires after 24 hours unless expiresInMinutes says otherwise; cancel it with machines_queue_cancel. The result is {"_tag":"command", command} with status `queued`. Read the outcome later in `commands` of machines_read.',
).annotate(Tool.Destructive, true);

const MachinesQueueCancelTool = mapTool(
  "machines_queue_cancel",
  'Cancel a command that its machine did not take yet (status `queued`). commandId comes from `commands` in machines_read. A delivered or finished command cannot be cancelled. Needs the map role `edit`. The result is {"_tag":"command", command} with status `cancelled`.',
).annotate(Tool.Destructive, true);

const MachinesUndoTool = mapTool(
  "machines_undo",
  `Undo one revision of the map. The undo is a new revision, so the history keeps both and the undo can be undone too. Commands are not revisions and cannot be undone. Needs the map role \`propose\` or \`edit\`. ${MAP_WRITE_NOTE}`,
).annotate(Tool.Destructive, true);

const MachinesPresetTool = mapTool(
  "machines_preset",
  `Save the current arrows as a named preset, apply a saved preset, or lock down. Lockdown sets every arrow and every map role to none, so afterwards no agent can use the machine map tools, this one included, until the owner raises a map role. To stop running agents as well, the owner uses the emergency pause in the portal. Needs the map role \`propose\` or \`edit\`. ${MAP_WRITE_NOTE}`,
).annotate(Tool.Destructive, true);

const MachinesJoinTool = Tool.make("machines_join", {
  ...shared,
  description:
    "Join this machine to the machine map with a one-time join code, for example K7QM-2XPA, that the owner makes in the portal (Add machine). portalUrl is the portal origin, for example https://t3.yarden-zamir.com; omit it to keep the portal of the machineMap setting. Use it once per machine, only with a code that the owner gave you. It saves the machine token in the server secret store, turns on the machineMap setting, saves the portal URL and connects. A used, expired or wrong code fails, and nothing changes. Needs a full-access caller; it does not need a map role. To leave the map, the owner uses Settings > Machines > Leave. The result is the machine map state of this machine: enabled, joined, connection and the machines it can reach. The connection comes up a moment after the call.",
  parameters: MachineMapJoinInput,
  success: MachineMapClientState,
}).annotate(Tool.Destructive, true);

const MachineToolCallTool = Tool.make("machine_tool_call", {
  ...shared,
  description:
    "Call a T3 Code MCP tool on another machine of the map, as this machine. `machine` is the id or name of that machine (names ignore case); `tool` is a tool name, for example t3_thread_list or t3_thread_launch; `input` is its JSON input. The tool runs on the other machine, with its side effects there. It needs an arrow from this machine to that machine with agent tools on and a level other than none; the level limits what the tool can do there (read allows only read tools). It does not need the portal: it uses the last map that this machine saved. Thread-bound tools need the threadId of a thread on the other machine. The machines_* tools and machine_tool_call do not work through it. The result is the result of the tool on the other machine.",
  parameters: Schema.Struct({
    machine: TrimmedNonEmptyString.annotate({
      description: "Id or name of the other machine, as machines_read lists it. Names ignore case.",
    }),
    tool: TrimmedNonEmptyString.annotate({
      description:
        "T3 Code MCP tool name on the other machine, for example t3_thread_list. `t3 tool list` prints the names.",
    }),
    input: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Unknown).annotate({
        description: "Input of that tool as a JSON object. Omit for a tool without input.",
      }),
    ),
  }),
  success: Schema.Unknown,
}).annotate(Tool.Destructive, true);

export const MachineMapToolkit = Toolkit.make(
  MachinesReadTool,
  MachinesResourcesTool,
  MachinesSetAccessTool,
  MachinesSetSettingTool,
  MachinesCommandTool,
  MachinesQueueCancelTool,
  MachinesUndoTool,
  MachinesPresetTool,
  MachinesJoinTool,
  MachineToolCallTool,
);

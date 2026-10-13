import { Tool } from "effect/ai";

import { AttachmentToolkit } from "./attachment/tools.ts";
import { DeviceToolkit } from "./device/tools.ts";
import { EnvironmentToolkit } from "./environment/tools.ts";
import { HtmlToolkit } from "./html/tools.ts";
import { MachineMapToolkit } from "./machineMap/tools.ts";
import { OrchestratorToolkit } from "./orchestrator/tools.ts";
import { PreviewToolkit } from "./preview/tools.ts";
import { PreviewControlsToolkit } from "./previewControls/tools.ts";
import { ProjectToolkit } from "./project/tools.ts";
import { PullRequestsToolkit } from "./pullRequests/tools.ts";
import { ThreadToolkit } from "./thread/tools.ts";
import { WorktreeToolkit } from "./worktree/tools.ts";

/**
 * Every toolkit that `/mcp` publishes, keyed by name. The server builds its
 * `/mcp` layer from one registration per key (`McpHttpServer.layer`), and the
 * `t3 tool` CLI lists and describes tools from the same record. Add a toolkit
 * here; the type checker then requires its server registration.
 */
export const McpToolkits = {
  orchestrator: OrchestratorToolkit,
  preview: PreviewToolkit,
  worktree: WorktreeToolkit,
  thread: ThreadToolkit,
  attachment: AttachmentToolkit,
  project: ProjectToolkit,
  environment: EnvironmentToolkit,
  previewControls: PreviewControlsToolkit,
  device: DeviceToolkit,
  pullRequests: PullRequestsToolkit,
  html: HtmlToolkit,
  // Fork: machine map (apps/machine-map/SPEC.md, MM-801).
  machineMap: MachineMapToolkit,
} as const;

export type McpToolkitName = keyof typeof McpToolkits;

export interface McpToolEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export const listMcpTools = (): ReadonlyArray<McpToolEntry> =>
  Object.values(McpToolkits)
    .flatMap((toolkit) =>
      Object.values(toolkit.tools).map((tool) => ({
        name: tool.name,
        description: Tool.getDescription(tool) ?? "",
        inputSchema: Tool.getJsonSchema(tool) as Record<string, unknown>,
      })),
    )
    .toSorted((left, right) => left.name.localeCompare(right.name));

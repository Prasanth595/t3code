import { Tool } from "effect/ai";

import { AttachmentToolkit } from "./attachment/tools.ts";
import { DeviceToolkit } from "./device/tools.ts";
import { EnvironmentToolkit } from "./environment/tools.ts";
import { HtmlToolkit } from "./html/tools.ts";
import { OrchestratorToolkit } from "./orchestrator/tools.ts";
import { PreviewToolkit } from "./preview/tools.ts";
import { PreviewControlsToolkit } from "./previewControls/tools.ts";
import { ProjectToolkit } from "./project/tools.ts";
import { PullRequestsToolkit } from "./pullRequests/tools.ts";
import { ThreadToolkit } from "./thread/tools.ts";
import { WorktreeToolkit } from "./worktree/tools.ts";

/**
 * Every toolkit that `/mcp` publishes. The `t3 tool` CLI and the catalog
 * tests read this list, so a toolkit added to the server must also be added
 * here.
 */
export const McpToolkits = [
  OrchestratorToolkit,
  PreviewToolkit,
  WorktreeToolkit,
  ThreadToolkit,
  AttachmentToolkit,
  ProjectToolkit,
  EnvironmentToolkit,
  PreviewControlsToolkit,
  DeviceToolkit,
  PullRequestsToolkit,
  HtmlToolkit,
] as const;

export interface McpToolEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export const listMcpTools = (): ReadonlyArray<McpToolEntry> =>
  McpToolkits.flatMap((toolkit) =>
    Object.values(toolkit.tools).map((tool) => ({
      name: tool.name,
      description: Tool.getDescription(tool) ?? "",
      inputSchema: Tool.getJsonSchema(tool) as Record<string, unknown>,
    })),
  ).toSorted((left, right) => left.name.localeCompare(right.name));

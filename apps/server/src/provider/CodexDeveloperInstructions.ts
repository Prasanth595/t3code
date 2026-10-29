import type { AgentInstructionOverrides } from "@t3tools/contracts";
import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import { resolveAgentInstructions } from "@t3tools/provider-core/server/orchestrationInstructions";

/** Codex silently truncates additionalContext values over 1,000 tokens, counted as UTF-8 bytes / 4. */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

export interface T3CodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | T3CodeToolAvailability,
): T3CodeToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/** Instructions for unavailable tools would steer the model away from its remaining automation. */
const toolInstructions = (
  availability: boolean | T3CodeToolAvailability,
  overrides?: AgentInstructionOverrides | null,
): string => {
  const resolved = resolveAgentInstructions(overrides);
  const tools = normalizeAvailability(availability);
  return [tools.browser ? resolved.browser : "", tools.device ? resolved.devices : ""]
    .filter(Boolean)
    .join("\n\n");
};

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  toolsAvailable: boolean | T3CodeToolAvailability = true,
  overrides?: AgentInstructionOverrides | null,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolInstructions(toolsAvailable, overrides);
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    ...Object.fromEntries(
      resolveAgentInstructions(overrides)
        .orchestrationSections.flatMap(splitContextValue)
        .map((section, index, sections) => [
          `t3_code_orchestration_${String(index + 1).padStart(Math.max(2, String(sections.length).length), "0")}`,
          { kind: "application" as const, value: section },
        ]),
    ),
    t3_code_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({ harness: "Codex", ...runtime }),
    },
    ...Object.fromEntries(
      splitContextValue(tools).map((value, index, sections) => [
        index === 0
          ? "t3_code_tools"
          : `t3_code_tools_${String(index + 1).padStart(Math.max(2, String(sections.length).length), "0")}`,
        { kind: "application" as const, value },
      ]),
    ),
  };
}

function splitContextValue(value: string): ReadonlyArray<string> {
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

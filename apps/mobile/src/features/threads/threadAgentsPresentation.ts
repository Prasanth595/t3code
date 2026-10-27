import {
  formatSubagentDisplayTitle,
  subagentDetailPreview,
} from "@t3tools/client-runtime/state/subagent-display";
import { getSelectionSpeedIcon } from "@t3tools/client-runtime/model-traits";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  formatModelSelectionEffort,
  REASONING_EFFORT_OPTION_IDS,
} from "@t3tools/client-runtime/state/thread-execution";
import type {
  OrchestrationV2Subagent,
  OrchestrationV2ThreadShell,
  ServerProvider,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";

const PROMPT_TITLE_LIMIT = 80;

export type SubagentRowTone = "working" | "completed" | "failed" | "stopped";

export interface SubagentRowPresentation {
  readonly title: string;
  readonly detail: string | null;
  readonly statusLabel: string;
  readonly tone: SubagentRowTone;
  readonly live: boolean;
  readonly canOpenThread: boolean;
}

function rowTitle(subagent: Pick<OrchestrationV2Subagent, "title" | "prompt">): string {
  const title = subagent.title?.trim();
  if (title) return formatSubagentDisplayTitle(title);
  const prompt = subagent.prompt.trim();
  if (prompt.length === 0) return "Subagent";
  return prompt.length > PROMPT_TITLE_LIMIT
    ? `${prompt.slice(0, PROMPT_TITLE_LIMIT - 3)}...`
    : prompt;
}

function rowTone(status: OrchestrationV2Subagent["status"]): SubagentRowTone {
  if (isActiveSubagentStatus(status)) return "working";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "stopped";
}

function rowStatusLabel(status: OrchestrationV2Subagent["status"]): string {
  switch (status) {
    case "pending":
    case "running":
      return "Working";
    case "waiting":
      return "Waiting";
    case "idle":
      return "Idle";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
  }
}

export function resolveSubagentRowPresentation(
  subagent: Pick<
    OrchestrationV2Subagent,
    "title" | "prompt" | "status" | "progress" | "result" | "childThreadId"
  >,
): SubagentRowPresentation {
  const live = isActiveSubagentStatus(subagent.status);
  return {
    title: rowTitle(subagent),
    detail: subagentDetailPreview(subagent),
    statusLabel: rowStatusLabel(subagent.status),
    tone: rowTone(subagent.status),
    live,
    canOpenThread: subagent.childThreadId !== null,
  };
}

export interface SubagentTraits {
  readonly effort: string | null;
  readonly speedIcon: "fast" | "ultrafast" | null;
}

/** Labels the selection the agent ran with, only when it matches the agent's model and instance. */
export function resolveSubagentTraits(input: {
  readonly subagent: Pick<
    OrchestrationV2Subagent,
    "model" | "providerInstanceId" | "origin" | "modelSelection"
  >;
  readonly provider?: Pick<ServerProvider, "driver" | "models"> | undefined;
  readonly childThread?:
    | Pick<OrchestrationV2ThreadShell, "providerInstanceId" | "modelSelection">
    | undefined;
}): SubagentTraits {
  const { subagent, provider } = input;
  const selection =
    subagent.modelSelection ??
    (subagent.origin === "app_owned" ? input.childThread?.modelSelection : undefined);
  const model = provider
    ? resolveSelectableModel(provider.driver, subagent.model, provider.models)
    : null;
  if (
    !provider ||
    !selection ||
    !model ||
    selection.instanceId !== subagent.providerInstanceId ||
    resolveSelectableModel(provider.driver, selection.model, provider.models) !== model
  ) {
    return { effort: null, speedIcon: null };
  }
  const resolved = { ...selection, model };
  return {
    effort: resolved.options?.some(
      (option) =>
        REASONING_EFFORT_OPTION_IDS.includes(option.id) && typeof option.value === "string",
    )
      ? formatModelSelectionEffort(resolved, provider.models)
      : null,
    speedIcon: getSelectionSpeedIcon(
      provider.driver,
      provider.models.find((candidate) => candidate.slug === model)?.capabilities
        ?.optionDescriptors ?? [],
      resolved,
    ),
  };
}

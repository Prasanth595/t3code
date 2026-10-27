import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderOptionDescriptor,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  isClaudeUltrathinkPrompt,
} from "@t3tools/shared/model";
import { REASONING_EFFORT_OPTION_IDS } from "./state/threadExecution.ts";

export const ULTRATHINK_PROMPT_PREFIX = "Ultrathink:\n";

export const REASONING_SELECT_DESCRIPTOR_IDS: ReadonlySet<string> = new Set([
  ...REASONING_EFFORT_OPTION_IDS,
  "thinking",
]);

export function replaceDescriptorCurrentValue(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  descriptorId: string,
  currentValue: string | boolean | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  return descriptors.map((descriptor) =>
    descriptor.id !== descriptorId
      ? descriptor
      : descriptor.type === "boolean"
        ? {
            ...descriptor,
            ...(typeof currentValue === "boolean" ? { currentValue } : {}),
          }
        : {
            ...descriptor,
            ...(typeof currentValue === "string" ? { currentValue } : {}),
          },
  );
}

export function getDescriptorStringValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | null,
  selection?: ModelSelection | null,
  reportedSelection?: ModelSelection | null,
): string | null {
  if (!descriptor) {
    return null;
  }
  const value = getProviderOptionCurrentValue(descriptor, selection, reportedSelection);
  return typeof value === "string" ? value : null;
}

export function selectableProviderOptionChoices(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
) {
  return descriptor.options;
}

export function getPromptControlledTraits(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  prompt: string,
  allowPromptInjectedEffort = true,
) {
  const primarySelectDescriptor =
    descriptors.find((descriptor) => descriptor.type === "select") ?? null;
  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    isClaudeUltrathinkPrompt(prompt);
  const ultrathinkInBodyText =
    ultrathinkPromptControlled && isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, ""));
  return { primarySelectDescriptor, ultrathinkPromptControlled, ultrathinkInBodyText };
}

export function getTraitSelectChange(
  selected: ReturnType<typeof getPromptControlledTraits> & {
    descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  },
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
  prompt: string,
  value: string,
) {
  if (!value) return null;
  if (descriptor.promptInjectedValues?.includes(value)) {
    return {
      prompt:
        prompt.trim().length === 0
          ? ULTRATHINK_PROMPT_PREFIX
          : applyClaudePromptEffortPrefix(prompt, "ultrathink"),
    };
  }
  const isPrimary = descriptor.id === selected.primarySelectDescriptor?.id;
  if (isPrimary && selected.ultrathinkInBodyText) return null;
  return {
    prompt:
      isPrimary && selected.ultrathinkPromptControlled
        ? prompt.replace(/^Ultrathink:\s*/i, "")
        : prompt,
    modelOptions: buildProviderOptionSelectionsFromDescriptors(
      replaceDescriptorCurrentValue(selected.descriptors, descriptor.id, value),
    ),
  };
}

export function buildTraitsTriggerDisplay(input: {
  provider: ProviderDriverKind;
  descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  primarySelectDescriptorId: string | null;
  ultrathinkPromptControlled: boolean;
  modelSelection?: ModelSelection | null;
  reportedModelSelection?: ModelSelection | null | undefined;
}): { label: string } {
  let fastModeFallbackLabel: string | null = null;
  let speedLabel: string | null = null;
  let reasoningLabelIndex = -1;
  const labels: Array<string> = [];
  for (const descriptor of input.descriptors) {
    if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
      speedLabel = descriptor.currentValue === true ? "Fast" : null;
      fastModeFallbackLabel = speedLabel ?? "Normal";
      continue;
    }
    if (
      input.provider === "codex" &&
      descriptor.id === "serviceTier" &&
      descriptor.type === "select"
    ) {
      const currentValue = getProviderOptionCurrentValue(descriptor);
      const fastTier = descriptor.options.find(({ label }) => label === "Fast");
      const ultrafastTier = descriptor.options.find(({ label }) => label === "Ultrafast");
      if (
        ((fastTier || ultrafastTier) && currentValue === "default") ||
        (fastTier && currentValue === fastTier.id) ||
        (ultrafastTier && currentValue === ultrafastTier.id)
      ) {
        speedLabel =
          ultrafastTier && currentValue === ultrafastTier.id
            ? "Ultrafast"
            : fastTier && currentValue === fastTier.id
              ? "Fast"
              : null;
        fastModeFallbackLabel =
          descriptor.options.find(({ id }) => id === currentValue)?.label ?? "Normal";
        continue;
      }
    }
    const label =
      input.ultrathinkPromptControlled && descriptor.id === input.primarySelectDescriptorId
        ? "Ultrathink"
        : descriptor.type === "boolean"
          ? `${descriptor.label} ${descriptor.currentValue === true ? "On" : "Off"}`
          : getProviderOptionCurrentLabel(
              descriptor,
              input.modelSelection,
              input.reportedModelSelection,
            );
    if (typeof label === "string" && label.length > 0) {
      if (
        reasoningLabelIndex === -1 &&
        descriptor.type === "select" &&
        REASONING_SELECT_DESCRIPTOR_IDS.has(descriptor.id)
      ) {
        reasoningLabelIndex = labels.length;
      }
      labels.push(label);
    }
  }

  if (labels.length === 0 && fastModeFallbackLabel !== null) {
    return { label: fastModeFallbackLabel };
  }
  if (speedLabel) {
    if (reasoningLabelIndex >= 0) {
      labels[reasoningLabelIndex] = `${labels[reasoningLabelIndex]} ${speedLabel}`;
    } else {
      labels.push(speedLabel);
    }
  }
  return { label: labels.join(" · ") };
}

function getTraitsSpeedDisplay(
  provider: ProviderDriverKind,
  descriptor: ProviderOptionDescriptor,
): { label: string; speedIcon: "fast" | "ultrafast" | null } | null {
  if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
    return {
      label: descriptor.currentValue === true ? "Fast" : "Normal",
      speedIcon: descriptor.currentValue === true ? "fast" : null,
    };
  }
  if (provider !== "codex" || descriptor.id !== "serviceTier" || descriptor.type !== "select") {
    return null;
  }
  const currentValue = getProviderOptionCurrentValue(descriptor);
  const fastTier = descriptor.options.find(({ label }) => label === "Fast");
  const ultrafastTier = descriptor.options.find(({ label }) => label === "Ultrafast");
  if (
    ((fastTier || ultrafastTier) && currentValue === "default") ||
    (fastTier && currentValue === fastTier.id) ||
    (ultrafastTier && currentValue === ultrafastTier.id)
  ) {
    return {
      label: descriptor.options.find(({ id }) => id === currentValue)?.label ?? "Normal",
      speedIcon:
        ultrafastTier && currentValue === ultrafastTier.id
          ? "ultrafast"
          : fastTier && currentValue === fastTier.id
            ? "fast"
            : null,
    };
  }
  return null;
}

export function getSelectionSpeedIcon(
  provider: ProviderDriverKind,
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  selection: ModelSelection | undefined,
): "fast" | "ultrafast" | null {
  for (const descriptor of descriptors) {
    const saved = selection?.options?.find((option) => option.id === descriptor.id)?.value;
    const savedDescriptor =
      descriptor.id === "fastMode" && descriptor.type === "boolean" && typeof saved === "boolean"
        ? { ...descriptor, currentValue: saved }
        : provider === "codex" &&
            descriptor.id === "serviceTier" &&
            descriptor.type === "select" &&
            typeof saved === "string" &&
            descriptor.options.some((option) => option.id === saved)
          ? { ...descriptor, currentValue: saved }
          : null;
    const display = savedDescriptor && getTraitsSpeedDisplay(provider, savedDescriptor);
    if (display) return display.speedIcon;
  }
  return null;
}

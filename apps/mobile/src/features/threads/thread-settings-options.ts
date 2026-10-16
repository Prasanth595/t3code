import { RuntimeMode, type ProviderOptionDescriptor } from "@t3tools/contracts";

import type { AppSymbolName } from "../../components/ui/AppSymbol";

/**
 * Prompt-injected values (ultrathink and friends) are filtered from the
 * descriptor metadata; ultracode is a real option but a workflow trigger, not a
 * reasoning level.
 */
const HIDDEN_EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["ultracode"]);

interface RuntimeModeDetails {
  readonly label: string;
  readonly description: string;
  readonly icon: AppSymbolName;
}

/** Icons match the web composer's runtime mode picker. */
export const RUNTIME_MODE_DETAILS: Record<RuntimeMode, RuntimeModeDetails> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: "lock",
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: "pencil",
  },
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
    icon: "sparkles",
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: "lock.open",
  },
};

export const RUNTIME_MODE_CHOICES: ReadonlyArray<
  RuntimeModeDetails & { readonly mode: RuntimeMode }
> = RuntimeMode.literals.map((mode) => ({ mode, ...RUNTIME_MODE_DETAILS[mode] }));

export function runtimeModeChoicesForSupportedModes(
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
) {
  return supportedRuntimeModes && supportedRuntimeModes.length > 0
    ? RUNTIME_MODE_CHOICES.filter((choice) => supportedRuntimeModes.includes(choice.mode))
    : RUNTIME_MODE_CHOICES;
}

export function compatibleRuntimeModeForChoices(
  runtimeMode: RuntimeMode,
  choices: ReadonlyArray<{ readonly mode: RuntimeMode }>,
): RuntimeMode {
  return choices.some((choice) => choice.mode === runtimeMode)
    ? runtimeMode
    : (choices[0]?.mode ?? runtimeMode);
}

export function selectableChoices(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
) {
  const injected = new Set(descriptor.promptInjectedValues ?? []);
  return descriptor.options.filter(
    (option) => !injected.has(option.id) && !HIDDEN_EFFORT_OPTION_IDS.has(option.id),
  );
}

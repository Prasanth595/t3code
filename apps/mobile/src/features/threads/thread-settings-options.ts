import type { RuntimeMode } from "@t3tools/contracts";

export const RUNTIME_MODE_CHOICES: ReadonlyArray<{
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "approval-required",
    label: "Supravegheat",
    description: "Întreabă înainte de comenzi și modificări de fișiere.",
  },
  {
    mode: "auto-accept-edits",
    label: "Acceptă automat editările",
    description: "Aprobă automat editările, întreabă înainte de alte acțiuni.",
  },
  {
    mode: "auto",
    label: "Automat",
    description: "Furnizorii compatibili aprobă acțiunile de rutină; ceilalți tot întreabă.",
  },
  {
    mode: "full-access",
    label: "Acces complet",
    description: "Permite comenzi și editări fără confirmare.",
  },
];

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

export { selectableProviderOptionChoices as selectableChoices } from "@t3tools/client-runtime/model-traits";

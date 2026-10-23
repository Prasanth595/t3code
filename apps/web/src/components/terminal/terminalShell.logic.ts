import type { TerminalShellProfile, TerminalShellSetting } from "@t3tools/contracts";

/** `null` and "auto" both mean the built-in fallback chain. */
export function shellSettingToSelectValue(setting: TerminalShellSetting | null): string {
  if (setting === null || setting === "auto") return "auto";
  return setting;
}

export function shellSettingLabel(
  setting: TerminalShellSetting | null,
  shells: readonly TerminalShellProfile[],
): string {
  if (setting === null || setting === "auto") return "Automatic";
  return shells.find((shell) => shell.id === setting)?.label ?? setting;
}

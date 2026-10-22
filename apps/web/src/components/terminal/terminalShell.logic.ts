import type { TerminalShellProfile, TerminalShellSetting } from "@t3tools/contracts";

export const CUSTOM_SHELL_SELECT_VALUE = "__custom__";

type CustomShell = Extract<TerminalShellSetting, { readonly command: string }>;

export function isCustomShell(setting: TerminalShellSetting | null): setting is CustomShell {
  return typeof setting === "object" && setting !== null;
}

export function parseShellArgs(text: string): string[] {
  return text.split(/\s+/).filter((arg) => arg.length > 0);
}

export function formatShellArgs(args: readonly string[] | undefined): string {
  return (args ?? []).join(" ");
}

export function buildCustomShell(commandText: string, argsText: string): CustomShell | null {
  const command = commandText.trim();
  if (command.length === 0) return null;
  const args = parseShellArgs(argsText);
  return args.length > 0 ? { command, args } : { command };
}

/** `null` and "auto" both mean the built-in fallback chain. */
export function shellSettingToSelectValue(setting: TerminalShellSetting | null): string {
  if (setting === null || setting === "auto") return "auto";
  return isCustomShell(setting) ? CUSTOM_SHELL_SELECT_VALUE : setting;
}

export function shellSettingLabel(
  setting: TerminalShellSetting | null,
  shells: readonly TerminalShellProfile[],
): string {
  if (setting === null || setting === "auto") return "Automatic";
  if (isCustomShell(setting)) return setting.command;
  return shells.find((shell) => shell.id === setting)?.label ?? setting;
}

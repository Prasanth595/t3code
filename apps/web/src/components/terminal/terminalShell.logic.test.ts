import { describe, expect, it } from "vite-plus/test";

import {
  buildCustomShell,
  CUSTOM_SHELL_SELECT_VALUE,
  parseShellArgs,
  shellSettingLabel,
  shellSettingToSelectValue,
} from "./terminalShell.logic";

describe("terminal shell settings", () => {
  it("splits custom args on any whitespace", () => {
    expect(parseShellArgs("  -NoLogo \t -l\n")).toEqual(["-NoLogo", "-l"]);
    expect(parseShellArgs("   ")).toEqual([]);
  });

  it("builds a custom shell and omits empty args", () => {
    expect(buildCustomShell("  /usr/bin/fish ", "")).toEqual({ command: "/usr/bin/fish" });
    expect(buildCustomShell("/bin/zsh", "-l -i")).toEqual({
      command: "/bin/zsh",
      args: ["-l", "-i"],
    });
    expect(buildCustomShell("  ", "-l")).toBeNull();
  });

  it("maps settings to select values", () => {
    expect(shellSettingToSelectValue(null)).toBe("auto");
    expect(shellSettingToSelectValue("auto")).toBe("auto");
    expect(shellSettingToSelectValue("pwsh")).toBe("pwsh");
    expect(shellSettingToSelectValue({ command: "/bin/fish" })).toBe(CUSTOM_SHELL_SELECT_VALUE);
  });

  it("labels a profile id by its detected label and falls back to the id", () => {
    const shells = [{ id: "pwsh", label: "PowerShell 7", command: "pwsh.exe", args: [] }];
    expect(shellSettingLabel("pwsh", shells)).toBe("PowerShell 7");
    expect(shellSettingLabel("gone", shells)).toBe("gone");
    expect(shellSettingLabel(null, shells)).toBe("Automatic");
    expect(shellSettingLabel({ command: "/bin/fish" }, shells)).toBe("/bin/fish");
  });
});

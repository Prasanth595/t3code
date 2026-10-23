import { describe, expect, it } from "vite-plus/test";

import { shellSettingLabel, shellSettingToSelectValue } from "./terminalShell.logic";

describe("terminal shell settings", () => {
  it("maps settings to select values", () => {
    expect(shellSettingToSelectValue(null)).toBe("auto");
    expect(shellSettingToSelectValue("auto")).toBe("auto");
    expect(shellSettingToSelectValue("pwsh")).toBe("pwsh");
  });

  it("labels a profile id by its detected label and falls back to the id", () => {
    const shells = [{ id: "pwsh", label: "PowerShell 7", command: "pwsh.exe", args: [] }];
    expect(shellSettingLabel("pwsh", shells)).toBe("PowerShell 7");
    expect(shellSettingLabel("gone", shells)).toBe("gone");
    expect(shellSettingLabel(null, shells)).toBe("Automatic");
  });
});

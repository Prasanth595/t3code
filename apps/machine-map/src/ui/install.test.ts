import { describe, expect, it } from "vite-plus/test";

import { installCommand } from "./install.ts";

const SCRIPTS = "https://raw.githubusercontent.com/Yarden-zamir/t3code/main/scripts/fork-install";

describe("installCommand", () => {
  it("pipes install.sh to bash with the join code on Linux and macOS", () => {
    for (const target of ["linux", "mac"] as const) {
      expect(installCommand(target, "K7QM-2XPA")).toBe(
        `curl -fsSL ${SCRIPTS}/install.sh | bash -s -- --join K7QM-2XPA`,
      );
    }
  });

  it("runs install.ps1 as a script block with the join code on Windows", () => {
    expect(installCommand("windows", "K7QM-2XPA")).toBe(
      `& ([scriptblock]::Create((irm ${SCRIPTS}/install.ps1))) -Join K7QM-2XPA`,
    );
  });
});

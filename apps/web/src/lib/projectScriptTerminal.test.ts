import { describe, expect, it } from "vite-plus/test";

import { resolveProjectScriptTerminal } from "./projectScriptTerminal";

const base = {
  drawerTerminalIds: [],
  activeTerminalId: "",
  panelTerminalIds: new Set<string>(),
  allocatableTerminalIds: [],
  runningTerminalIds: [],
  preferNewTerminal: false,
};

describe("resolveProjectScriptTerminal", () => {
  it("allocates a new drawer terminal instead of reusing an idle right-panel terminal", () => {
    expect(
      resolveProjectScriptTerminal({
        ...base,
        panelTerminalIds: new Set(["term-1"]),
        allocatableTerminalIds: ["term-1"],
      }),
    ).toEqual({ terminalId: "term-2", isNew: true });
  });

  it("never reuses a panel terminal left in stale drawer state", () => {
    expect(
      resolveProjectScriptTerminal({
        ...base,
        drawerTerminalIds: ["term-1"],
        activeTerminalId: "term-1",
        panelTerminalIds: new Set(["term-1"]),
        allocatableTerminalIds: ["term-1"],
      }),
    ).toEqual({ terminalId: "term-2", isNew: true });
  });

  it("reuses the active idle drawer terminal", () => {
    expect(
      resolveProjectScriptTerminal({
        ...base,
        drawerTerminalIds: ["term-1", "term-2"],
        activeTerminalId: "term-2",
        allocatableTerminalIds: ["term-1", "term-2"],
      }),
    ).toEqual({ terminalId: "term-2", isNew: false });
  });

  it("allocates a new terminal when the drawer terminal is busy", () => {
    expect(
      resolveProjectScriptTerminal({
        ...base,
        drawerTerminalIds: ["term-1"],
        activeTerminalId: "term-1",
        panelTerminalIds: new Set(["term-2"]),
        allocatableTerminalIds: ["term-1", "term-2"],
        runningTerminalIds: ["term-1"],
      }),
    ).toEqual({ terminalId: "term-3", isNew: true });
  });
});

import { describe, expect, it } from "vite-plus/test";

import { isElectronAccelerator } from "./electronAccelerator.ts";

describe("isElectronAccelerator", () => {
  it("accepts keys Electron registers, with or without modifiers", () => {
    for (const accelerator of ["F17", "f24", "Alt+Space", "CmdOrCtrl+Shift+K", "`", "Super+Plus"]) {
      expect(isElectronAccelerator(accelerator), accelerator).toBe(true);
    }
  });

  it("rejects keys Electron cannot convert, and malformed chords", () => {
    for (const accelerator of [
      "§",
      "Section",
      "F25",
      "F017",
      "Alt+",
      "Shift",
      "Hyper+K",
      "K+Alt",
      "",
    ]) {
      expect(isElectronAccelerator(accelerator), accelerator).toBe(false);
    }
  });
});

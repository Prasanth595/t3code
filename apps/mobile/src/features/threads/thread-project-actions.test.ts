import type { ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { replaceProjectAction } from "./thread-project-actions";

const setup: ProjectScript = {
  id: "setup",
  name: "Setup",
  command: "vp i",
  icon: "configure",
  runOnWorktreeCreate: true,
  async: false,
};
const settle: ProjectScript = {
  id: "settle",
  name: "Settle",
  command: "vp test",
  icon: "test",
  runOnWorktreeCreate: false,
  runOnSettle: true,
};
const build: ProjectScript = {
  id: "build",
  name: "Build",
  command: "vp build",
  icon: "build",
  runOnWorktreeCreate: false,
  previewUrl: "http://localhost:3000",
  autoOpenPreview: true,
};

describe("drawer project actions", () => {
  it("keeps setup and settle roles unique when an action claims them", () => {
    const saved = { ...build, runOnWorktreeCreate: true, runOnSettle: true };
    const next = replaceProjectAction([setup, settle, build], saved);
    expect(next.find((script) => script.runOnWorktreeCreate)?.id).toBe("build");
    expect(next.filter((script) => script.runOnWorktreeCreate)).toHaveLength(1);
    expect(next.filter((script) => script.runOnSettle)).toHaveLength(1);
    expect(next.find((script) => script.id === "build")).toEqual(saved);
    expect(setup.runOnWorktreeCreate).toBe(true);
    expect(settle.runOnSettle).toBe(true);
  });

  it("edits in place without losing unrelated action settings", () => {
    const saved = { ...setup, command: "vp i --frozen-lockfile" };
    expect(replaceProjectAction([setup, build], saved)).toEqual([saved, build]);
  });

  it("adds a new action without changing existing actions", () => {
    expect(replaceProjectAction([setup], build)).toEqual([setup, build]);
  });
});

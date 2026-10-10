import { DEFAULT_SERVER_SETTINGS, ProjectId, type ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  movePinnedScriptId,
  resolvePinnedScripts,
  togglePinnedScriptId,
} from "./projectScripts.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

function script(id: string): ProjectScript {
  return { id, name: id, command: `run ${id}`, icon: "play", runOnWorktreeCreate: false };
}

const scripts = [script("dev"), script("test"), script("lint")];

describe("pinned scripts", () => {
  it("resolves pins in pin order and drops pins whose script no longer exists", () => {
    expect(resolvePinnedScripts(scripts, ["lint", "gone", "dev", "lint"]).map((s) => s.id)).toEqual(
      ["lint", "dev"],
    );
  });

  it("pins at the end, unpins, and never pins an unknown script", () => {
    expect(togglePinnedScriptId(scripts, ["dev"], "lint")).toEqual(["dev", "lint"]);
    expect(togglePinnedScriptId(scripts, ["dev", "lint"], "dev")).toEqual(["lint"]);
    expect(togglePinnedScriptId(scripts, ["dev", "gone"], "missing")).toEqual(["dev"]);
  });

  it("moves a pin and drops stale ids from the stored order", () => {
    expect(movePinnedScriptId(scripts, ["dev", "gone", "test", "lint"], "lint", 0)).toEqual([
      "lint",
      "dev",
      "test",
    ]);
    expect(movePinnedScriptId(scripts, ["dev", "test"], "lint", 0)).toEqual(["dev", "test"]);
  });

  it("persists a new pin order through a settings patch", () => {
    const projectId = ProjectId.make("project-1");
    const pinned = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      globalScripts: scripts,
      pinnedGlobalScriptIds: ["dev", "test", "lint"],
      pinnedProjectScriptIds: { [projectId]: ["dev", "test"] },
    });
    const reordered = applyServerSettingsPatch(pinned, {
      pinnedGlobalScriptIds: movePinnedScriptId(
        pinned.globalScripts,
        pinned.pinnedGlobalScriptIds,
        "lint",
        0,
      ),
      pinnedProjectScriptIds: { [projectId]: ["test", "dev"] },
    });
    expect(reordered.pinnedGlobalScriptIds).toEqual(["lint", "dev", "test"]);
    expect(reordered.pinnedProjectScriptIds[projectId]).toEqual(["test", "dev"]);
    expect(
      applyServerSettingsPatch(reordered, { pinnedProjectScriptIds: { [projectId]: null } })
        .pinnedProjectScriptIds,
    ).toEqual({});
  });

  it("leaves settings unchanged when the pin and global script keys are absent", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { defaultAutoPull: true });
    expect(next.globalScripts).toEqual([]);
    expect(next.pinnedGlobalScriptIds).toEqual([]);
    expect(next.pinnedProjectScriptIds).toEqual({});
    expect(resolvePinnedScripts(scripts, next.pinnedGlobalScriptIds)).toEqual([]);
  });
});

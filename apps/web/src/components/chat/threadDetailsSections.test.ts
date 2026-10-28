import { describe, expect, it } from "vite-plus/test";

import { RIGHT_PANEL_SECTIONS, resolveThreadDetailsSections } from "./threadDetailsSections";

const allAvailable = {
  environment: true,
  "open-in-editor": true,
  "project-scripts": true,
  branch: true,
  "git-actions": true,
  changes: true,
  servers: true,
  automations: true,
  lineage: true,
};

describe("resolveThreadDetailsSections", () => {
  it("shows every available section by default", () => {
    expect(resolveThreadDetailsSections([], allAvailable)).toEqual({
      shown: allAvailable,
      workspace: true,
      versionControl: true,
    });
  });

  it("drops the workspace and version control groups when only lineage is kept", () => {
    const hidden = RIGHT_PANEL_SECTIONS.map(({ id }) => id).filter((id) => id !== "lineage");

    expect(resolveThreadDetailsSections(hidden, allAvailable)).toEqual({
      shown: {
        environment: false,
        "open-in-editor": false,
        "project-scripts": false,
        branch: false,
        "git-actions": false,
        changes: false,
        servers: false,
        automations: false,
        lineage: true,
      },
      workspace: false,
      versionControl: false,
    });
  });

  it("keeps a group while one of its sections is still shown", () => {
    const result = resolveThreadDetailsSections(["branch", "git-actions"], allAvailable);

    expect(result.versionControl).toBe(true);
    expect(result.shown.changes).toBe(true);
  });

  it("never shows a section that is unavailable even when it is not hidden", () => {
    const result = resolveThreadDetailsSections(["changes"], {
      ...allAvailable,
      branch: false,
      "git-actions": false,
    });

    expect(result.versionControl).toBe(false);
  });
});

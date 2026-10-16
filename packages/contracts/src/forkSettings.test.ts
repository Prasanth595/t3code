import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("ClientSettings sidebar owner filter", () => {
  it("shows every owner by default and keeps the operator and the entry for projects without an owner", () => {
    expect(decodeClientSettings({}).sidebarOwnerFilter).toEqual({ operator: "is", owners: [] });
    const filter = { operator: "is_not", owners: ["qlik-trial", null] };
    const saved = encodeClientSettings(decodeClientSettings({ sidebarOwnerFilter: filter }));
    expect(decodeClientSettings(saved).sidebarOwnerFilter).toEqual(filter);
    expect(decodeClientSettingsPatch({ sidebarOwnerFilter: filter }).sidebarOwnerFilter).toEqual(
      filter,
    );
    expect(() =>
      decodeClientSettingsPatch({ sidebarOwnerFilter: { operator: "contains", owners: [] } }),
    ).toThrow();
  });
});

describe("ClientSettings snooze quick options", () => {
  it("keeps the built-in options by default and round-trips a saved list", () => {
    expect(decodeClientSettings({}).snoozeQuickOptions).toBeNull();
    const options = [
      { _tag: "in", amount: 45, unit: "minutes" },
      { _tag: "at", day: "friday", time: { hour: 16, minute: 30 }, label: "Weekend" },
    ];
    const saved = encodeClientSettings(decodeClientSettings({ snoozeQuickOptions: options }));
    expect(decodeClientSettings(saved).snoozeQuickOptions).toEqual(options);
    expect(decodeClientSettingsPatch({ snoozeQuickOptions: null }).snoozeQuickOptions).toBeNull();
  });

  it.each([
    { _tag: "in", amount: 0, unit: "hours" },
    { _tag: "in", amount: 1, unit: "weeks" },
    { _tag: "at", day: "today", time: { hour: 24, minute: 0 } },
    { _tag: "at", day: "someday", time: { hour: 9, minute: 0 } },
  ])("rejects the option %o", (option) => {
    expect(() => decodeClientSettingsPatch({ snoozeQuickOptions: [option] })).toThrow();
  });
});

describe("ServerSettings agent session import limits", () => {
  it("defaults to a 30 day window and 200 messages", () => {
    expect(decodeServerSettings({})).toMatchObject({
      agentSessionImportWindowDays: 30,
      agentSessionImportMaxMessages: 200,
    });
  });

  it("accepts the range bounds", () => {
    expect(
      decodeServerSettingsPatch({
        agentSessionImportWindowDays: 3650,
        agentSessionImportMaxMessages: 1,
      }),
    ).toEqual({ agentSessionImportWindowDays: 3650, agentSessionImportMaxMessages: 1 });
  });

  it.each([0, -1, 1.5, 3651])("rejects an import window of %s days", (value) => {
    expect(() => decodeServerSettings({ agentSessionImportWindowDays: value })).toThrow();
    expect(() => decodeServerSettingsPatch({ agentSessionImportWindowDays: value })).toThrow();
  });

  it.each([0, -1, 2.5, 10_001, null])("rejects a message limit of %s", (value) => {
    expect(() => decodeServerSettings({ agentSessionImportMaxMessages: value })).toThrow();
    expect(() => decodeServerSettingsPatch({ agentSessionImportMaxMessages: value })).toThrow();
  });
});

describe("ServerSettings.pullRequestWatchRemarkFilter", () => {
  it("filters nothing by default and reads a saved filter", () => {
    expect(decodeServerSettings({}).pullRequestWatchRemarkFilter).toEqual({
      authorAssociations: [],
      authorLogins: [],
      agentMarker: "",
    });
    expect(
      decodeServerSettings({
        pullRequestWatchRemarkFilter: {
          authorAssociations: ["OWNER", "MEMBER", "COLLABORATOR"],
          agentMarker: " <!-- agent --> ",
        },
      }).pullRequestWatchRemarkFilter,
    ).toEqual({
      authorAssociations: ["OWNER", "MEMBER", "COLLABORATOR"],
      authorLogins: [],
      agentMarker: "<!-- agent -->",
    });
    expect(() =>
      decodeServerSettingsPatch({
        pullRequestWatchRemarkFilter: { authorAssociations: ["ADMIN"] },
      }),
    ).toThrow();
  });
});

describe("ServerSettings global scripts and pins", () => {
  const script = {
    id: "lint",
    name: "Lint",
    command: "vp lint",
    icon: "lint",
    runOnWorktreeCreate: false,
  };

  it("defaults to no global scripts and no pins", () => {
    const settings = decodeServerSettings({});
    expect(settings.globalScripts).toEqual([]);
    expect(settings.pinnedGlobalScriptIds).toEqual([]);
    expect(settings.pinnedProjectScriptIds).toEqual({});
  });

  it("accepts global scripts and pin entries", () => {
    const settings = decodeServerSettings({
      globalScripts: [script],
      pinnedGlobalScriptIds: ["lint"],
      pinnedProjectScriptIds: { "project-1": ["dev", "test"] },
    });
    expect(settings.globalScripts).toEqual([script]);
    expect(settings.pinnedProjectScriptIds["project-1" as ProjectId]).toEqual(["dev", "test"]);
  });

  it("rejects malformed global scripts and pin entries", () => {
    expect(() => decodeServerSettings({ globalScripts: [{ ...script, command: " " }] })).toThrow();
    expect(() => decodeServerSettings({ pinnedGlobalScriptIds: [""] })).toThrow();
    expect(() =>
      decodeServerSettings({ pinnedProjectScriptIds: { "project-1": "dev" } }),
    ).toThrow();
  });

  it("lets a patch remove one project's pins with null", () => {
    expect(
      decodeServerSettingsPatch({ pinnedProjectScriptIds: { "project-1": null } })
        .pinnedProjectScriptIds,
    ).toEqual({ "project-1": null });
  });
});

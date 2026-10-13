import { describe, expect, it } from "vite-plus/test";

import { knownKeys, settingControl, settingProblem } from "./settingControls.ts";

describe("settingControl (MM-407)", () => {
  it("picks the editor from the T3 settings schema", () => {
    expect(settingControl("client", "inAppNotificationsEnabled")).toEqual({ _tag: "switch" });
    expect(settingControl("client", "chatWidth")._tag).toBe("choice");
    expect(settingControl("server", "worktreesDirectory")).toEqual({ _tag: "text" });
    expect(settingControl("server", "favorites")).toEqual({ _tag: "json" });
    expect(settingControl("server", "notASetting")).toEqual({ _tag: "json" });
    expect(knownKeys("client")).toContain("chatWidth");
  });

  it("checks values with the same schema", () => {
    expect(settingProblem("client", "inAppNotificationsEnabled", true)).toBeNull();
    expect(settingProblem("client", "inAppNotificationsEnabled", "yes")).not.toBeNull();
    expect(settingProblem("server", "notASetting", { any: 1 })).toBeNull();
  });
});

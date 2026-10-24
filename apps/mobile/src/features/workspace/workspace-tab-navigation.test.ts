import { describe, expect, it } from "vite-plus/test";

import { workspaceSelectionsIn, workspaceTabNavigationState } from "./workspace-tab-navigation";

const home = { key: "home", name: "Home" };
const thread = {
  key: "thread",
  name: "Thread",
  params: { environmentId: "env", threadId: "thread-a" },
};
const pullRequest = {
  key: "pr",
  name: "PullRequest",
  params: { environmentId: "env", projectId: "project", repository: "o/r", number: 7 },
};
const settings = { key: "settings", name: "Settings" };
const names = (state: { routes: readonly { name: string }[] }) =>
  state.routes.map((route) => route.name);

describe("workspace tab selections", () => {
  it("remembers the chat, pull request and Settings page each tab showed", () => {
    const afterThread = workspaceSelectionsIn([home, thread], {});
    expect(afterThread.threads).toEqual(thread.params);
    const afterPullRequest = workspaceSelectionsIn([home, pullRequest], afterThread);
    expect(afterPullRequest).toMatchObject({
      threads: thread.params,
      pullRequests: pullRequest.params,
    });
    const afterSettings = workspaceSelectionsIn(
      [home, settings, { key: "appearance", name: "SettingsAppearance" }],
      afterPullRequest,
    );
    expect(afterSettings.settings).toBe("SettingsAppearance");
    expect(workspaceSelectionsIn([home, thread], afterSettings)).toBe(afterSettings);
  });

  it("opens a tab with its remembered page when there are columns, and on its list otherwise", () => {
    const state = { routes: [home, thread] };
    const selections = { threads: thread.params, pullRequests: pullRequest.params };
    expect(names(workspaceTabNavigationState(state, "pullRequests", selections, true))).toEqual([
      "Home",
      "PullRequest",
    ]);
    expect(names(workspaceTabNavigationState(state, "pullRequests", selections, false))).toEqual([
      "Home",
    ]);
    expect(names(workspaceTabNavigationState(state, "settings", selections, true))).toEqual([
      "Home",
      "Settings",
      "SettingsEnvironments",
    ]);
    expect(names(workspaceTabNavigationState(state, "settings", selections, false))).toEqual([
      "Home",
      "Settings",
    ]);
  });
});

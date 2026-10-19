import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadRouteStillShows } from "./thread-title-delete-navigation";

const deleted = { environmentId: EnvironmentId.make("env-a"), id: ThreadId.make("thread-a") };

function navigation(
  params: object | undefined,
  options: { readonly focused?: boolean; readonly removed?: boolean } = {},
) {
  return {
    isFocused: () => options.focused ?? true,
    getState: () =>
      options.removed
        ? undefined
        : { index: 1, routes: [{ params: undefined }, { params }] as const },
  };
}

describe("threadRouteStillShows", () => {
  it("leaves only while the focused route still shows the deleted thread", () => {
    expect(
      threadRouteStillShows(navigation({ environmentId: "env-a", threadId: "thread-a" }), deleted),
    ).toBe(true);
    expect(
      threadRouteStillShows(
        navigation({ environmentId: ["env-a"], threadId: ["thread-a"] }),
        deleted,
      ),
    ).toBe(true);
  });

  it("keeps a newer selection in the same or another environment", () => {
    expect(
      threadRouteStillShows(navigation({ environmentId: "env-a", threadId: "thread-b" }), deleted),
    ).toBe(false);
    expect(
      threadRouteStillShows(navigation({ environmentId: "env-b", threadId: "thread-a" }), deleted),
    ).toBe(false);
  });

  it("stays put after the user leaves the thread route", () => {
    const params = { environmentId: "env-a", threadId: "thread-a" };
    expect(threadRouteStillShows(navigation(params, { focused: false }), deleted)).toBe(false);
    expect(threadRouteStillShows(navigation(params, { removed: true }), deleted)).toBe(false);
  });
});

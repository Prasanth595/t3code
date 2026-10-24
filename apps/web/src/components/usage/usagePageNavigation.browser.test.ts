import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import { Route as UsageRoute } from "../../routes/usage";
import * as preferences from "./usagePagePreferences";

vi.mock("./UsagePage", () => ({ UsagePage: () => null }));

function savedPreferences(value: preferences.UsagePagePreferences) {
  const key = "t3code:usage-page-preferences:v1";
  const previous = localStorage.getItem(key);
  preferences.saveUsagePagePreferences(value);
  return {
    [Symbol.dispose]() {
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
    },
  };
}

function createUsageRouter(initialEntry: string) {
  const root = createRootRoute();
  const usage = createRoute({
    getParentRoute: () => root,
    path: "usage",
    validateSearch: UsageRoute.options.validateSearch,
    beforeLoad: (options) =>
      UsageRoute.options.beforeLoad?.({
        ...options,
        context: { authGateState: { status: "hosted-static" } },
      }),
  });
  return createRouter({
    routeTree: root.addChildren([usage]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

describe("Usage route history", () => {
  it("pins the entry view without creating a second visit, even when preferences later change", async () => {
    using _saved = savedPreferences({ metric: "limits", windowDays: 30 });
    const router = createUsageRouter("/usage");
    await router.navigate({ href: "/usage", replace: true });
    expect(router.state.location.search).toEqual({ metric: "limits", windowDays: 30 });
    expect(router.history.length).toBe(1);

    preferences.saveUsagePagePreferences({ metric: "tokens", windowDays: 7 });
    await router.navigate({ to: "/usage", search: { metric: "tokens", windowDays: 7 } });
    router.history.back();
    await router.load();
    expect(router.state.location.search).toEqual({ metric: "limits", windowDays: 30 });
  });

  it("keeps an explicit metric and repairs an invalid period from saved preferences", async () => {
    using _saved = savedPreferences({ metric: "limits", windowDays: 7 });
    const router = createUsageRouter("/usage?metric=cost&windowDays=999");
    await router.navigate({ href: "/usage?metric=cost&windowDays=999", replace: true });
    expect(router.state.location.search).toEqual({ metric: "cost", windowDays: 7 });
    expect(router.history.length).toBe(1);
  });
});

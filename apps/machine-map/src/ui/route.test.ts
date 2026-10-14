import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_ROUTE, formatRoute, parseRoute, type Route } from "./route.ts";

describe("routes (MM-1106)", () => {
  const routes: Array<Route> = [
    { view: "map", selection: { _tag: "none" } },
    { view: "map", selection: { _tag: "machine", id: "mac-1a2b" } },
    { view: "table", selection: { _tag: "arrow", from: "mac", to: "vps" } },
    { view: "history", selection: { _tag: "revision", revision: 42 } },
    { view: "inbox", selection: { _tag: "proposal", id: "p/1" } },
    { view: "settings", selection: { _tag: "setting", scope: "client", key: "theme name" } },
    { view: "queue", selection: { _tag: "command", id: "c1" } },
    { view: "tasks", selection: { _tag: "machine", id: "vps-7c9d" } },
  ];

  it("round-trips every view and selection", () => {
    for (const route of routes) expect(parseRoute(formatRoute(route))).toEqual(route);
  });

  it("opens the default route for broken links", () => {
    expect(parseRoute("")).toEqual(DEFAULT_ROUTE);
    expect(parseRoute("#/nowhere/machine/x")).toEqual(DEFAULT_ROUTE);
    expect(parseRoute("#/history/revision/abc")).toEqual({
      view: "history",
      selection: { _tag: "none" },
    });
    expect(parseRoute("#/map/machine/%E0%A4%A")).toEqual({
      view: "map",
      selection: { _tag: "none" },
    });
  });
});

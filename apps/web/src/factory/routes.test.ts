import { describe, expect, it } from "vite-plus/test";

import tree from "../routeTree.gen.ts?raw";

// Building the real router in a unit test pulls in the whole app (workers, browser globals), so
// this pins the generated tree's structure: the run route must not nest under the runs list,
// which renders no Outlet and would show the list for a run URL.

describe("factory routes", () => {
  it("hangs the run route off the root route, not the runs list", () => {
    const update =
      /const FactoryRunIdRoute = FactoryRunIdRouteImport\.update\(\{[\s\S]*?as any\)/.exec(tree);
    expect(update?.[0]).toContain("getParentRoute: () => rootRouteImport");
    expect(tree).not.toContain("FactoryRouteChildren");
  });

  it("keeps /factory/$runId as the run route's full path", () => {
    expect(tree).toMatch(/'\/factory_\/\$runId': \{[^}]*fullPath: '\/factory\/\$runId'/);
  });
});

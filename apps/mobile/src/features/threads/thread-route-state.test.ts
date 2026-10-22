import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";
import { isDraftThreadRoute, submittedThreadParams } from "./thread-route-state";

const requireNavigation = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
);
const { StackRouter, CommonActions } = requireNavigation("@react-navigation/routers") as {
  StackRouter: typeof import("@react-navigation/native").StackRouter;
  CommonActions: typeof import("@react-navigation/native").CommonActions;
};

describe("draft thread handoff", () => {
  it("submits in the existing route and stops suppressing the live thread selection", () => {
    const router = StackRouter({});
    const options = { routeNames: ["Home", "Thread"], routeParamList: {}, routeGetIdList: {} };
    const initial = router.getInitialState(options);
    const draft = router.getStateForAction(
      initial,
      CommonActions.navigate("Thread", { draft: { projectId: "project" } }),
      options,
    )!;
    if (!draft || draft.stale !== false) throw new Error("Draft route was not initialized");
    expect(isDraftThreadRoute(draft.routes.at(-1))).toBe(true);
    const submitted = router.getStateForAction(
      draft,
      CommonActions.setParams(submittedThreadParams("environment", "thread")),
      options,
    )!;
    expect(submitted.routes.map((route) => route.key)).toEqual(
      draft.routes.map((route) => route.key),
    );
    expect(submitted.index).toBe(draft.index);
    expect(submitted.routes.at(-1)?.params).toEqual({
      draft: undefined,
      environmentId: "environment",
      threadId: "thread",
    });
    expect(isDraftThreadRoute(submitted.routes.at(-1))).toBe(false);
  });
});

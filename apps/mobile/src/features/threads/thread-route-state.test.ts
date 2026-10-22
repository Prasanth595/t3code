import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";
import { isDraftThreadRoute, submittedThreadParams } from "./thread-route-state";

const requireNavigation = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
);
const { StackRouter, CommonActions, StackActions } = requireNavigation(
  "@react-navigation/routers",
) as {
  StackRouter: typeof import("@react-navigation/native").StackRouter;
  CommonActions: typeof import("@react-navigation/native").CommonActions;
  StackActions: typeof import("@react-navigation/native").StackActions;
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

describe("missing shared-content project recovery", () => {
  it("replaces the stale draft before selecting the replacement project", () => {
    const router = StackRouter({});
    const options = {
      routeNames: ["Home", "Thread", "NewTaskProject"],
      routeParamList: {},
      routeGetIdList: {},
    };
    const initial = router.getInitialState(options);
    const staleDraft = router.getStateForAction(
      initial,
      CommonActions.navigate("Thread", {
        draft: { environmentId: "environment", projectId: "deleted", incomingShareId: "share" },
      }),
      options,
    )!;
    const picker = router.getStateForAction(
      staleDraft,
      StackActions.replace("NewTaskProject", { incomingShareId: "share" }),
      options,
    )!;
    expect(picker.routes.some(isDraftThreadRoute)).toBe(false);
    expect(picker.routes.at(-1)?.params).toEqual({ incomingShareId: "share" });
    const recovered = router.getStateForAction(
      picker,
      CommonActions.navigate("Thread", {
        draft: { environmentId: "environment", projectId: "replacement", incomingShareId: "share" },
      }),
      options,
    )!;
    expect(recovered.routes.filter(isDraftThreadRoute)).toHaveLength(1);
    expect(recovered.routes.at(-1)?.params).toEqual({
      draft: { environmentId: "environment", projectId: "replacement", incomingShareId: "share" },
    });
  });
});

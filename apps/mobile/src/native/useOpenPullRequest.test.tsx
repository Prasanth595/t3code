import * as NodeModule from "node:module";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  selectWorkspaceDetail,
  workspaceDetailRouter,
  type WorkspaceDetail,
} from "../features/workspace/workspace-detail-selection";

const harness = vi.hoisted(() => ({
  os: "android",
  navigation: undefined as unknown,
  select: (_detail: WorkspaceDetail) => {},
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return harness.os;
    },
  },
}));
vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(
    createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
  );
  return {
    StackActions: require("@react-navigation/routers").StackActions,
    useNavigation: () => harness.navigation,
  };
});
vi.mock("../features/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => harness.select,
}));
vi.mock("../state/entities", () => ({ useProjects: () => [], useThreadShell: () => null }));
vi.mock("../state/atom-registry", () => ({ appAtomRegistry: { get: () => new Map() } }));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../lib/openExternalUrl", () => ({ tryOpenExternalUrl: () => Promise.resolve(false) }));
vi.mock("../lib/pullRequestNavigation", () => ({
  nativePullRequestDestination: () => ({
    environmentId: "env",
    projectId: "p",
    repository: "o/r",
    number: 2,
  }),
}));

import { useNavigateToPullRequest } from "./useOpenPullRequest";

const require = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
);
const { StackRouter, StackActions } = require("@react-navigation/routers") as {
  StackRouter: typeof import("@react-navigation/native").StackRouter;
  StackActions: typeof import("@react-navigation/native").StackActions;
};

function setup({ sheet = false, drillIn = false, os = "android" } = {}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.os = os;
  const base = StackRouter({});
  const router = { ...base, ...workspaceDetailRouter(base) };
  const options = {
    routeNames: ["Home", "PullRequest", "GitOverview"],
    routeParamList: {},
    routeGetIdList: {},
  };
  let state = base.getInitialState(options);
  type Action = Parameters<typeof router.getStateForAction>[1];
  const dispatch = (action: Action) => {
    const next = router.getStateForAction(state, action, options);
    if (!next) throw new Error(`Rejected ${action.type}`);
    state = base.getRehydratedState(next, options);
  };
  const first = {
    name: "PullRequest",
    params: { environmentId: "env", projectId: "p", repository: "o/r", number: 1 },
  } as const;
  dispatch(selectWorkspaceDetail(first) as unknown as Action);
  if (sheet) dispatch(StackActions.push("GitOverview"));
  harness.navigation = { dispatch, getState: () => state };
  harness.select = (detail) => dispatch(selectWorkspaceDetail(detail) as unknown as Action);
  let open!: ReturnType<typeof useNavigateToPullRequest>;
  function Probe() {
    const navigate = useNavigateToPullRequest({ drillIn });
    useLayoutEffect(() => {
      open = navigate;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  return {
    async open() {
      await act(async () => {
        await open("https://github.com/o/r/pull/2", null);
      });
    },
    get state() {
      return state;
    },
    back: () => dispatch(StackActions.pop()),
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

it.each([false, true])(
  "selects a PR without retaining the previous PR or sheet (sheet=%s)",
  async (sheet) => {
    using screen = setup({ sheet });
    await screen.open();
    expect(screen.state.routes.map((route) => route.name)).toEqual(["Home", "PullRequest"]);
    expect(screen.state.routes.at(-1)?.params).toMatchObject({ number: 2 });
  },
);

it("retains the source PR for Back when a PR-content link explicitly drills in", async () => {
  using screen = setup({ drillIn: true });
  await screen.open();
  expect(screen.state.routes.map((route) => route.name)).toEqual([
    "Home",
    "PullRequest",
    "PullRequest",
  ]);
  screen.back();
  expect(screen.state.routes.at(-1)?.params).toMatchObject({ number: 1 });
});

it("preserves iOS's existing push behavior", async () => {
  using screen = setup({ os: "ios" });
  await screen.open();
  expect(screen.state.routes.map((route) => route.name)).toEqual([
    "Home",
    "PullRequest",
    "PullRequest",
  ]);
});

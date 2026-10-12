// @vitest-environment jsdom
import type { PullRequestDetail, PullRequestFilesViewedResult } from "@t3tools/contracts";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const host = vi.hoisted(() => ({
  data: null as PullRequestFilesViewedResult | null,
  write: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => true,
  useAtomRefresh: () => host.refresh,
}));
vi.mock("../../state/pull-requests", () => ({
  composerPullRequests: {
    filesViewed: () => null,
    setFilesViewed: { permissionAtom: () => null },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: host.data, error: null }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => host.write }));
vi.mock("./usePullRequestConnected", () => ({ usePullRequestConnected: () => true }));
vi.mock("./usePullRequestDiff", () => ({
  pullRequestTarget: (params: unknown) => ({ environmentId: "env", input: params }),
}));

import { usePullRequestFilesViewed } from "./usePullRequestFilesViewed";

const params = { environmentId: "env", projectId: "project", repository: "owner/repo", number: 1 };
const pr = { capabilities: { viewedFiles: true }, headSha: "head" } as unknown as PullRequestDetail;
let root: Root;
let view: ReturnType<typeof usePullRequestFilesViewed>;
function Surface() {
  const current = usePullRequestFilesViewed(params, pr);
  useEffect(() => {
    view = current;
  });
  return null;
}
function render() {
  act(() => root.render(<Surface />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host.data = null;
  host.write.mockReset().mockResolvedValue({ _tag: "Success" });
  host.refresh.mockReset();
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("resolves server states, optimistic marks, repeated toggles, and refreshed answers", async () => {
  render();
  expect(view.isViewed("missing")).toBe(false);
  host.data = {
    files: [
      { path: "a", state: "viewed" },
      { path: "b", state: "unviewed" },
      { path: "c", state: "dismissed" },
    ],
    truncated: false,
  };
  render();
  expect(["a", "b", "c", "missing"].map(view.isViewed)).toEqual([true, false, false, false]);
  await act(async () => {
    await view.toggle("a");
    await view.toggle("b");
    await view.toggle("c");
  });
  expect(["a", "b", "c"].map(view.isViewed)).toEqual([false, true, true]);
  await act(async () => {
    await view.toggle("b");
  });
  expect(view.isViewed("b")).toBe(false);
  expect(host.write.mock.calls.map(([request]) => request.input.files)).toEqual([
    [{ path: "a", viewed: false }],
    [{ path: "b", viewed: true }],
    [{ path: "c", viewed: true }],
    [{ path: "b", viewed: false }],
  ]);
  host.data = {
    files: [
      { path: "c", state: "dismissed" },
      { path: "b", state: "viewed" },
    ],
    truncated: false,
  };
  render();
  expect(["a", "b", "c"].map(view.isViewed)).toEqual([false, true, false]);
});

it("reads server paths once per answer rather than once per rendered file", async () => {
  let pathReads = 0;
  host.data = {
    files: Array.from({ length: 500 }, (_, index) => ({
      get path() {
        pathReads += 1;
        return `server-${index}`;
      },
      state: "viewed" as const,
    })),
    truncated: false,
  };
  render();
  for (let pass = 0; pass < 2; pass += 1) {
    for (let index = 0; index < 3000; index += 1)
      expect(view.isViewed(`file-${index}`)).toBe(false);
  }
  render();
  await act(async () => {
    await view.toggle("file-0");
  });
  expect(pathReads).toBeLessThanOrEqual(500);
});

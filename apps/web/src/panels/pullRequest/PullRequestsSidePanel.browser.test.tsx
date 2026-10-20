import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type ScopedThreadRef,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { act, Fragment, Suspense, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { commands, linksByThread, Wrapper, Trigger } = vi.hoisted(() => ({
  commands: [] as Array<{ command: string; request: unknown }>,
  // Linked pull requests per scoped thread key.
  linksByThread: new Map<string, ThreadPullRequestLink[]>(),
  Wrapper: ({ children }: { children?: ReactNode }) => children,
  Trigger: ({ children, render }: { children?: ReactNode; render?: ReactElement }) => (
    <>
      {render}
      {children}
    </>
  ),
}));
// The panel's list behavior is exercised without the virtualizer's browser geometry.
vi.mock("@legendapp/list/react", () => ({
  LegendList: <T,>({
    data,
    renderItem,
  }: {
    data: ReadonlyArray<T>;
    renderItem: (input: { item: T; index: number }) => ReactNode;
  }) => data.map((item, index) => <Fragment key={index}>{renderItem({ item, index })}</Fragment>),
}));
vi.mock("~/state/entities", () => ({
  // No projects, so rows offer no project-scoped fast actions.
  useProjects: () => [],
  // Only environment-new supports linked pull requests.
  useServerConfigs: () =>
    new Map(
      ["environment-new", "environment-old"].map((environmentId) => [
        environmentId,
        {
          environment: {
            capabilities: { threadPullRequests: environmentId === "environment-new" },
          },
        },
      ]),
    ),
  useThreadShell: (threadRef: ScopedThreadRef) => ({
    pullRequests: linksByThread.get(scopedThreadKey(threadRef)) ?? [],
  }),
}));
vi.mock("~/state/threads", () => ({
  threadEnvironment: { unlinkPullRequest: "unlink", watchPullRequest: "watch" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (request: unknown) => {
    commands.push({ command, request });
  },
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectForChangeRequest: () => null,
  useOpenPrLink: () => vi.fn(),
}));
vi.mock("~/shortcutModifierState", () => ({
  useShortcutModifierState: () => ({
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  }),
}));
vi.mock("~/components/pullRequest/LinkPullRequestDialog", () => ({
  openLinkPullRequestDialog: vi.fn(),
}));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: Wrapper,
  TooltipTrigger: Trigger,
  TooltipPopup: () => null,
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: Wrapper,
  MenuPopup: Wrapper,
  MenuTrigger: Trigger,
  MenuItem: "button",
}));

import { RegisteredSidePanel } from "../bundledPanels";
import { PanelHostContext, type PanelHost } from "../panelHost";

// The same thread id on two environments is two threads.
const threadId = ThreadId.make("thread-a");
const refOn = (environmentId: string): ScopedThreadRef => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId,
});
const link = (repository: string, number: number): ThreadPullRequestLink => ({
  host: "github.com",
  repository,
  number,
  url: `https://github.com/${repository}/pull/${number}`,
  source: "manual",
  linkedAt: "2026-09-01T00:00:00.000Z",
  snapshot: null,
  stack: null,
});
let root: Root;
let container: HTMLDivElement;

const panelFor = (threadRef: ScopedThreadRef) => {
  const host: PanelHost = {
    threadRef,
    visible: true,
    composerDraftTarget: threadRef,
    workspaceMutationId: null,
    sendAnnotation: () => undefined,
  };
  return (
    <PanelHostContext value={host}>
      <Suspense fallback={null}>
        <RegisteredSidePanel id="pull-requests" />
      </Suspense>
    </PanelHostContext>
  );
};

// One root across hosts, so a host change reaches the already mounted list.
async function renderFor(threadRef: ScopedThreadRef) {
  await act(async () => {
    root.render(panelFor(threadRef));
  });
}

const hasText = (text: string) => container.textContent?.includes(text) ?? false;

// Transform the lazy body once up front, so mounting it settles inside one act().
beforeAll(() => import("./PullRequestsSidePanel"));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  commands.length = 0;
  linksByThread.clear();
  linksByThread.set(scopedThreadKey(refOn("environment-new")), [link("owner/alpha", 11)]);
  linksByThread.set(scopedThreadKey(refOn("environment-old")), [link("owner/beta", 22)]);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("linked pull requests side panel", () => {
  it("lists and unlinks the host thread's pull requests", async () => {
    await renderFor(refOn("environment-new"));
    expect(hasText("owner/alpha")).toBe(true);
    expect(hasText("owner/beta")).toBe(false);

    const unlink = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (node) => node.textContent?.includes("Unlink from thread"),
    );
    expect(unlink).toBeDefined();
    await act(async () => unlink!.click());
    expect(commands).toEqual([
      {
        command: "unlink",
        request: {
          environmentId: "environment-new",
          input: { threadId, host: "github.com", repository: "owner/alpha", number: 11 },
        },
      },
    ]);
  });

  it("follows the host to a thread whose environment cannot link pull requests", async () => {
    await renderFor(refOn("environment-new"));
    expect(hasText("owner/alpha")).toBe(true);

    await renderFor(refOn("environment-old"));
    expect(hasText("Linked pull requests unavailable")).toBe(true);
    expect(hasText("owner/alpha")).toBe(false);
    expect(hasText("owner/beta")).toBe(false);

    linksByThread.set(scopedThreadKey(refOn("environment-new")), [link("owner/gamma", 33)]);
    await renderFor(refOn("environment-new"));
    expect(hasText("owner/gamma")).toBe(true);
  });
});

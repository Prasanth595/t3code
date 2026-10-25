import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { act, fakeTimers, render } from "../../../test/render";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { SidebarContent } from "../ui/sidebar";
import { Tooltip, TooltipDismissScope, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectPager, projectPagerNeighbours, stepSidebarWheel } from "./project-pager";
import { useScopedThreadSearch } from "./use-scoped-thread-search";

const environmentId = EnvironmentId.make("env-primary");

const snapshotsOf = (names: ReadonlyArray<string>) =>
  buildSidebarProjectSnapshots({
    projects: names.map((name) => ({
      id: ProjectId.make(name),
      environmentId,
      title: name,
      workspaceRoot: `/work/${name}`,
      repositoryIdentity: null,
      defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      scripts: [],
    })),
    settings: { sidebarProjectGroupingMode: "separate", sidebarProjectGroupingOverrides: {} },
    primaryEnvironmentId: environmentId,
    resolveEnvironmentLabel: () => null,
  });
const groups = snapshotsOf(["alpha", "beta", "gamma"]);
const keyOf = (title: string) => groups.find((group) => group.displayName === title)!.projectKey;
const titleOf = (key: string | null) =>
  groups.find((group) => group.projectKey === key)?.displayName ?? "all";

function pagesFor(
  order: ReadonlyArray<SidebarProjectSnapshot>,
  scopeKey: string | null,
  render: (key: string | null, current: boolean) => ReactNode,
) {
  const { previous, next } = projectPagerNeighbours(order, scopeKey);
  const keys = [
    ...(previous === undefined ? [] : [previous?.projectKey ?? null]),
    scopeKey,
    ...(next === undefined ? [] : [next?.projectKey ?? null]),
  ];
  return keys.map((key) => ({ scopeKey: key, content: render(key, key === scopeKey) }));
}

const reordered = [keyOf("beta"), keyOf("alpha"), keyOf("gamma")].map((key) =>
  groups.find((group) => group.projectKey === key)!,
);

const scrollerPage = (key: string | null) => (
  <div data-testid="page-scroller" style={{ height: 120, overflowY: "auto" }}>
    <p>{titleOf(key)}</p>
    <div style={{ height: 600 }} />
  </div>
);

function Pager({ initialKey, hidden = false }: { initialKey: string | null; hidden?: boolean }) {
  const [scopeKey, setScopeKey] = useState(initialKey);
  const [order, setOrder] = useState(groups);
  return (
    <>
      <div
        data-testid="frame"
        style={{ display: hidden ? "none" : "flex", width: 200, height: 120 }}
      >
        <ProjectPager
          pages={pagesFor(order, scopeKey, scrollerPage)}
          scopeKey={scopeKey}
          onScopeChange={setScopeKey}
        />
      </div>
      <button type="button" onClick={() => setScopeKey(keyOf("alpha"))}>
        pick alpha
      </button>
      <button type="button" onClick={() => setOrder(reordered)}>
        reorder
      </button>
    </>
  );
}

const pagerOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-project-pager]")!;
const pageOf = (container: HTMLElement, key: string | null) =>
  container.querySelector<HTMLElement>(`[data-project-page="${key ?? ""}"]`)!;
const currentPage = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-project-pager] > :not([inert])")!;
const currentTitle = (container: HTMLElement) => currentPage(container).textContent;
const pageTitles = (container: HTMLElement) =>
  Array.from(pagerOf(container).children, (page) => page.textContent);

const nextScroll = (element: HTMLElement) =>
  new Promise((resolve) => element.addEventListener("scroll", resolve, { once: true }));

async function swipeTo(pager: HTMLElement, left: number) {
  const settled = new Promise((resolve) =>
    pager.addEventListener("scrollend", resolve, { once: true }),
  );
  await act(async () => {
    pager.scrollLeft = left;
    await settled;
  });
}

async function arriveAt(pager: HTMLElement, left: number) {
  const arrived = nextScroll(pager);
  pager.scrollLeft = left;
  await arrived;
}

// scrollend does not bubble, but it still capture-propagates through window, so
// stopping it there withholds it from the pager, like a gesture still under way
// in an engine that reports scrollend.
function withoutScrollEnd(): Disposable {
  const stop = (event: Event) => event.stopPropagation();
  window.addEventListener("scrollend", stop, { capture: true });
  return {
    [Symbol.dispose]: () => window.removeEventListener("scrollend", stop, { capture: true }),
  };
}

// An engine without scrollend, such as Safari before 26.2: no `onscrollend`
// handler property, and no event.
function withoutScrollEndSupport(): Disposable {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "onscrollend")!;
  Reflect.deleteProperty(HTMLElement.prototype, "onscrollend");
  const events = withoutScrollEnd();
  return {
    [Symbol.dispose]: () => {
      events[Symbol.dispose]();
      Object.defineProperty(HTMLElement.prototype, "onscrollend", descriptor);
    },
  };
}

describe("ProjectPager", () => {
  it("renders the neighbours inert and makes the page a swipe lands on current, scroll position and all", async () => {
    await using screen = await render(<Pager initialKey={keyOf("beta")} />);
    const pager = pagerOf(screen.container);
    expect(pageTitles(screen.container)).toEqual(["alpha", "beta", "gamma"]);
    expect(currentTitle(screen.container)).toBe("beta");
    expect(pager.scrollLeft).toBe(200);
    const gamma = pageOf(screen.container, keyOf("gamma"));
    const betaScroller = pageOf(screen.container, keyOf("beta")).querySelector<HTMLElement>(
      "[data-testid=page-scroller]",
    )!;
    betaScroller.scrollTop = 150;

    await swipeTo(pager, 400);
    await vi.waitFor(() => expect(currentTitle(screen.container)).toBe("gamma"));
    expect(currentPage(screen.container)).toBe(gamma);
    expect(pageTitles(screen.container)).toEqual(["beta", "gamma"]);
    expect(pager.scrollLeft).toBe(200);

    await swipeTo(pager, 0);
    await vi.waitFor(() => expect(currentTitle(screen.container)).toBe("beta"));
    expect(betaScroller.scrollTop).toBe(150);
    expect(pager.scrollLeft).toBe(200);
  });

  it("swipes back to all projects, which has no page before it", async () => {
    await using screen = await render(<Pager initialKey={keyOf("alpha")} />);
    const pager = pagerOf(screen.container);

    await swipeTo(pager, 0);
    await vi.waitFor(() => expect(currentTitle(screen.container)).toBe("all"));
    expect(pager.scrollLeft).toBe(0);
    expect(pager.scrollWidth).toBe(400);
  });

  it("where scrollend exists, waits for it even after the scroll goes quiet, from the first swipe on All", async () => {
    await using screen = await render(<Pager initialKey={null} />);
    const pager = pagerOf(screen.container);
    using _timers = fakeTimers();
    {
      using _scrollEnd = withoutScrollEnd();
      await arriveAt(pager, 200);
      await act(() => vi.advanceTimersByTime(1000));
      expect(currentTitle(screen.container)).toBe("all");
    }

    await act(() => pager.dispatchEvent(new Event("scrollend")));
    expect(currentTitle(screen.container)).toBe("alpha");
    expect(pager.scrollLeft).toBe(200);
  });

  it("without scrollend, commits once the scroll goes idle, not when it reaches the edge", async () => {
    await using screen = await render(<Pager initialKey={keyOf("alpha")} />);
    const pager = pagerOf(screen.container);
    using _scrollEnd = withoutScrollEndSupport();
    using _timers = fakeTimers();

    await arriveAt(pager, 400);
    expect(currentTitle(screen.container)).toBe("alpha");

    await act(() => vi.advanceTimersByTime(150));
    expect(currentTitle(screen.container)).toBe("beta");
    expect(pager.scrollLeft).toBe(200);
  });

  it("without scrollend, lands on the neighbour on screen when the order changes before the scroll goes idle", async () => {
    await using screen = await render(<Pager initialKey={keyOf("alpha")} />);
    const pager = pagerOf(screen.container);
    using _scrollEnd = withoutScrollEndSupport();
    using _timers = fakeTimers();

    await arriveAt(pager, 0);
    await screen.getByRole("button", { name: "reorder" }).click();
    expect(pageTitles(screen.container)).toEqual(["beta", "alpha", "gamma"]);
    expect(pager.scrollLeft).toBe(0);

    await act(() => vi.advanceTimersByTime(150));
    expect(currentTitle(screen.container)).toBe("beta");
  });

  it("recentres when the scope changes elsewhere mid-swipe instead of landing on the old neighbour", async () => {
    await using screen = await render(<Pager initialKey={keyOf("beta")} />);
    const pager = pagerOf(screen.container);
    using _scrollEnd = withoutScrollEndSupport();
    using _timers = fakeTimers();

    await arriveAt(pager, 400);
    await screen.getByRole("button", { name: "pick alpha" }).click();
    expect(pager.scrollLeft).toBe(200);

    await act(() => vi.advanceTimersByTime(150));
    expect(currentTitle(screen.container)).toBe("alpha");
    expect(pager.scrollLeft).toBe(200);
  });

  it("stays on its project when it mounts in a hidden sidebar that opens later", async () => {
    await using screen = await render(<Pager initialKey={keyOf("beta")} hidden />);
    const pager = pagerOf(screen.container);
    using _scrollEnd = withoutScrollEndSupport();
    using _timers = fakeTimers();

    screen.container.querySelector<HTMLElement>("[data-testid=frame]")!.style.display = "flex";
    await vi.waitFor(() => expect(pager.scrollLeft).toBe(200));
    await act(() => vi.advanceTimersByTime(150));
    expect(currentTitle(screen.container)).toBe("beta");
  });
});

const threadsPage = (key: string | null, current: boolean) => (
  <>
    <p data-testid={current ? "live-list" : undefined}>{titleOf(key)}</p>
    {Array.from({ length: 30 }, (_, index) => (
      <p key={index}>thread {index}</p>
    ))}
  </>
);

function SidebarHarness({ initialKey }: { initialKey: string | null }) {
  const [scopeKey, setScopeKey] = useState(initialKey);
  return (
    <div
      data-sidebar="sidebar"
      style={{ display: "flex", flexDirection: "column", width: 200, height: 240 }}
    >
      <SidebarContent
        fixedHeader={
          <div data-testid="search" style={{ height: 32 }}>
            Search
          </div>
        }
        renderScrollFrame={(renderScrollArea) => (
          <ProjectPager
            pages={pagesFor(groups, scopeKey, (key, current) =>
              renderScrollArea(threadsPage(key, current)),
            )}
            scopeKey={scopeKey}
            onScopeChange={setScopeKey}
          />
        )}
      />
    </div>
  );
}

function wheelBurst(target: Element, deltaX: number, deltaY: number) {
  for (let index = 0; index < 10; index++) {
    target.dispatchEvent(new WheelEvent("wheel", { deltaX, deltaY, bubbles: true }));
  }
}

async function reduceMotion(): Promise<AsyncDisposable> {
  await commands.emulateReducedMotion(true);
  return { [Symbol.asyncDispose]: () => commands.emulateReducedMotion(false) };
}

describe("sideways wheel over the sidebar", () => {
  it("pages from a sideways wheel over the real thread list and keeps vertical wheel on the list", async () => {
    await using screen = await render(<SidebarHarness initialKey={keyOf("beta")} />);

    await commands.wheel("[data-testid=live-list]", 120, 0);
    await expect.element(screen.getByTestId("live-list")).toHaveTextContent("gamma");

    const viewport = currentPage(screen.container).querySelector<HTMLElement>(
      "[data-slot=scroll-area-viewport]",
    )!;
    await commands.wheel("[data-testid=live-list]", 0, 120);
    await vi.waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));
    expect(currentTitle(screen.container)).toContain("gamma");
  });

  it("uses Shift plus vertical mouse wheel over the list to switch projects both ways", async () => {
    await using screen = await render(<SidebarHarness initialKey={keyOf("beta")} />);

    await userEvent.keyboard("{Shift>}");
    try {
      await commands.wheel("[data-testid=live-list]", 0, 120);
      await expect.element(screen.getByTestId("live-list")).toHaveTextContent("gamma");
      expect(
        currentPage(screen.container).querySelector("[data-slot=scroll-area-viewport]")?.scrollTop,
      ).toBe(0);

      await commands.wheel("[data-testid=live-list]", 0, -120);
      await expect.element(screen.getByTestId("live-list")).toHaveTextContent("beta");
      expect(
        currentPage(screen.container).querySelector("[data-slot=scroll-area-viewport]")?.scrollTop,
      ).toBe(0);
    } finally {
      await userEvent.keyboard("{/Shift}");
    }
  });

  it("without scrollend, keeps waiting while wheel input goes on over a list held at the edge", async () => {
    await using screen = await render(<SidebarHarness initialKey={keyOf("alpha")} />);
    const pager = pagerOf(screen.container);
    const list = screen.getByTestId("live-list").element();
    using _scrollEnd = withoutScrollEndSupport();
    using _timers = fakeTimers();

    await arriveAt(pager, 400);
    for (let index = 0; index < 3; index++) {
      list.dispatchEvent(new WheelEvent("wheel", { deltaX: 20, bubbles: true }));
      await act(() => vi.advanceTimersByTime(100));
    }
    expect(screen.getByTestId("live-list").element().textContent).toBe("alpha");

    await act(() => vi.advanceTimersByTime(150));
    expect(screen.getByTestId("live-list").element().textContent).toBe("beta");
  });

  it("steps to the next project from the header", async () => {
    await using _motion = await reduceMotion();
    await using screen = await render(<SidebarHarness initialKey={keyOf("beta")} />);
    const pager = pagerOf(screen.container);
    const search = screen.getByTestId("search").element();

    wheelBurst(search, 20, 0);
    expect(pager.scrollLeft).toBe(400);
    await expect.element(screen.getByTestId("live-list")).toHaveTextContent("gamma");
    expect(pager.scrollLeft).toBe(200);
  });
});

function Tip({ testId, label, delay = 0 }: { testId: string; label: string; delay?: number }) {
  return (
    <Tooltip>
      <TooltipTrigger data-testid={testId} delay={delay}>
        {testId}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

const tipThreadsPage = (key: string | null, current: boolean) => (
  <>
    {current ? <Tip testId="row-tip" label="Thread details" /> : null}
    {threadsPage(key, current)}
  </>
);

// Tooltips in the header, in the current page and in the footer, outside the
// pager on both sides, like the real sidebar's chrome around its lists.
function TooltipSidebarHarness({
  initialKey,
  headerDelay = 0,
}: {
  initialKey: string | null;
  headerDelay?: number;
}) {
  const [scopeKey, setScopeKey] = useState(initialKey);
  return (
    <TooltipDismissScope>
      <div
        data-sidebar="sidebar"
        style={{ display: "flex", flexDirection: "column", width: 200, height: 240 }}
      >
        <SidebarContent
          fixedHeader={
            <div data-testid="search" style={{ height: 32 }}>
              <Tip testId="header-tip" label="New thread" delay={headerDelay} />
            </div>
          }
          renderScrollFrame={(renderScrollArea) => (
            <ProjectPager
              pages={pagesFor(groups, scopeKey, (key, current) =>
                renderScrollArea(tipThreadsPage(key, current)),
              )}
              scopeKey={scopeKey}
              onScopeChange={setScopeKey}
            />
          )}
        />
        <div data-testid="footer" style={{ height: 24 }}>
          <Tip testId="footer-tip" label="Settings" />
        </div>
      </div>
    </TooltipDismissScope>
  );
}

const tooltip = (label: string) => page.getByText(label, { exact: true });

describe("tooltips while swiping between projects", () => {
  it("closes a focused thread tooltip as a native swipe starts, before the neighbour lands", async () => {
    await using screen = await render(<TooltipSidebarHarness initialKey={keyOf("beta")} />);
    await userEvent.tab();
    await userEvent.tab();
    await expect.element(screen.getByTestId("row-tip")).toHaveFocus();
    await expect.element(tooltip("Thread details")).toBeVisible();
    using _scrollEnd = withoutScrollEnd();

    // A touch swipe, or a trackpad one chained from the list, scrolls the
    // pager natively without any wheel listener of the sidebar's seeing it.
    await arriveAt(pagerOf(screen.container), 400);
    await expect.element(tooltip("Thread details")).not.toBeInTheDocument();
    expect(screen.getByTestId("live-list").element().textContent).toBe("beta");
  });

  it("closes a header tooltip on a sideways wheel, even at the last project", async () => {
    await using screen = await render(<TooltipSidebarHarness initialKey={keyOf("gamma")} />);
    await userEvent.hover(screen.getByTestId("header-tip"));
    await expect.element(tooltip("New thread")).toBeVisible();

    wheelBurst(screen.getByTestId("search").element(), 20, 0);
    await expect.element(tooltip("New thread")).not.toBeInTheDocument();
    expect(screen.getByTestId("live-list").element().textContent).toBe("gamma");
  });

  it("keeps a header tooltip open through a vertical wheel", async () => {
    await using screen = await render(<TooltipSidebarHarness initialKey={keyOf("beta")} />);
    await userEvent.hover(screen.getByTestId("header-tip"));
    await expect.element(tooltip("New thread")).toBeVisible();

    wheelBurst(screen.getByTestId("search").element(), 0, 20);
    await expect.element(tooltip("New thread")).toBeVisible();
  });

  it("closes a footer tooltip and one opened by keyboard focus, which keeps focus", async () => {
    await using screen = await render(<TooltipSidebarHarness initialKey={keyOf("beta")} />);
    const search = screen.getByTestId("search").element();
    await userEvent.hover(screen.getByTestId("footer-tip"));
    await expect.element(tooltip("Settings")).toBeVisible();
    await userEvent.tab();
    await expect.element(screen.getByTestId("header-tip")).toHaveFocus();
    await expect.element(tooltip("New thread")).toBeVisible();

    wheelBurst(search, 20, 0);
    await expect.element(tooltip("New thread")).not.toBeInTheDocument();
    await expect.element(tooltip("Settings")).not.toBeInTheDocument();
    await expect.element(screen.getByTestId("header-tip")).toHaveFocus();
  });

  it("cancels a hover tooltip still waiting on its delay, and opens again on the next hover", async () => {
    await using screen = await render(
      <TooltipSidebarHarness initialKey={keyOf("gamma")} headerDelay={300} />,
    );
    const search = screen.getByTestId("search").element();
    {
      using _timers = fakeTimers();
      await userEvent.hover(screen.getByTestId("header-tip"));
      await act(() => vi.advanceTimersByTime(100));
      wheelBurst(search, 20, 0);
      await act(() => vi.advanceTimersByTime(1000));
      expect(tooltip("New thread").query()).toBeNull();
    }

    await userEvent.unhover(screen.getByTestId("header-tip"));
    await userEvent.hover(screen.getByTestId("header-tip"));
    await expect.element(tooltip("New thread")).toBeVisible();
  });
});

describe("stepSidebarWheel", () => {
  const steps = (events: ReadonlyArray<{ dx: number; dy: number; at: number }>) => {
    let gesture: Parameters<typeof stepSidebarWheel>[0] = null;
    return events.map((event) => {
      const result = stepSidebarWheel(gesture, event);
      gesture = result.gesture;
      return result.step;
    });
  };
  const burst = (start: number, count: number, dx: number, dy: number) =>
    Array.from({ length: count }, (_, index) => ({ dx, dy, at: start + index * 16 }));

  it("steps once per gesture, ignoring its momentum, and again for the next gesture", () => {
    expect(
      steps([...burst(0, 10, 20, 0), ...burst(160, 30, 5, 0), ...burst(840, 3, 20, 0)]),
    ).toEqual([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, ...Array(30).fill(0), 0, 1, 0]);
  });

  it("steps backwards for a leftward swipe", () => {
    expect(steps(burst(0, 3, -20, 0))).toEqual([0, -1, 0]);
  });

  it("never steps once a gesture locks to vertical", () => {
    expect(steps(burst(0, 10, 15, 20))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(
      steps([
        { dx: 3, dy: 0, at: 0 },
        { dx: 0, dy: 10, at: 16 },
        { dx: 60, dy: 0, at: 32 },
      ]),
    ).toEqual([0, 0, 0]);
  });
});

const searchThreads = [
  ["alpha", "a1", "Fix login bug"],
  ["alpha", "a2", "Refactor auth"],
  ["alpha", "a3", "Zeta notes"],
  ["beta", "b1", "Cache layer"],
  ["beta", "b2", "Docs"],
  ["gamma", "g1", "Unrelated"],
].map(([project, id, title]) => ({
  project: project!,
  environmentId,
  id: ThreadId.make(id!),
  title: title!,
  branch: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  latestUserMessageAt: "2026-10-01T00:00:00.000Z",
  opens: null,
}));

// What the server answers for "bug" across every project: message matches in
// a2, a3 and b1 (whole word 1, then 0.9 and 0.8). The fast environment's
// matches come first and a3's arrives later.
const messageMatch = (threadId: string, quality: number): EnvironmentThreadSearchMatch => ({
  environmentId,
  threadId: ThreadId.make(threadId),
  projectId: ProjectId.make(threadId.startsWith("a") ? "alpha" : "beta"),
  source: "user",
  snippet: "a bug",
  messageCreatedAt: "2026-10-01T00:00:00.000Z",
  quality,
});
const firstMatches = [messageMatch("b1", 1), messageMatch("a2", 0.8)];
const allMatches = [...firstMatches, messageMatch("a3", 0.9)];

const threadsIn = (key: string | null) =>
  searchThreads.filter((thread) => key === null || thread.project === titleOf(key));
const keysOf = (scope: SidebarProjectSnapshot | null | undefined) =>
  scope === undefined ? undefined : (scope?.projectKey ?? null);

function SearchHarness({ initialKey }: { initialKey: string | null }) {
  const [scopeKey, setScopeKey] = useState(initialKey);
  const [matches, setMatches] = useState(firstMatches);
  const { previous, next } = projectPagerNeighbours(groups, scopeKey);
  const previousKey = keysOf(previous);
  const nextKey = keysOf(next);
  const search = useScopedThreadSearch({
    query: "bug",
    search: { query: "bug", matches },
    live: threadsIn(scopeKey),
  });
  const resultsPage = (results: ReadonlyArray<{ title: string }>) =>
    results.length === 0 ? (
      <p>No threads found</p>
    ) : (
      <ul>
        {results.map((thread) => (
          <li key={thread.title}>{thread.title}</li>
        ))}
      </ul>
    );
  const pages = [
    ...(previousKey === undefined
      ? []
      : [
          {
            scopeKey: previousKey,
            content: resultsPage(search.searchScope(threadsIn(previousKey)).results),
          },
        ]),
    { scopeKey, content: resultsPage(search.live.results) },
    ...(nextKey === undefined
      ? []
      : [
          {
            scopeKey: nextKey,
            content: resultsPage(search.searchScope(threadsIn(nextKey)).results),
          },
        ]),
  ];
  return (
    <>
      <div style={{ display: "flex", width: 200, height: 120 }}>
        <ProjectPager pages={pages} scopeKey={scopeKey} onScopeChange={setScopeKey} />
      </div>
      <button type="button" onClick={() => setMatches(allMatches)}>
        late matches
      </button>
    </>
  );
}

const resultsOf = (page: HTMLElement) =>
  page.querySelector("ul") === null
    ? page.textContent
    : Array.from(page.querySelectorAll("li"), (item) => item.textContent);

describe("searching while swiping between projects", () => {
  it("shows each project's own results on its page before and after it lands, both ways", async () => {
    await using screen = await render(<SearchHarness initialKey={null} />);
    const pager = pagerOf(screen.container);
    expect(resultsOf(currentPage(screen.container))).toEqual([
      "Fix login bug",
      "Cache layer",
      "Refactor auth",
    ]);
    // a3 outranks a2 but arrives after the list showed a2, so it goes below.
    await screen.getByRole("button", { name: "late matches" }).click();
    expect(resultsOf(currentPage(screen.container))).toEqual([
      "Fix login bug",
      "Cache layer",
      "Refactor auth",
      "Zeta notes",
    ]);

    const steps: ReadonlyArray<[target: string | null, left: number, results: unknown]> = [
      // The incoming page already keeps the order All showed.
      [keyOf("alpha"), 200, ["Fix login bug", "Refactor auth", "Zeta notes"]],
      [keyOf("beta"), 400, ["Cache layer"]],
      [keyOf("gamma"), 400, "No threads found"],
      [keyOf("beta"), 0, ["Cache layer"]],
      // Back on alpha after beta, nothing of alpha's is on screen to hold.
      [keyOf("alpha"), 0, ["Fix login bug", "Zeta notes", "Refactor auth"]],
    ];
    for (const [target, left, results] of steps) {
      const incoming = pageOf(screen.container, target);
      expect(incoming.inert).toBe(true);
      expect(resultsOf(incoming)).toEqual(results);
      await swipeTo(pager, left);
      await vi.waitFor(() => expect(currentPage(screen.container)).toBe(incoming));
      expect(resultsOf(incoming)).toEqual(results);
    }
  });
});

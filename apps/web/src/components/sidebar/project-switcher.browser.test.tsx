import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { useRef, useState, type ComponentRef, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { commands } from "vite-plus/test/browser";

import "~/index.css";

import { act, fakeTimers, render } from "../../../test/render";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { SidebarContent } from "../ui/sidebar";
import {
  projectPagerNeighbours,
  ProjectSwitcherBar,
  ProjectSwitcherPager,
  stepSidebarWheel,
  useProjectPagerRoute,
} from "./project-switcher";
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
  [...groups, ...wideGroups].find((group) => group.projectKey === key)?.displayName ?? "all";

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
        <ProjectSwitcherPager
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

describe("ProjectSwitcherPager", () => {
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

function SidebarHarness({
  initialKey,
  projects = groups,
}: {
  initialKey: string | null;
  projects?: ReadonlyArray<SidebarProjectSnapshot>;
}) {
  const [scopeKey, setScopeKey] = useState(initialKey);
  return (
    <div
      data-sidebar="sidebar"
      style={{ display: "flex", flexDirection: "column", width: 200, height: 240 }}
    >
      <SidebarContent
        fixedHeader={
          <>
            <div data-testid="search" style={{ height: 32 }}>
              Search
            </div>
            <ProjectSwitcherBar
              groups={projects}
              scopeKey={scopeKey}
              onScopeChange={setScopeKey}
              onReorder={() => {}}
              onOpenProjectSettings={() => {}}
              renderBadge={() => null}
            />
          </>
        }
        renderScrollFrame={(renderScrollArea) => (
          <ProjectSwitcherPager
            pages={pagesFor(projects, scopeKey, (key, current) =>
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

  it("moves the pill row for wheel input on either axis, and nothing else", async () => {
    await using screen = await render(
      <SidebarHarness initialKey={wideKey("a much")} projects={wideGroups} />,
    );
    const pager = pagerOf(screen.container);
    const bar = screen.container.querySelector<HTMLElement>("[data-project-switcher-bar]")!;
    const viewport = currentPage(screen.container).querySelector<HTMLElement>(
      "[data-slot=scroll-area-viewport]",
    )!;
    const start = bar.scrollLeft;
    expect(bar.scrollWidth - bar.clientWidth - start).toBeGreaterThan(100);
    expect(start).toBeGreaterThan(40);

    // Down and right move the row right; up and left move it back. A diagonal
    // moves it by its main axis only.
    const steps: ReadonlyArray<[dx: number, dy: number, moved: number]> = [
      [0, 60, 60],
      [0, -60, 0],
      [60, 0, 60],
      [-60, 0, 0],
      [20, 60, 60],
      [0, -60, 0],
    ];
    for (const [dx, dy, moved] of steps) {
      await commands.wheel("[data-project-switcher-bar]", dx, dy);
      await vi.waitFor(() => near(bar.scrollLeft, start + moved));
      expect(viewport.scrollTop).toBe(0);
      expect(pager.scrollLeft).toBe(200);
      expect(screen.getByTestId("live-list").element().textContent).toBe(
        "a much longer project name",
      );
    }

    // Held at its end, more input still stays in the row.
    await commands.wheel("[data-project-switcher-bar]", 0, 2000);
    await vi.waitFor(() => near(bar.scrollLeft, bar.scrollWidth - bar.clientWidth));
    await commands.wheel("[data-project-switcher-bar]", 0, 200);
    expect(viewport.scrollTop).toBe(0);
    expect(pager.scrollLeft).toBe(200);
    expect(screen.getByTestId("live-list").element().textContent).toBe(
      "a much longer project name",
    );
  });

  it("steps to the next project from the header, but never from the pill bar", async () => {
    await using _motion = await reduceMotion();
    await using screen = await render(<SidebarHarness initialKey={keyOf("beta")} />);
    const pager = pagerOf(screen.container);
    const bar = screen.container.querySelector<HTMLElement>("[role=group]")!;
    const search = screen.getByTestId("search").element();

    bar.scrollLeft = bar.scrollWidth;
    wheelBurst(bar, 20, 0);
    expect(pager.scrollLeft).toBe(200);

    wheelBurst(search, 20, 0);
    expect(pager.scrollLeft).toBe(400);
    await expect.element(screen.getByTestId("live-list")).toHaveTextContent("gamma");
    expect(pager.scrollLeft).toBe(200);
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

function pointer(type: string, target: EventTarget, at: { x: number; y: number }) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      isPrimary: true,
      pointerId: 1,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: at.x,
      clientY: at.y,
    }),
  );
}

const centreOf = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

const ignore = () => {};

function Bar({
  onScopeChange = ignore,
  onReorder,
  onOpenProjectSettings = ignore,
}: {
  onScopeChange?: (key: string | null) => void;
  onReorder?: (active: SidebarProjectSnapshot, over: SidebarProjectSnapshot) => void;
  onOpenProjectSettings?: (group: SidebarProjectSnapshot) => void;
}) {
  const [order, setOrder] = useState(groups);
  return (
    <div style={{ width: 600 }}>
      <ProjectSwitcherBar
        groups={order}
        scopeKey={null}
        onScopeChange={onScopeChange}
        onReorder={
          onReorder ??
          ((active, over) => {
            const next = [...order];
            const from = next.indexOf(active);
            const to = next.indexOf(over);
            next[from] = over;
            next[to] = active;
            setOrder(next);
          })
        }
        onOpenProjectSettings={onOpenProjectSettings}
        renderBadge={() => null}
      />
    </div>
  );
}

const pillTitles = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("[data-scope-key]"), (pill) =>
    titleOf(pill.getAttribute("data-scope-key") || null),
  );

describe("ProjectSwitcherBar", () => {
  it("reorders a dragged pill onto its drop target without selecting it", async () => {
    const onReorder = vi.fn();
    const onScopeChange = vi.fn();
    await using screen = await render(<Bar onReorder={onReorder} onScopeChange={onScopeChange} />);
    await expect.element(screen.getByRole("button", { name: "gamma" })).toBeVisible();
    const alpha = screen.getByRole("button", { name: "alpha" }).element();
    const gamma = screen.getByRole("button", { name: "gamma" }).element();
    const from = centreOf(alpha);
    const to = centreOf(gamma);
    using _timers = fakeTimers();

    await act(async () => {
      pointer("pointerdown", alpha, from);
      pointer("pointermove", document, { x: from.x + 10, y: from.y });
    });
    await act(async () => pointer("pointermove", document, to));
    await act(async () => pointer("pointerup", document, to));
    await act(async () => alpha.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(
      onReorder.mock.calls.map(([active, over]) => [active.displayName, over.displayName]),
    ).toEqual([["alpha", "gamma"]]);
    expect(onScopeChange).not.toHaveBeenCalled();
    // dnd-kit swallows document clicks for 50ms after a drop; run that out so
    // it cannot eat a later test's clicks.
    vi.advanceTimersByTime(50);
  });

  it("announces a dragged pill by its project name and position, never its path", async () => {
    await using screen = await render(<Bar />);
    await expect.element(screen.getByRole("button", { name: "gamma" })).toBeVisible();
    const alpha = screen.getByRole("button", { name: "alpha" }).element();
    const gamma = screen.getByRole("button", { name: "gamma" }).element();
    const from = centreOf(alpha);
    const to = centreOf(gamma);
    // dnd-kit's own announcer for this bar's drag context.
    const announcer = () =>
      screen.container.querySelector('[id^="DndLiveRegion"]')?.textContent ?? "";
    const heard: string[] = [];
    using _timers = fakeTimers();

    await act(async () => {
      pointer("pointerdown", alpha, from);
      pointer("pointermove", document, { x: from.x + 10, y: from.y });
    });
    heard.push(announcer());
    await act(async () => pointer("pointermove", document, to));
    heard.push(announcer());
    await act(async () => pointer("pointerup", document, to));
    heard.push(announcer());

    // Pickup and hovering its own place arrive together; the last one is read.
    expect(heard).toEqual([
      "alpha is at position 1 of 3.",
      "alpha is over position 3 of 3.",
      "Moved alpha to position 3 of 3.",
    ]);
    for (const text of heard) {
      expect(text).not.toContain("/work/");
      expect(text).not.toContain(keyOf("alpha"));
    }
    // dnd-kit swallows document clicks for 50ms after a drop.
    vi.advanceTimersByTime(50);
  });

  it("announces a cancelled pill drag by name, where the pill stays", async () => {
    await using screen = await render(<Bar />);
    await expect.element(screen.getByRole("button", { name: "gamma" })).toBeVisible();
    const beta = screen.getByRole("button", { name: "beta" }).element();
    const gamma = screen.getByRole("button", { name: "gamma" }).element();
    const from = centreOf(beta);
    const announcer = () =>
      screen.container.querySelector('[id^="DndLiveRegion"]')?.textContent ?? "";
    using _timers = fakeTimers();

    await act(async () => {
      pointer("pointerdown", beta, from);
      pointer("pointermove", document, { x: from.x + 10, y: from.y });
    });
    await act(async () => pointer("pointermove", document, centreOf(gamma)));
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
      ),
    );

    expect(announcer()).toBe("Stopped moving beta. It stays at position 2 of 3.");
    expect(pillTitles(screen.container)).toEqual(["all", "alpha", "beta", "gamma"]);
    vi.advanceTimersByTime(50);
  });

  it("moves the focused pill with Alt+arrow keys, keeping focus and announcing its position", async () => {
    await using screen = await render(<Bar />);
    const alpha = screen.getByRole("button", { name: "alpha" });
    await expect
      .element(alpha)
      .toHaveAccessibleDescription("Press Alt+Left Arrow or Alt+Right Arrow to move this project.");

    alpha.element().focus();
    await act(() =>
      alpha
        .element()
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true }),
        ),
    );
    expect(pillTitles(screen.container)).toEqual(["all", "beta", "alpha", "gamma"]);
    expect(document.activeElement).toBe(alpha.element());
    // dnd-kit renders its own drag status region beside this one.
    await expect
      .element(screen.getByRole("status").filter({ hasText: "Moved" }))
      .toHaveTextContent("Moved alpha to position 2 of 3");

    await act(() =>
      alpha
        .element()
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true }),
        ),
    );
    expect(pillTitles(screen.container)).toEqual(["all", "alpha", "beta", "gamma"]);
    expect(document.activeElement).toBe(alpha.element());
    await expect
      .element(screen.getByRole("status").filter({ hasText: "Moved" }))
      .toHaveTextContent("Moved alpha to position 1 of 3");

    await act(() =>
      alpha
        .element()
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true }),
        ),
    );
    expect(pillTitles(screen.container)).toEqual(["all", "alpha", "beta", "gamma"]);
  });

  it("opens settings on Ctrl+click without selecting, and still selects on a later click", async () => {
    const onScopeChange = vi.fn();
    const onOpenProjectSettings = vi.fn();
    await using screen = await render(
      <Bar onScopeChange={onScopeChange} onOpenProjectSettings={onOpenProjectSettings} />,
    );
    const beta = screen.getByRole("button", { name: "beta" }).element();

    await act(() => {
      beta.dispatchEvent(new MouseEvent("contextmenu", { ctrlKey: true, bubbles: true }));
      beta.dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
    });
    expect(onOpenProjectSettings.mock.calls.map(([group]) => group.displayName)).toEqual(["beta"]);
    expect(onScopeChange.mock.calls).toEqual([]);

    await act(() => beta.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onScopeChange.mock.calls).toEqual([[keyOf("beta")]]);
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
        <ProjectSwitcherPager pages={pages} scopeKey={scopeKey} onScopeChange={setScopeKey} />
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

// Activates in place, as Enter on a focused pill does; a pointer click would
// first scroll an off-screen pill into view.
const activate = (element: Element) =>
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));

const scrollWhere = (element: HTMLElement, reached: (left: number) => boolean) =>
  new Promise<void>((resolve) => {
    const onScroll = () => {
      if (!reached(element.scrollLeft)) return;
      element.removeEventListener("scroll", onScroll);
      resolve();
    };
    element.addEventListener("scroll", onScroll);
  });

// Pill names of clearly different widths; the long one hits the pill's cap.
const wideGroups = snapshotsOf(["ab", "a much longer project name", "mid", "zz"]);
const wideKey = (name: string) =>
  wideGroups.find((group) => group.displayName.startsWith(name))!.projectKey;

function Switcher({
  initialKey,
  onScopeChange = ignore,
}: {
  initialKey: string | null;
  onScopeChange?: (key: string | null) => void;
}) {
  const [scopeKey, setScopeKey] = useState(initialKey);
  const [order, setOrder] = useState(wideGroups);
  const barRef = useRef<ComponentRef<typeof ProjectSwitcherBar>>(null);
  const route = useProjectPagerRoute({
    groups: order,
    scopeKey,
    enabled: true,
    onScopeChange: (key) => {
      onScopeChange(key);
      setScopeKey(key);
    },
  });
  return (
    <div
      data-sidebar="sidebar"
      style={{ display: "flex", flexDirection: "column", width: 200, height: 160 }}
    >
      <ProjectSwitcherBar
        ref={barRef}
        groups={order}
        scopeKey={scopeKey}
        targetKey={route.targetKey}
        onScopeChange={route.pick}
        onReorder={ignore}
        onOpenProjectSettings={ignore}
        renderBadge={() => null}
      />
      <ProjectSwitcherPager
        pages={route.scopes.map((scope) => ({
          scopeKey: scope?.projectKey ?? null,
          content: <p>{scope?.displayName ?? "all"}</p>,
        }))}
        scopeKey={scopeKey}
        targetKey={route.targetKey}
        onScopeChange={route.land}
        onSwipe={(progress) => barRef.current?.trackSwipe(progress)}
      />
      <button type="button" onClick={() => setOrder(wideGroups.slice(0, 3))}>
        drop the last project
      </button>
      <button type="button" onClick={() => setOrder(wideGroups.slice(1))}>
        drop the first project
      </button>
    </div>
  );
}

// Measured from the rendered boxes, independently of the bar's own arithmetic.
function barGeometry(container: HTMLElement) {
  const bar = container.querySelector<HTMLElement>("[data-project-switcher-bar]")!;
  const barLeft = bar.getBoundingClientRect().left;
  const pill = (name: string) => {
    const rect = bar
      .querySelector(`[data-scope-key="${CSS.escape(wideKey(name))}"]`)!
      .getBoundingClientRect();
    // Where the pill sits in the scrolled row.
    return { left: rect.left - barLeft + bar.scrollLeft, width: rect.width };
  };
  const highlight = bar.querySelector<HTMLElement>("[data-pill-highlight]")!;
  return {
    bar,
    pill,
    highlight,
    // The highlight's position on screen, relative to the bar's left edge.
    highlightScreenLeft: () => highlight.getBoundingClientRect().left - barLeft,
    highlightWidth: () => highlight.getBoundingClientRect().width,
  };
}

const near = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected), `${actual} ≈ ${expected}`).toBeLessThan(1);

function withoutSnap(pager: HTMLElement): Disposable {
  pager.style.scrollSnapType = "none";
  return { [Symbol.dispose]: () => pager.style.removeProperty("scroll-snap-type") };
}

describe("project switcher bar following the sidebar", () => {
  it("scrolls the pills under a highlight that stays put and resizes as a swipe goes, both ways", async () => {
    await using screen = await render(<Switcher initialKey={wideKey("ab")} />);
    const pager = pagerOf(screen.container);
    const { bar, pill, highlightScreenLeft, highlightWidth } = barGeometry(screen.container);
    const ab = pill("ab");
    const long = pill("a much");
    expect(long.width - ab.width).toBeGreaterThan(40);
    near(bar.scrollLeft, ab.left);
    near(highlightScreenLeft(), 0);
    near(highlightWidth(), ab.width);

    {
      using _snap = withoutSnap(pager);
      using _scrollEnd = withoutScrollEnd();
      await arriveAt(pager, 300);
      near(bar.scrollLeft, (ab.left + long.left) / 2);
      near(highlightScreenLeft(), 0);
      near(highlightWidth(), (ab.width + long.width) / 2);

      await arriveAt(pager, 250);
      near(bar.scrollLeft, ab.left + (long.left - ab.left) / 4);
      near(highlightScreenLeft(), 0);
      near(highlightWidth(), ab.width + (long.width - ab.width) / 4);
    }

    await swipeTo(pager, 400);
    await vi.waitFor(() =>
      expect(currentTitle(screen.container)).toBe(long && "a much longer project name"),
    );
    await vi.waitFor(() => near(bar.scrollLeft, long.left));
    await vi.waitFor(() => near(highlightScreenLeft(), 0));
    near(highlightWidth(), long.width);

    await swipeTo(pager, 0);
    await vi.waitFor(() => expect(currentTitle(screen.container)).toBe("ab"));
    await vi.waitFor(() => near(bar.scrollLeft, ab.left));
    await vi.waitFor(() => near(highlightScreenLeft(), 0));
    near(highlightWidth(), ab.width);
  });

  it("scrolling the pills directly neither pages the sidebar nor gets pulled back", async () => {
    await using screen = await render(<Switcher initialKey={wideKey("mid")} />);
    const pager = pagerOf(screen.container);
    const { bar, pill } = barGeometry(screen.container);
    near(bar.scrollLeft, pill("mid").left);
    await commands.wheel("[data-project-switcher-bar]", -60, 0);
    await vi.waitFor(() => near(bar.scrollLeft, pill("mid").left - 60));
    expect(currentTitle(screen.container)).toBe("mid");
    expect(pager.scrollLeft).toBe(200);
  });
});

describe("picking a pill directly", () => {
  it("draws the highlight to the pill, scrolls the sidebar through every project between, then selects it once", async () => {
    const onScopeChange = vi.fn();
    await using screen = await render(
      <Switcher initialKey={wideKey("ab")} onScopeChange={onScopeChange} />,
    );
    const pager = pagerOf(screen.container);
    const { bar, pill, highlight, highlightScreenLeft, highlightWidth } = barGeometry(
      screen.container,
    );
    const ab = pill("ab");
    const zz = pill("zz");
    const passed = new Set<string>();
    const positions: number[] = [];
    pager.addEventListener("scroll", () => {
      positions.push(pager.scrollLeft);
      const onScreen = Array.from(pager.children).find(
        (page) => page instanceof HTMLElement && Math.abs(page.offsetLeft - pager.scrollLeft) < 100,
      );
      if (onScreen?.textContent) passed.add(onScreen.textContent);
    });

    // Activated in place, as Enter on a focused pill does; a pointer click
    // would first scroll the off-screen pill into view.
    await act(() =>
      screen
        .getByRole("button", { name: "zz" })
        .element()
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    // Every page on the way is mounted, the selection has not moved, and the
    // highlight is heading for the picked pill while the row holds still.
    expect(pageTitles(screen.container)).toEqual(["ab", "a much longer project name", "mid", "zz"]);
    expect(onScopeChange).not.toHaveBeenCalled();
    near(bar.scrollLeft, ab.left);
    near(new DOMMatrix(highlight.style.transform).m41, zz.left);
    expect(getComputedStyle(highlight).transitionDuration).not.toBe("0s");

    await vi.waitFor(() => expect(currentTitle(screen.container)).toBe("zz"));
    expect(onScopeChange.mock.calls).toEqual([[wideKey("zz")]]);
    expect(passed).toEqual(new Set(["ab", "a much longer project name", "mid", "zz"]));
    expect(positions.some((left) => left > 200 && left < 400)).toBe(true);
    expect(pageTitles(screen.container)).toEqual(["mid", "zz"]);
    // The last pill still reaches the left edge.
    await vi.waitFor(() => near(bar.scrollLeft, zz.left));
    await vi.waitFor(() => near(highlightScreenLeft(), 0));
    await vi.waitFor(() => near(highlightWidth(), zz.width));

    onScopeChange.mockClear();
    passed.clear();
    await screen.getByRole("button", { name: "ab" }).click();
    expect(pageTitles(screen.container)).toEqual(["ab", "a much longer project name", "mid", "zz"]);
    await vi.waitFor(() => expect(currentTitle(screen.container)).toBe("ab"));
    expect(onScopeChange.mock.calls).toEqual([[wideKey("ab")]]);
    expect(passed).toEqual(new Set(["zz", "mid", "a much longer project name", "ab"]));
    await vi.waitFor(() => near(bar.scrollLeft, ab.left));
  });

  it("follows a second pick made on the way back, selecting only the latest pill, once", async () => {
    const onScopeChange = vi.fn();
    await using screen = await render(
      <Switcher initialKey={wideKey("zz")} onScopeChange={onScopeChange} />,
    );
    const pager = pagerOf(screen.container);
    const { bar, pill } = barGeometry(screen.container);
    const long = pill("a much");

    await act(() => activate(screen.getByRole("button", { name: "ab" }).element()));
    // Re-picked as the scroll passes over mid.
    await scrollWhere(pager, (left) => left < 450);
    await act(() =>
      activate(screen.getByRole("button", { name: "a much longer project name" }).element()),
    );
    // The pages on the way stay put; only where the scroll is headed changes.
    expect(pageTitles(screen.container)).toEqual(["ab", "a much longer project name", "mid", "zz"]);

    await vi.waitFor(() =>
      expect(currentTitle(screen.container)).toBe("a much longer project name"),
    );
    expect(onScopeChange.mock.calls).toEqual([[wideKey("a much")]]);
    await vi.waitFor(() => near(bar.scrollLeft, long.left));
  });

  it("reaches a pill further back picked on the way, through every page between", async () => {
    const onScopeChange = vi.fn();
    await using screen = await render(
      <Switcher initialKey={wideKey("zz")} onScopeChange={onScopeChange} />,
    );
    const pager = pagerOf(screen.container);
    const { bar, pill } = barGeometry(screen.container);
    const ab = pill("ab");

    await act(() => activate(screen.getByRole("button", { name: "mid" }).element()));
    // Nearly on mid, so placing the pages before it snaps the pager onto mid,
    // which must not count as landing there.
    await scrollWhere(pager, (left) => left < 90);
    const passed = new Set<string>();
    pager.addEventListener("scroll", () => {
      const onScreen = Array.from(pager.children).find(
        (page) => page instanceof HTMLElement && Math.abs(page.offsetLeft - pager.scrollLeft) < 100,
      );
      if (onScreen?.textContent) passed.add(onScreen.textContent);
    });
    await act(() => activate(screen.getByRole("button", { name: "ab" }).element()));
    expect(pageTitles(screen.container)).toEqual(["ab", "a much longer project name", "mid", "zz"]);

    await vi.waitFor(() => expect(currentTitle(screen.container)).toBe("ab"));
    expect(onScopeChange.mock.calls).toEqual([[wideKey("ab")]]);
    expect(passed.has("a much longer project name")).toBe(true);
    await vi.waitFor(() => near(bar.scrollLeft, ab.left));
  });

  it("selects a pill the scroll already passed when it is picked on the way", async () => {
    const onScopeChange = vi.fn();
    await using screen = await render(
      <Switcher initialKey={wideKey("ab")} onScopeChange={onScopeChange} />,
    );
    const pager = pagerOf(screen.container);

    await act(() => activate(screen.getByRole("button", { name: "zz" }).element()));
    // Past long, which sits at 200.
    await scrollWhere(pager, (left) => left > 450);
    await act(() =>
      activate(screen.getByRole("button", { name: "a much longer project name" }).element()),
    );

    await vi.waitFor(() =>
      expect(currentTitle(screen.container)).toBe("a much longer project name"),
    );
    expect(onScopeChange.mock.calls).toEqual([[wideKey("a much")]]);
    expect(currentPage(screen.container).inert).toBe(false);
  });

  it("scrolls back without selecting anything when the current pill is picked on the way", async () => {
    const onScopeChange = vi.fn();
    await using screen = await render(
      <Switcher initialKey={wideKey("ab")} onScopeChange={onScopeChange} />,
    );
    const pager = pagerOf(screen.container);
    const { bar, pill } = barGeometry(screen.container);
    const ab = pill("ab");

    await act(() => activate(screen.getByRole("button", { name: "zz" }).element()));
    await scrollWhere(pager, (left) => left > 250);
    await act(() => activate(screen.getByRole("button", { name: "ab" }).element()));

    await vi.waitFor(() =>
      expect(pageTitles(screen.container)).toEqual(["all", "ab", "a much longer project name"]),
    );
    expect(currentTitle(screen.container)).toBe("ab");
    expect(pager.scrollLeft).toBe(200);
    expect(onScopeChange).not.toHaveBeenCalled();
    await vi.waitFor(() => near(bar.scrollLeft, ab.left));
  });

  it("stays put when a pick is taken back before the scroll moves", async () => {
    const onScopeChange = vi.fn();
    await using screen = await render(
      <Switcher initialKey={wideKey("ab")} onScopeChange={onScopeChange} />,
    );
    const pager = pagerOf(screen.container);

    await act(() => {
      activate(screen.getByRole("button", { name: "zz" }).element());
      activate(screen.getByRole("button", { name: "ab" }).element());
    });
    expect(pageTitles(screen.container)).toEqual(["all", "ab", "a much longer project name"]);
    expect(currentTitle(screen.container)).toBe("ab");
    expect(pager.scrollLeft).toBe(200);
    expect(onScopeChange).not.toHaveBeenCalled();
  });

  it.each([
    {
      direction: "forward",
      from: "ab",
      pick: "zz",
      drop: "drop the last project",
      // Past long's page, the first one on the way.
      reached: (left: number) => left > 220,
      pages: ["all", "ab", "a much longer project name"],
    },
    {
      // All keeps its place at the start, so no page moves before it.
      direction: "forward from all",
      from: "all",
      pick: "zz",
      drop: "drop the last project",
      reached: (left: number) => left > 220,
      pages: ["all", "ab"],
    },
    {
      direction: "backward",
      from: "zz",
      pick: "ab",
      drop: "drop the first project",
      // Over mid's page, which sits at 400 on the way.
      reached: (left: number) => left < 420,
      pages: ["mid", "zz"],
    },
  ])(
    "stays on its project when the picked one disappears after the scroll is well under way ($direction)",
    async ({ from, pick, drop, reached, pages }) => {
      const onScopeChange = vi.fn();
      const fromKey = from === "all" ? null : wideKey(from);
      await using screen = await render(
        <Switcher initialKey={fromKey} onScopeChange={onScopeChange} />,
      );
      const pager = pagerOf(screen.container);

      await act(() => activate(screen.getByRole("button", { name: pick, exact: true }).element()));
      await scrollWhere(pager, reached);
      const settled = new Promise((resolve) =>
        pager.addEventListener("scrollend", resolve, { once: true }),
      );
      await act(async () => {
        activate(screen.getByRole("button", { name: drop }).element());
        await settled;
      });

      expect(pageTitles(screen.container)).toEqual(pages);
      expect(currentTitle(screen.container)).toBe(from);
      expect(pager.scrollLeft).toBe(pageOf(screen.container, fromKey).offsetLeft);
      expect(onScopeChange).not.toHaveBeenCalled();
    },
  );

  it("selects at once under reduced motion", async () => {
    await using _motion = await reduceMotion();
    const onScopeChange = vi.fn();
    await using screen = await render(
      <Switcher initialKey={wideKey("ab")} onScopeChange={onScopeChange} />,
    );
    const { bar, pill } = barGeometry(screen.container);
    const zz = pill("zz");

    await screen.getByRole("button", { name: "zz" }).click();
    expect(onScopeChange.mock.calls).toEqual([[wideKey("zz")]]);
    expect(pageTitles(screen.container)).toEqual(["mid", "zz"]);
    near(bar.scrollLeft, zz.left);
  });

  it("stays on its project when the picked one disappears on the way", async () => {
    const onScopeChange = vi.fn();
    await using screen = await render(
      <Switcher initialKey={wideKey("ab")} onScopeChange={onScopeChange} />,
    );
    const pager = pagerOf(screen.container);

    await screen.getByRole("button", { name: "zz" }).click();
    // Remove it once the scroll towards it is under way.
    await nextScroll(pager);
    const settled = new Promise((resolve) =>
      pager.addEventListener("scrollend", resolve, { once: true }),
    );
    await act(async () => {
      screen
        .getByRole("button", { name: "drop the last project" })
        .element()
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settled;
    });

    expect(pageTitles(screen.container)).toEqual(["all", "ab", "a much longer project name"]);
    expect(currentTitle(screen.container)).toBe("ab");
    expect(pager.scrollLeft).toBe(200);
    expect(onScopeChange).not.toHaveBeenCalled();
  });
});

import { useLocation } from "@tanstack/react-router";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../../test/render";
import {
  usePullRequestHistorySelection,
  usePullRequestNavigation,
} from "./usePullRequestNavigation";
import {
  PULL_REQUESTS_PANEL_REF,
  selectSelectedRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";

function HistorySelection() {
  const raw = useLocation({ select: (location) => location.search });
  const search = {
    repository: typeof raw.repository === "string" ? raw.repository : undefined,
    number: typeof raw.number === "number" ? raw.number : undefined,
    tab: raw.tab === "code" ? ("code" as const) : undefined,
  };
  const selection =
    search.repository && search.number
      ? {
          repository: search.repository,
          number: search.number,
          projectId: ProjectId.make("navigation-project"),
          environmentId: EnvironmentId.make("navigation-environment"),
        }
      : null;
  usePullRequestHistorySelection(PULL_REQUESTS_PANEL_REF, selection, search);
  const panel = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, PULL_REQUESTS_PANEL_REF),
  );
  const surface = useRightPanelStore((state) =>
    selectSelectedRightPanelSurface(state.byThreadKey, PULL_REQUESTS_PANEL_REF),
  );
  return (
    <output aria-label="PR view">
      {panel.isOpen && surface?.kind === "pull-request"
        ? `${surface.number}:${surface.detailTab ?? "summary"}`
        : "list"}
    </output>
  );
}

function Navigation() {
  const updateSearch = usePullRequestNavigation();
  const href = useLocation({ select: (location) => location.href });
  return (
    <>
      <output>{href}</output>
      <button onClick={() => updateSearch({ involvement: "reviewing" })}>Reviewing</button>
      <button onClick={() => updateSearch({ number: 12, repository: "owner/repo" })}>PR 12</button>
      <button onClick={() => updateSearch({ number: 34, repository: "owner/repo" })}>PR 34</button>
      <button onClick={() => updateSearch({ tab: "code" })}>Code</button>
      <input aria-label="Search" onChange={(event) => updateSearch({ q: event.target.value })} />
    </>
  );
}

describe("PR navigation history", () => {
  it("restores the visible selection and detail tab, and closes details on return to the list", async () => {
    const previous = useRightPanelStore.getState();
    useRightPanelStore.setState({ byThreadKey: {} });
    using _store = { [Symbol.dispose]: () => useRightPanelStore.setState(previous, true) };
    await using screen = await render(
      <>
        <Navigation />
        <HistorySelection />
      </>,
      { router: "/pull-requests?involvement=all&state=open" },
    );
    const router = screen.router!;
    await screen.getByRole("button", { name: "PR 12", exact: true }).click();
    await screen.getByRole("button", { name: "Code", exact: true }).click();
    await expect.element(screen.getByLabelText("PR view")).toHaveTextContent("12:code");
    await act(() => router.history.back());
    await expect.element(screen.getByLabelText("PR view")).toHaveTextContent("12:summary");
    await act(() => router.history.back());
    await expect.element(screen.getByLabelText("PR view")).toHaveTextContent("list");
    await act(() => router.history.forward());
    await expect.element(screen.getByLabelText("PR view")).toHaveTextContent("12:summary");
    await act(() => router.history.forward());
    await expect.element(screen.getByLabelText("PR view")).toHaveTextContent("12:code");
  });

  it("revisits the list, filters, and selected PRs before leaving the page", async () => {
    await using screen = await render(<Navigation />, { router: "/env/thread-a" });
    const router = screen.router!;
    await act(() => router.navigate({ href: "/pull-requests?involvement=all&state=open" }));
    const list = router.state.location.href;
    await screen.getByRole("button", { name: "Reviewing", exact: true }).click();
    const reviewing = router.state.location.href;
    await screen.getByRole("button", { name: "PR 12", exact: true }).click();
    const firstPr = router.state.location.href;
    await screen.getByRole("button", { name: "PR 34", exact: true }).click();
    const secondPr = router.state.location.href;

    for (const href of [firstPr, reviewing, list, "/env/thread-a"]) {
      await act(() => router.history.back());
      expect(router.state.location.href).toBe(href);
    }
    for (const href of [list, reviewing, firstPr, secondPr]) {
      await act(() => router.history.forward());
      expect(router.state.location.href).toBe(href);
    }
  });

  it("keeps query edits in one entry without replacing a previously selected PR", async () => {
    await using screen = await render(<Navigation />, {
      router: "/pull-requests?involvement=all&state=open",
    });
    const router = screen.router!;
    await screen.getByRole("button", { name: "PR 12", exact: true }).click();
    const firstPr = router.state.location.href;
    await screen.getByRole("button", { name: "PR 34", exact: true }).click();
    const beforeTyping = router.history.length;
    await screen.getByRole("textbox", { name: "Search" }).fill("fix");
    await screen.getByRole("textbox", { name: "Search" }).fill("fix navigation");
    expect(router.history.length).toBe(beforeTyping);
    await act(() => router.history.back());
    expect(router.state.location.href).toBe(firstPr);
  });

  it("records the selected PR detail tab and restores it with Back and Forward", async () => {
    await using screen = await render(<Navigation />, {
      router: "/pull-requests?involvement=all&state=open&repository=owner%2Frepo&number=12",
    });
    const router = screen.router!;
    const summary = router.state.location.href;
    await screen.getByRole("button", { name: "Code", exact: true }).click();
    expect(router.state.location.search).toMatchObject({ number: 12, tab: "code" });
    await act(() => router.history.back());
    expect(router.state.location.href).toBe(summary);
    await act(() => router.history.forward());
    expect(router.state.location.search).toMatchObject({ number: 12, tab: "code" });
  });
});

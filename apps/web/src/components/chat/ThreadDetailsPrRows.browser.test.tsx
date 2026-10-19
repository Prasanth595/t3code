import "~/index.css";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({ loaded: false, watchCommand: vi.fn() }));

vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useProjects: () => [],
  useServerConfigs: (() => new Map()) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => state.watchCommand) as never,
}));
const detail = {
  number: 2,
  title: "Change 2",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  headBranch: "layer-two",
  baseBranch: "layer-one",
  changedFiles: 1,
  additions: 1,
  deletions: 0,
  checks: [],
  capabilities: { actions: ["merge"], mergeMethods: ["merge"] },
  viewerPermissions: { actions: ["merge"] },
  mergeCapabilities: { merge: true, squash: false, rebase: false },
};
vi.mock(import("~/state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuerySelector: ((_atom: unknown, select: (result: unknown) => unknown) =>
    select(AsyncResult.success(state.loaded ? detail : null))) as never,
  useEnvironmentQueryIsNewer: () => true,
  useEnvironmentQueryRefresh: () => ({ refresh: vi.fn(), isPending: () => false }),
}));
vi.mock(import("../pullRequest/usePullRequestActions"), async (importOriginal) => ({
  ...(await importOriginal()),
  usePullRequestActionRunner: () => ({ actionPending: false, perform: vi.fn() }),
  usePullRequestHandoffs: () => ({ handoff: null, startAsk: vi.fn(), startHandoff: vi.fn() }),
}));

import { linkedPullRequestSnapshotStatus } from "../ThreadStatusIndicators";
import { ThreadDetailsPrRows } from "./ThreadDetailsPrRows";

function link(
  number: number,
  headBranch: string,
  baseBranch: string,
  updatedAt: string,
  repository = "pingdotgg/t3code",
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository,
    number,
    url: `https://github.com/${repository}/pull/${number}`,
    source: "manual",
    linkedAt: updatedAt,
    snapshot: {
      state: "open",
      title: `Change ${number}`,
      headBranch,
      baseBranch,
      isDraft: false,
      updatedAt,
      syncedAt: updatedAt,
    },
    stack: null,
  };
}

const bottom = link(1, "layer-one", "main", "2026-01-01T00:00:10.000Z");
const top = link(2, "layer-two", "layer-one", "2026-01-01T00:00:20.000Z");
const other = link(3, "unrelated", "main", "2026-01-01T00:00:05.000Z");

const project: EnvironmentProject = {
  environmentId: EnvironmentId.make("environment"),
  id: ProjectId.make("project"),
  title: "T3 Code",
  workspaceRoot: "/workspace/t3code",
  repositoryIdentity: {
    canonicalKey: "github.com/pingdotgg/t3code",
    provider: "github",
    owner: "pingdotgg",
    name: "t3code",
    locator: {
      source: "git-remote",
      remoteName: "upstream",
      remoteUrl: "https://github.com/pingdotgg/t3code.git",
    },
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.loaded = false;
  state.watchCommand.mockClear();
  container = document.createElement("div");
  container.style.width = "240px";
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(
  links: ReadonlyArray<ThreadPullRequestLink>,
  current: ThreadPullRequestLink,
  threadProject: EnvironmentProject | null = project,
) {
  act(() => {
    root.render(
      <ThreadDetailsPrRows
        threadRef={{
          environmentId: EnvironmentId.make("environment"),
          threadId: ThreadId.make("thread"),
        }}
        links={links}
        currentLink={current}
        onOpenLink={vi.fn()}
        environmentId={EnvironmentId.make("environment")}
        pr={linkedPullRequestSnapshotStatus(current)?.pr ?? null}
        number={current.number}
        reference={current}
        status={null}
        project={threadProject}
        label={`#${current.number}: ${current.snapshot?.title ?? ""}`}
        openAriaLabel={current.url}
        onOpen={vi.fn()}
      />,
    );
  });
}

const rowButtons = () => [
  ...container.querySelectorAll<HTMLButtonElement>('button[aria-label^="https://"]'),
];
const rows = () => rowButtons().map((button) => button.textContent?.trim());
const toggleButton = () =>
  [...container.querySelectorAll("button")].find((button) =>
    /^(Show \d+ more|Show less)$/.test(button.textContent?.trim() ?? ""),
  );
const toggleLabel = () => toggleButton()?.textContent?.trim();

function toggle() {
  act(() => toggleButton()!.click());
}

it("shows only the current pull request until the rest are asked for", () => {
  render([other, bottom, top], top);
  expect(rows()).toEqual(["#2: Change 2"]);
  expect(toggleLabel()).toBe("Show 2 more");

  toggle();
  expect(rows()).toEqual(["#2: Change 2", "#1: Change 1", "#3: Change 3"]);
  expect(toggleLabel()).toBe("Show less");

  toggle();
  expect(rows()).toEqual(["#2: Change 2"]);
  expect(toggleLabel()).toBe("Show 2 more");
});

it("keeps the single row untouched when the thread links one pull request", () => {
  render([bottom], bottom);
  expect(rows()).toEqual(["#1: Change 1"]);
  expect(toggleLabel()).toBeUndefined();
});

it("lets only watched pull requests stop their watch", () => {
  const watched: ThreadPullRequestLink = {
    ...bottom,
    watch: {
      startedAt: "2026-01-01T00:00:30.000Z",
      headSha: null,
      failedChecks: [],
      passed: false,
      passedChecks: [],
      remarksThrough: "2026-01-01T00:00:30.000Z",
      remarkIds: [],
      conflicting: false,
      wakes: 0,
    },
  };
  render([other, watched, top], top);
  toggle();
  const stopButtons = [...container.querySelectorAll("button")].filter((button) =>
    button.getAttribute("aria-label")?.startsWith("Stop watching"),
  );
  expect(stopButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
    "Stop watching #1",
  ]);

  act(() => stopButtons[0]!.click());
  expect(state.watchCommand).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("environment"),
    input: {
      threadId: ThreadId.make("thread"),
      host: "github.com",
      repository: "pingdotgg/t3code",
      number: 1,
      watching: false,
    },
  });
});

it.each([
  { name: "known project", threadProject: project, ownPrefix: "" },
  { name: "unknown project", threadProject: null, ownPrefix: "pingdotgg/t3code" },
])(
  "labels primary and expanded rows by repository with a $name",
  ({ threadProject, ownPrefix }) => {
    const foreign = link(3, "unrelated", "main", "2026-01-01T00:00:05.000Z", "vercel/next.js");
    render([bottom, top, foreign], top, threadProject);
    expect(rows()).toEqual([`${ownPrefix}#2: Change 2`]);
    toggle();
    expect(rows()).toEqual([
      `${ownPrefix}#2: Change 2`,
      `${ownPrefix}#1: Change 1`,
      "vercel/next.js#3: Change 3",
    ]);

    render([bottom, top, foreign], foreign, threadProject);
    expect(rows()[0]).toBe("vercel/next.js#3: Change 3");
  },
);

it("keeps the same repository reference in the row and tooltip before and after details load", async () => {
  for (const loaded of [false, true]) {
    state.loaded = loaded;
    render([top], top);
    const button = rowButtons()[0]!;
    await act(() => userEvent.hover(button));
    await expect
      .poll(() => document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent)
      .toContain("#2");
    expect
      .soft(document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent)
      .not.toContain("pingdotgg/t3code");
    await act(() => userEvent.unhover(button));
    await expect
      .poll(() => document.querySelector('[data-slot="tooltip-popup"][data-open]'))
      .toBeNull();
  }
});

it("fits long repository references and their tooltips without hiding row controls", async () => {
  state.loaded = true;
  const repository = "a-very-long-organization-name/a-repository-with-a-very-long-descriptive-name";
  const long = link(2, "layer-two", "main", "2026-01-01T00:00:20.000Z", repository);
  render([long], long);
  expect(container.textContent).toContain(`${repository}#2`);
  expect.soft(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
  const merge = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Merge",
  )!;
  const panelBounds = container.getBoundingClientRect();
  const mergeBounds = merge.getBoundingClientRect();
  expect.soft(mergeBounds.right).toBeLessThanOrEqual(panelBounds.right);
  expect
    .soft(
      document.elementFromPoint(
        mergeBounds.x + mergeBounds.width / 2,
        mergeBounds.y + mergeBounds.height / 2,
      ),
    )
    .toBe(merge);

  await act(() => userEvent.hover(rowButtons()[0]!));
  await expect
    .poll(() => document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent)
    .toContain(`${repository}#2`);
  const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"][data-open]')!;
  const reference = [...tooltip.querySelectorAll("span")].find(
    (span) => span.textContent === `${repository}#2`,
  )!;
  expect.soft(tooltip.scrollWidth).toBeLessThanOrEqual(tooltip.clientWidth);
  expect
    .soft(reference.getBoundingClientRect().right)
    .toBeLessThanOrEqual(tooltip.getBoundingClientRect().right);
});

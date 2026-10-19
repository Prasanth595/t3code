import "~/index.css";

import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const environmentId = EnvironmentId.make("primary");
const scratchRoot = "/home/user/.t3/scratch";

const state = vi.hoisted(() => ({ projects: [] as readonly unknown[] }));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useProjects: (() => state.projects) as never,
  useThreadShells: (() => []) as never,
}));
vi.mock(import("../../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironments: (() => ({ environments: [] })) as never,
  usePrimaryEnvironmentId: (() => environmentId) as never,
}));
vi.mock(import("../../hooks/useScratchProject"), async (importOriginal) => ({
  ...(await importOriginal()),
  useScratchProject: (() => ({
    scratchEnvironmentId: () => environmentId,
    scratchWorkspaceRootFor: () => scratchRoot,
    openScratchProject: async () => null,
    startScratchThread: async () => {},
  })) as never,
}));
vi.mock(import("../../hooks/useHandleNewThread"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNewThreadHandler: (() => async () => {}) as never,
}));

import { DraftHeroHeadline } from "./DraftHeroHeadline";

const makeProject = (id: string, title: string, workspaceRoot: string): EnvironmentProject => ({
  id: ProjectId.make(id),
  environmentId,
  title,
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const scratchProject = makeProject("scratch", "scratch", scratchRoot);
const LONG_PROJECT_TITLE = "an-extremely-long-project-directory-name-that-cannot-fit";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  container.style.width = "320px";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function renderHeadline(activeProject: EnvironmentProject) {
  state.projects = [scratchProject, activeProject];
  await act(async () => {
    root.render(
      <DraftHeroHeadline
        draftId={null}
        activeProjectRef={scopeProjectRef(environmentId, activeProject.id)}
        activeProjectTitle={activeProject.title}
      />,
    );
  });
  const trigger = container.querySelector<HTMLElement>("[data-draft-project-trigger]");
  expect(trigger).not.toBeNull();
  return trigger!;
}

// DraftProjectName keeps the full name in `aria-label` and shows the fitted text in that span.
const visiblePickerText = (trigger: HTMLElement) =>
  trigger.querySelector("[aria-label]")?.textContent;

describe("DraftHeroHeadline project picker", () => {
  it("shows 'No project' in full when the picker stands alone in the subtitle", async () => {
    const trigger = await renderHeadline(scratchProject);

    expect(trigger.closest("h1")).toBeNull();
    expect(visiblePickerText(trigger)).toBe("No project");
  });

  it("keeps the trailing '?' inside the headline when the project name is too long", async () => {
    const trigger = await renderHeadline(
      makeProject("long", LONG_PROJECT_TITLE, "/work/long-project"),
    );

    const heading = trigger.closest("h1");
    expect(heading).not.toBeNull();
    expect(visiblePickerText(trigger)).toContain("…");

    const questionMark = document.createRange();
    const textNode = trigger.parentElement!.lastChild!;
    expect(textNode.textContent).toBe("?");
    questionMark.selectNodeContents(textNode);
    expect(questionMark.getBoundingClientRect().right).toBeLessThanOrEqual(
      heading!.getBoundingClientRect().right,
    );
  });
});

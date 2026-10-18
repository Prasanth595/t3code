import type { FileTree as FileTreeModel } from "@pierre/trees";
import { EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const { listEntries, captured } = vi.hoisted(() => ({
  listEntries: vi.fn(),
  captured: { model: null as unknown },
}));
vi.mock("~/state/projects", async () => {
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  return {
    projectEnvironment: {
      listEntries: (request: unknown) => Atom.make(Effect.promise(() => listEntries(request))),
    },
  };
});
vi.mock("~/state/queries", () => ({
  useProjectPathSearch: () => ({
    entries: [],
    isPending: false,
    error: null,
    truncated: false,
    refresh: () => {},
  }),
}));
vi.mock("~/fileContextMenu", () => ({
  useFileContextMenu: () => ({ buildItems: () => [], activate: async () => {} }),
}));
// Read the tree model the panel builds, so tests can open a folder the way a click does.
vi.mock(import("@pierre/trees/react"), async (original) => {
  const actual = await original();
  const RealFileTree = actual.FileTree;
  return {
    ...actual,
    FileTree: ((props: ComponentProps<typeof RealFileTree>) => {
      captured.model = props.model;
      return <RealFileTree {...props} />;
    }) as typeof RealFileTree,
  };
});

import FileBrowserPanel from "./FileBrowserPanel";

const directory = (path: string, ignored = false): ProjectEntry =>
  ignored ? { path, kind: "directory", ignored } : { path, kind: "directory" };
const file = (path: string, ignored = false): ProjectEntry =>
  ignored ? { path, kind: "file", ignored } : { path, kind: "file" };

const workspace: Record<string, readonly ProjectEntry[]> = {
  "": [directory("src"), directory("node_modules", true), file("README.md")],
  src: [directory("src/lib"), file("src/index.ts")],
  "src/lib": [file("src/lib/util.ts")],
  node_modules: [directory("node_modules/react", true), file("node_modules/.modules.yaml", true)],
  "node_modules/react": [file("node_modules/react/index.js", true)],
};

let root: Root | null;
let container: HTMLDivElement;
let listed: string[];

const model = () => captured.model as FileTreeModel;

function toggleButton(label: "Expand all folders" | "Collapse all folders") {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button, label).not.toBeNull();
  return button!;
}

async function waitForListing(path: string) {
  await vi.waitFor(() => expect(listed).toContain(path));
  await act(async () => {});
}

function folder(path: string) {
  const item = model().getItem(path);
  if (!item || !("isExpanded" in item)) throw new Error(`no folder ${path}`);
  return item;
}

async function setExpanded(path: string, expanded: boolean) {
  await act(async () => {
    if (expanded) folder(path).expand();
    else folder(path).collapse();
  });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  container.style.cssText = "display: flex; flex-direction: column; width: 320px; height: 480px";
  document.body.append(container);
  listed = [];
  listEntries.mockReset().mockImplementation(async (request) => {
    const path: string = request.input.directoryPath;
    listed.push(path);
    return { entries: workspace[path] ?? [], truncated: false };
  });
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("files-test")}
        cwd="/workspace"
        projectName="workspace"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />,
    ),
  );
  await waitForListing("");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

it("expands every folder except ignored ones, which it never lists", async () => {
  await act(async () => toggleButton("Expand all folders").click());
  await waitForListing("src/lib");

  expect(listed.toSorted()).toEqual(["", "src", "src/lib"]);
  expect(folder("node_modules/").isExpanded()).toBe(false);

  // Collapsing a folder by hand ends expand all. The button then reads every folder expanded
  // again once that folder reopens, with the ignored folder still collapsed.
  await setExpanded("src/lib/", false);
  toggleButton("Expand all folders");
  await setExpanded("src/lib/", true);
  toggleButton("Collapse all folders");
});

it("keeps folders inside an ignored folder opened by hand collapsed, and collapses all of it", async () => {
  await act(async () => toggleButton("Expand all folders").click());
  await waitForListing("src/lib");

  await setExpanded("node_modules/", true);
  await waitForListing("node_modules");
  expect(listed).not.toContain("node_modules/react");
  expect(folder("node_modules/react/").isExpanded()).toBe(false);

  await act(async () => toggleButton("Collapse all folders").click());
  expect(folder("node_modules/").isExpanded()).toBe(false);
  expect(folder("src/").isExpanded()).toBe(false);
});

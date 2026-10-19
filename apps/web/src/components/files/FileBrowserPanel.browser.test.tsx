import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ProjectEntry } from "@t3tools/contracts";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import FileBrowserPanel from "./FileBrowserPanel";
import {
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";

const threadRef = scopeThreadRef(
  EnvironmentId.make("test-environment"),
  ThreadId.make("files-test"),
);

type PanelProps = Omit<
  ComponentProps<typeof FileBrowserPanel>,
  "selectedPathRevealHandled" | "onSelectedPathRevealHandled"
> & { followActiveSurface?: boolean };

function TestPanel({ followActiveSurface = false, ...props }: PanelProps) {
  const surface = useRightPanelStore((state) =>
    followActiveSurface
      ? selectActiveRightPanelSurface(state.byThreadKey, threadRef)
      : selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces.find(
          (entry) => entry.kind === "file" && entry.relativePath === props.selectedPath,
        ),
  );
  const selectedPath = followActiveSurface
    ? surface?.kind === "file"
      ? surface.relativePath
      : null
    : props.selectedPath;
  const selectedPathRevealId = followActiveSurface
    ? surface?.kind === "file"
      ? surface.revealRequestId
      : 0
    : props.selectedPathRevealId;
  return (
    <FileBrowserPanel
      {...props}
      selectedPath={selectedPath}
      selectedPathRevealId={selectedPathRevealId}
      selectedPathRevealHandled={surface?.kind === "file" && surface.explorerRevealHandled === true}
      onSelectedPathRevealHandled={() => {
        if (selectedPath) {
          useRightPanelStore
            .getState()
            .markExplorerRevealHandled(threadRef, selectedPath, selectedPathRevealId);
        }
      }}
    />
  );
}

const files = vi.hoisted(() => ({
  directoryEntries: [] as ProjectEntry[],
  searchEntries: [] as ProjectEntry[],
  searchPending: false,
  searchError: null as string | null,
  loadedDirectories: new Set<string>() as ReadonlySet<string>,
  loadingDirectories: new Set<string>() as ReadonlySet<string>,
  load: vi.fn(async (_path: string) => {}),
  refresh: vi.fn(),
}));

vi.mock("./useDirectoryEntries", () => ({
  useDirectoryEntries: () => ({
    entries: files.directoryEntries,
    loadingDirectories: files.loadingDirectories,
    loadedDirectories: files.loadedDirectories,
    load: files.load,
    refresh: files.refresh,
    ready: true,
    error: null,
    isPending: false,
  }),
}));
vi.mock("~/state/queries", () => ({
  useProjectPathSearch: () => ({
    entries: files.searchEntries,
    isPending: files.searchPending,
    error: files.searchError,
    truncated: false,
    refresh: files.refresh,
  }),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: vi.fn() }));
vi.mock("~/composerHandleContext", () => ({ useComposerHandleContext: () => null }));
vi.mock("~/fileContextMenu", () => ({ useFileContextMenu: () => ({}) }));
vi.mock("~/localApi", () => ({ readLocalApi: () => undefined }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/components/MorphIcon", () => ({ MorphIcon: () => null }));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));

describe("Files panel", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  const props = {
    environmentId: EnvironmentId.make("test-environment"),
    cwd: "/workspace",
    projectName: "Test project",
    selectedPath: null,
    selectedPathRevealId: 0,
    onOpenFile: vi.fn(),
    workspaceMutationId: null,
  };

  async function render(overrides: Partial<PanelProps> = {}) {
    if (!container) {
      container = document.body.appendChild(document.createElement("div"));
      // The tree virtualizes its rows, so it needs a real viewport to render any.
      container.style.cssText =
        "display: flex; flex-direction: column; width: 320px; height: 480px;";
      root = createRoot(container);
    }
    const panelProps = { ...props, ...overrides };
    await act(async () => {
      if (panelProps.selectedPath) {
        const store = useRightPanelStore.getState();
        const surface = selectThreadRightPanelState(store.byThreadKey, threadRef).surfaces.find(
          (entry) => entry.kind === "file" && entry.relativePath === panelProps.selectedPath,
        );
        if (
          surface?.kind !== "file" ||
          surface.revealRequestId !== panelProps.selectedPathRevealId
        ) {
          store.openFile(threadRef, panelProps.selectedPath);
        }
      }
      root!.render(
        <TestPanel key={`${panelProps.environmentId}:${panelProps.cwd}`} {...panelProps} />,
      );
    });
  }

  async function remount(overrides: Partial<PanelProps> = {}) {
    await act(async () => root!.unmount());
    root = createRoot(container!);
    await render(overrides);
  }

  function treeRow(path: string) {
    return container!
      .querySelector("file-tree-container")!
      .shadowRoot!.querySelector<HTMLButtonElement>(`button[data-item-path="${path}"]`);
  }

  async function toggleFolder(path: string) {
    const row = treeRow(`${path}/`);
    expect(row).not.toBeNull();
    await act(async () => row!.click());
  }

  function searchInput() {
    const input = container!.querySelector<HTMLInputElement>('input[type="search"]');
    expect(input).not.toBeNull();
    return input!;
  }

  async function search(value: string) {
    const input = searchInput();
    // React tracks the last value it saw on the element, so set it through the native setter.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    await act(async () => {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function visiblePaths() {
    const tree = container!.querySelector("file-tree-container");
    if (!tree) return [];
    return [...tree.shadowRoot!.querySelectorAll("[data-item-path]")].map((row) =>
      row.getAttribute("data-item-path"),
    );
  }

  function hasMessage(message: string) {
    return [...container!.querySelectorAll("div")].some(
      (node) => node.childNodes.length === 1 && node.textContent === message,
    );
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    useRightPanelStore.setState({ byThreadKey: {} });
    vi.clearAllMocks();
    files.load.mockReset().mockResolvedValue(undefined);
    files.loadedDirectories = new Set(["", "src"]);
    files.loadingDirectories = new Set();
    files.directoryEntries = [
      { path: "src", kind: "directory" },
      { path: "src/app.ts", kind: "file" },
      { path: "package.json", kind: "file" },
    ];
    files.searchEntries = [];
    files.searchPending = false;
    files.searchError = null;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("shows no matching files instead of the full tree when a filename is absent", async () => {
    await render();
    expect(visiblePaths()).toEqual(["src/", "package.json"]);

    await search(".env.local");
    expect(visiblePaths()).toEqual([]);
    expect(hasMessage("No matching files.")).toBe(true);

    await search("package");
    expect(visiblePaths()).toEqual(["package.json"]);
    expect(hasMessage("No matching files.")).toBe(false);

    await search("");
    expect(visiblePaths()).toEqual(["src/", "package.json"]);
  });

  it("still finds ignored files already loaded from a directory", async () => {
    files.directoryEntries.push({ path: ".env.local", kind: "file", ignored: true });
    await render();
    await search(".env.local");
    expect(visiblePaths()).toEqual([".env.local"]);
    expect(hasMessage("No matching files.")).toBe(false);
  });

  it("waits for remote matches without showing unrelated files or a premature empty result", async () => {
    await render();
    files.searchPending = true;
    await search("settings.ts");
    expect(visiblePaths()).toEqual([]);
    expect(hasMessage("Loading files…")).toBe(true);
    expect(hasMessage("No matching files.")).toBe(false);

    files.searchEntries = [{ path: "config/settings.ts", kind: "file" }];
    files.searchPending = false;
    await render();
    expect(visiblePaths()).toEqual(["config/", "config/settings.ts"]);
    expect(hasMessage("No matching files.")).toBe(false);
  });

  it("restores the tree on Escape after an unsuccessful search", async () => {
    await render();
    await search("missing-file");
    expect(visiblePaths()).toEqual([]);

    const input = searchInput();
    input.focus();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.activeElement).not.toBe(input);
    expect(visiblePaths()).toEqual(["src/", "package.json"]);
    expect(hasMessage("No matching files.")).toBe(false);
  });

  it("does not report an empty result when the search failed", async () => {
    await render();
    files.searchError = "Workspace search failed.";
    await search("missing-file");
    expect(visiblePaths()).toEqual([]);
    expect(hasMessage("No matching files.")).toBe(false);
    expect(container!.textContent).toContain("Workspace search failed.");
  });

  it("remembers expansion and collapse across remounts without leaking between environments or workspaces", async () => {
    files.directoryEntries.push(
      { path: "docs", kind: "directory" },
      { path: "docs/guide.md", kind: "file" },
    );
    files.loadedDirectories = new Set(["", "src", "docs"]);
    await render();
    await toggleFolder("src");
    expect(visiblePaths()).toContain("src/app.ts");
    // A fresh panel must recover from durable browser storage, with no prior tree model.
    expect(
      JSON.parse(localStorage.getItem("t3code.fileTreeExpanded:test-environment:/workspace")!),
    ).toEqual(["src"]);
    await remount();
    expect(visiblePaths()).toContain("src/app.ts");
    await act(async () => {
      container!
        .querySelector("file-tree-container")!
        .shadowRoot!.querySelector<HTMLButtonElement>('button[data-item-path="src/"]')!
        .click();
      root!.render(<TestPanel key="replacement" {...props} />);
    });
    expect(visiblePaths()).not.toContain("src/app.ts");
    expect(localStorage.getItem("t3code.fileTreeExpanded:test-environment:/workspace")).toBeNull();
    await toggleFolder("src");

    await render({ environmentId: EnvironmentId.make("other-environment") });
    expect(visiblePaths()).not.toContain("src/app.ts");
    await toggleFolder("docs");
    expect(visiblePaths()).toContain("docs/guide.md");

    await render();
    expect(visiblePaths()).toContain("src/app.ts");
    expect(visiblePaths()).not.toContain("docs/guide.md");
    await render({ cwd: "/other-workspace" });
    expect(visiblePaths()).not.toContain("src/app.ts");
    expect(visiblePaths()).not.toContain("docs/guide.md");

    const retainedSelection = { selectedPath: "src/app.ts", selectedPathRevealId: 1 };
    await render(retainedSelection);
    expect(visiblePaths()).toContain("src/app.ts");
    await remount(retainedSelection);
    expect(visiblePaths()).toContain("src/app.ts");
    expect.soft(treeRow("src/app.ts")?.getAttribute("aria-selected")).toBe("true");
    await toggleFolder("src");
    expect(visiblePaths()).not.toContain("src/app.ts");
    await remount(retainedSelection);
    expect(visiblePaths()).not.toContain("src/app.ts");
    expect(localStorage.getItem("t3code.fileTreeExpanded:test-environment:/workspace")).toBeNull();

    await render({ ...retainedSelection, selectedPathRevealId: 2 });
    expect(visiblePaths()).toContain("src/app.ts");
    await toggleFolder("src");
    await act(async () => root!.unmount());
    // Reload the persisted surface as well as the tree, then open a new surface
    // whose reveal counter starts over at one.
    const savedSurfaceState = localStorage.getItem("t3code:right-panel-state:v2")!;
    useRightPanelStore.setState({ byThreadKey: {} });
    localStorage.setItem("t3code:right-panel-state:v2", savedSurfaceState);
    await useRightPanelStore.persist.rehydrate();
    root = createRoot(container!);
    await render({ ...retainedSelection, selectedPathRevealId: 2 });
    expect(visiblePaths()).not.toContain("src/app.ts");
    await act(async () => {
      root!.unmount();
      useRightPanelStore.getState().closeAllSurfaces(threadRef);
    });
    root = createRoot(container!);
    await render(retainedSelection);
    expect(visiblePaths()).toContain("src/app.ts");
  });

  it("loads remembered parents before restoring children as their listings arrive", async () => {
    localStorage.setItem(
      "t3code.fileTreeExpanded:test-environment:/workspace",
      JSON.stringify(["src", "src/components"]),
    );
    files.directoryEntries = [{ path: "src", kind: "directory" }];
    files.loadedDirectories = new Set([""]);
    await render();
    expect(files.load.mock.calls).toEqual([["src"]]);
    expect(
      JSON.parse(localStorage.getItem("t3code.fileTreeExpanded:test-environment:/workspace")!),
    ).toEqual(["src", "src/components"]);

    files.directoryEntries = [
      ...files.directoryEntries,
      { path: "src/app.ts", kind: "file" },
      { path: "src/components", kind: "directory" },
    ];
    files.loadedDirectories = new Set(["", "src"]);
    await render();
    expect(files.load.mock.calls).toEqual([["src"], ["src/components"]]);

    files.directoryEntries = [
      ...files.directoryEntries,
      { path: "src/components/Button.tsx", kind: "file" },
    ];
    files.loadedDirectories = new Set(["", "src", "src/components"]);
    await render();
    expect(visiblePaths()).toContain("src/app.ts");
    expect(visiblePaths()).toContain("src/components/Button.tsx");
  });

  it("reveals external opens and keeps selection in sync when returning to an acknowledged file tab", async () => {
    files.directoryEntries = [{ path: "src", kind: "directory" }];
    files.loadedDirectories = new Set([""]);
    const panelProps = {
      followActiveSurface: true,
      onOpenFile: vi.fn((path: string) => useRightPanelStore.getState().openFile(threadRef, path)),
    };
    useRightPanelStore.getState().openFile(threadRef, "src/app.ts");
    await render(panelProps);
    expect(files.load).toHaveBeenCalledWith("src");

    files.directoryEntries = [
      ...files.directoryEntries,
      { path: "src/app.ts", kind: "file" },
      { path: "src/other.ts", kind: "file" },
    ];
    files.loadedDirectories = new Set(["", "src"]);
    const storageWrite = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    try {
      await render(panelProps);
    } finally {
      storageWrite.mockRestore();
    }
    expect(visiblePaths()).toContain("src/app.ts");
    expect(treeRow("src/app.ts")?.getAttribute("aria-selected")).toBe("true");
    expect(panelProps.onOpenFile).not.toHaveBeenCalled();

    const tree = container!.querySelector("file-tree-container")!;
    await act(async () => useRightPanelStore.getState().openFile(threadRef, "src/other.ts"));
    expect(treeRow("src/other.ts")?.getAttribute("aria-selected")).toBe("true");
    const surfaces = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    ).surfaces;
    expect(
      surfaces.every((surface) => surface.kind === "file" && surface.explorerRevealHandled),
    ).toBe(true);

    await act(async () =>
      useRightPanelStore.getState().activateSurface(threadRef, "file:src/app.ts"),
    );
    expect(container!.querySelector("file-tree-container")).toBe(tree);
    expect.soft(treeRow("src/app.ts")?.getAttribute("aria-selected")).toBe("true");
    expect.soft(treeRow("src/other.ts")?.getAttribute("aria-selected")).toBe("false");
    await act(async () => treeRow("src/other.ts")!.click());
    expect(panelProps.onOpenFile).toHaveBeenCalledExactlyOnceWith("src/other.ts");
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef)?.id,
    ).toBe("file:src/other.ts");
  });

  it.each(["mounted", "remounted"])(
    "keeps a selected deep search result revealed when %s while its directory listings finish",
    async (lifecycle) => {
      const path = "src/one/two/three/four/five/target.ts";
      const segments = path.split("/");
      const directories = segments
        .slice(0, -1)
        .map((_, index) => segments.slice(0, index + 1).join("/"));
      const entries: ProjectEntry[] = [
        ...directories.map((path) => ({ path, kind: "directory" as const })),
        ...directories.map((path) => ({ path: `${path}/sibling.txt`, kind: "file" as const })),
        { path, kind: "file" },
      ];
      files.directoryEntries = [{ path: "src", kind: "directory" }];
      files.loadedDirectories = new Set([""]);
      const pending = new Map<string, { promise: Promise<void>; finish: () => void }>();
      files.load.mockImplementation((directory) => {
        if (files.loadedDirectories.has(directory)) return Promise.resolve();
        const existing = pending.get(directory);
        if (existing) return existing.promise;
        let resolveListing!: () => void;
        const promise = new Promise<void>((resolve) => {
          resolveListing = resolve;
        });
        pending.set(directory, {
          promise,
          finish: () => {
            files.directoryEntries = [
              ...files.directoryEntries,
              ...entries.filter(
                (entry) => entry.path.slice(0, entry.path.lastIndexOf("/")) === directory,
              ),
            ];
            files.loadedDirectories = new Set([...files.loadedDirectories, directory]);
            pending.delete(directory);
            resolveListing();
          },
        });
        return promise;
      });
      const panelProps = {
        followActiveSurface: true,
        onOpenFile: vi.fn((path: string) =>
          useRightPanelStore.getState().openFile(threadRef, path),
        ),
      };
      await render(panelProps);
      files.searchEntries = [{ path, kind: "file" }];
      await search("target.ts");
      expect(visiblePaths()).toContain(path);
      await act(async () => treeRow(path)!.click());
      expect(panelProps.onOpenFile).toHaveBeenCalledExactlyOnceWith(path);
      // Pierre closes search on a row click. Searching again before listings finish
      // exposes the selected file from search data before its ancestors have loaded.
      await search("target.ts");
      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
      ).toMatchObject({ relativePath: path });
      await search("target.ts");
      expect(searchInput().value).toBe("target.ts");

      if (lifecycle === "remounted") {
        // Search-only ancestors disappear on remount before the real listings arrive.
        files.searchEntries = [];
        await remount(panelProps);
        expect(visiblePaths()).not.toContain(path);
      }

      // Only requested listings can contribute entries; a search hit is not a loaded directory.
      for (let batch = 0; pending.size > 0 && batch < directories.length; batch++) {
        await act(async () => {
          for (const request of pending.values()) request.finish();
        });
        await render(panelProps);
      }
      expect(pending.size).toBe(0);
      await act(async () =>
        searchInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );
      expect(searchInput().value).toBe("");
      expect(visiblePaths()).toContain(path);
      expect(treeRow(path)?.getAttribute("aria-selected")).toBe("true");
    },
  );
});

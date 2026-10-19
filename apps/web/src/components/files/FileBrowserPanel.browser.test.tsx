import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ProjectEntry } from "@t3tools/contracts";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import FileBrowserPanel from "./FileBrowserPanel";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

const threadRef = scopeThreadRef(
  EnvironmentId.make("test-environment"),
  ThreadId.make("files-test"),
);

type PanelProps = Omit<
  ComponentProps<typeof FileBrowserPanel>,
  "selectedPathRevealHandled" | "onSelectedPathRevealHandled"
>;

function TestPanel(props: PanelProps) {
  const surface = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces.find(
      (entry) => entry.kind === "file" && entry.relativePath === props.selectedPath,
    ),
  );
  return (
    <FileBrowserPanel
      {...props}
      selectedPathRevealHandled={surface?.kind === "file" && surface.explorerRevealHandled === true}
      onSelectedPathRevealHandled={() => {
        if (props.selectedPath) {
          useRightPanelStore
            .getState()
            .markExplorerRevealHandled(threadRef, props.selectedPath, props.selectedPathRevealId);
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

  async function toggleFolder(path: string) {
    const row = container!
      .querySelector("file-tree-container")!
      .shadowRoot!.querySelector<HTMLButtonElement>(`button[data-item-path="${path}/"]`);
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

  it("still reveals an externally selected file when no expansion was saved", async () => {
    files.directoryEntries = [{ path: "src", kind: "directory" }];
    files.loadedDirectories = new Set([""]);
    await render({ selectedPath: "src/app.ts", selectedPathRevealId: 1 });
    expect(files.load).toHaveBeenCalledWith("src");

    files.directoryEntries = [...files.directoryEntries, { path: "src/app.ts", kind: "file" }];
    files.loadedDirectories = new Set(["", "src"]);
    const storageWrite = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    try {
      await render({ selectedPath: "src/app.ts", selectedPathRevealId: 1 });
    } finally {
      storageWrite.mockRestore();
    }
    expect(visiblePaths()).toContain("src/app.ts");
    const selected = container!
      .querySelector("file-tree-container")!
      .shadowRoot!.querySelector('[data-item-path="src/app.ts"]');
    expect(selected?.getAttribute("aria-selected")).toBe("true");
    expect(props.onOpenFile).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import type { AssetResource, ProjectEntry } from "@t3tools/contracts";
import { act, type ComponentProps, type PropsWithChildren, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface QueryTarget {
  readonly kind: "session" | "metadata" | "read" | "entries" | "search";
  readonly environmentId?: string;
  readonly input?: {
    readonly cwd?: string;
    readonly relativePath?: string;
    readonly path?: string;
  };
}

const harness = vi.hoisted(() => ({
  canReadFiles: true,
  fileInspectorSupported: false,
  renderInspector: undefined as (() => ReactNode) | undefined,
  metadata: new Map<string, { readonly kind: "directory" | "file" } | null>(),
  metadataPending: new Set<string>(),
  metadataErrors: new Map<string, string>(),
  entries: new Map<string, ReadonlyArray<ProjectEntry>>(),
  files: new Map<string, { readonly contents?: string; readonly error?: string }>(),
  requests: [] as QueryTarget[],
  assetPaths: [] as string[],
  assetResources: [] as AssetResource[],
  navigation: [] as Array<{
    readonly type: "NAVIGATE" | "PUSH" | "REPLACE";
    readonly name: string;
    readonly params: Record<string, unknown>;
  }>,
  goBack: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: PropsWithChildren) => <div>{children}</div>,
  Pressable: (props: PropsWithChildren<{ onPress?: () => void; accessibilityLabel?: string }>) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
  RefreshControl: () => null,
}));
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: <A,>(props: {
    data: ReadonlyArray<A>;
    renderItem: (input: { item: A; index: number }) => ReactNode;
    keyExtractor: (item: A) => string;
    ListHeaderComponent?: ReactNode;
    ListEmptyComponent?: ReactNode;
  }) => (
    <div>
      {props.ListHeaderComponent}
      {props.data.length === 0
        ? props.ListEmptyComponent
        : props.data.map((item, index) => (
            <div key={props.keyExtractor(item)}>{props.renderItem({ item, index })}</div>
          ))}
    </div>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("react-native-svg", () => ({
  default: () => null,
  Defs: () => null,
  LinearGradient: () => null,
  Rect: () => null,
  Stop: () => null,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    canGoBack: () => true,
    goBack: harness.goBack,
    navigate: (name: string, params: Record<string, unknown>) =>
      harness.navigation.push({ type: "NAVIGATE", name, params }),
    dispatch: (action: (typeof harness.navigation)[number]) => harness.navigation.push(action),
  }),
  StackActions: {
    push: (name: string, params: Record<string, unknown>) => ({ type: "PUSH", name, params }),
    replace: (name: string, params: Record<string, unknown>) => ({ type: "REPLACE", name, params }),
  },
}));
vi.mock("@t3tools/client-runtime/state/filesystem", () => ({
  resolveFilesystemReadAccess: () => ({
    canReadFiles: harness.canReadFiles,
    isPending: false,
    error: null,
  }),
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => ({ kind: "session" }) },
}));
vi.mock("../../state/projects", () => {
  const query = (kind: QueryTarget["kind"]) => (target: Omit<QueryTarget, "kind">) => {
    const request = { ...target, kind };
    harness.requests.push(request);
    return request;
  };
  return {
    projectEnvironment: {
      fileMetadata: query("metadata"),
      readFile: query("read"),
      listEntries: query("entries"),
      searchEntries: query("search"),
    },
  };
});
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (target: QueryTarget | null) => {
    let data: unknown = null;
    let error: string | null = null;
    let isPending = false;
    if (target?.kind === "metadata") {
      const path = target.input?.path ?? "";
      isPending = harness.metadataPending.has(path);
      error = harness.metadataErrors.get(path) ?? null;
      if (!isPending && error === null) {
        data = harness.metadata.has(path) ? harness.metadata.get(path) : { kind: "file" };
      }
    } else if (target?.kind === "entries" || target?.kind === "search") {
      data = { entries: harness.entries.get(target.input?.cwd ?? "") ?? [], truncated: false };
    } else if (target?.kind === "read") {
      const path = target.input?.relativePath ?? "";
      const fullPath = path.startsWith("/") ? path : `${target.input?.cwd}/${path}`;
      const file = harness.files.get(fullPath);
      if (file?.contents !== undefined) {
        data = { contents: file.contents, relativePath: path, byteLength: file.contents.length };
      } else {
        error = file?.error ?? `Failed to read workspace file '${path}'.`;
      }
    }
    return { data, error, isPending, isSuccess: !isPending && error === null, refresh: () => {} };
  },
}));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({ isReady: true, presentation: null }),
}));
vi.mock("../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: { id: "thread", environmentId: "environment" },
    selectedThreadProject: { title: "Project", workspaceRoot: "/workspace" },
  }),
}));
vi.mock("../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: "/workspace" }),
}));
vi.mock("../../state/queries", () => ({ useDebouncedValue: (value: string) => value }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/mediaActions", () => ({ useMediaActions: () => ({ actions: [] }) }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../native/native-layout-metrics", () => ({
  useNativeColumnLayoutMetrics: () => null,
}));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: () => {} }));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: () => {} }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspacePaneRole: () => {},
  useRegisterWorkspaceInspector: (renderInspector: (() => ReactNode) | undefined) => {
    harness.renderInspector = renderInspector;
  },
  useAdaptiveWorkspaceLayout: () => ({
    fileInspector: { supported: harness.fileInspectorSupported },
    layout: { usesSplitView: false },
    panes: { auxiliaryPaneVisible: false },
    toggleAuxiliaryPane: () => {},
  }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    appearance: { codeWordBreak: false },
    setCodeWordBreak: () => {},
  }),
}));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: (props: { title: string; subtitle?: string; onBack?: () => void }) => (
    <header>
      <button onClick={props.onBack}>Back</button>
      <h1>{props.title}</h1>
      <span>{props.subtitle}</span>
    </header>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: PropsWithChildren) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: PropsWithChildren) => <main>{children}</main>,
}));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: (props: { title: string; detail?: string }) => (
    <div role="alert">
      {props.title}: {props.detail}
    </div>
  ),
}));
vi.mock("../../components/LoadingScreen", () => ({
  LoadingScreen: (props: { message: string }) => <div>{props.message}</div>,
}));
vi.mock("../../components/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
vi.mock("../threads/ThreadRouteScreen", () => ({ ThreadRouteScreen: () => null }));
vi.mock("../threads/thread-inspector-content-stack", () => ({
  ThreadInspectorContentStack: (props: { renderFiles: () => ReactNode }) => props.renderFiles(),
}));
vi.mock("./thread-file-navigator-pane", () => ({
  ThreadFileNavigatorPane: (props: {
    cwd: string;
    selectedPath: string | null;
    onSelectFile: (path: string) => void;
  }) => (
    <aside aria-label={`Files in ${props.cwd}`}>
      {(harness.entries.get(props.cwd) ?? []).map((entry) => (
        <button
          key={entry.path}
          aria-current={props.selectedPath === entry.path ? "page" : undefined}
          onClick={() => props.onSelectFile(entry.path)}
        >
          {entry.path}
        </button>
      ))}
    </aside>
  ),
}));
vi.mock("./preload-workspace-file", () => ({ preloadWorkspaceFileContents: () => {} }));
vi.mock("./AudioFilePreview", () => ({ AudioFilePreview: () => <div>Audio preview</div> }));
vi.mock("./FileMarkdownPreview", () => ({
  FileMarkdownPreview: (props: { markdown: string }) => <div>{props.markdown}</div>,
}));
vi.mock("./SourceFileSurface", () => ({
  SourceFileSurface: (props: { contents: string }) => <pre>{props.contents}</pre>,
}));
vi.mock("./WorkspaceFileImagePreview", () => ({
  WorkspaceFileImagePreview: () => <div>Image preview</div>,
}));
vi.mock("./WorkspaceFileVideoPreview", () => ({
  WorkspaceFileVideoPreview: () => <div>Video preview</div>,
}));
vi.mock("./WorkspaceFileWebPreview", () => ({
  WorkspaceFileWebPreview: () => <div>Document preview</div>,
}));
vi.mock("./WorkspaceFilePreviewError", () => ({
  WorkspaceFilePreviewError: () => <div>Preview unavailable</div>,
}));
vi.mock("../../state/assets", () => ({
  useAssetUrlState: (_environmentId: string | null, resource: AssetResource | null) => {
    if (resource === null) return { _tag: "Failure", reason: "unavailable" };
    harness.assetResources.push(resource);
    if ("path" in resource && typeof resource.path === "string") {
      harness.assetPaths.push(resource.path);
    }
    return { _tag: "Success", url: "https://example.test/signed-preview" };
  },
  useRefreshAssetUrl: () => async () => null,
}));

import { ThreadFileScreen } from "./ThreadFilesRouteScreen";
import { fileRoutePathSegments } from "./filePath";

let root: Root | null = null;
let container: HTMLDivElement;

function RegisteredInspector() {
  return harness.renderInspector?.();
}

function renderRoute(params: ComponentProps<typeof ThreadFileScreen>["route"]["params"]) {
  root ??= createRoot(container);
  act(() => {
    root!.render(
      <>
        <ThreadFileScreen route={{ params }} />
        <RegisteredInspector />
      </>,
    );
  });
}

function renderFile(path: string, draft = false) {
  renderRoute({
    environmentId: "environment",
    ...(draft ? { cwd: "/workspace", projectName: "Project" } : { threadId: "thread" }),
    path: fileRoutePathSegments(path),
  });
}

function followNavigation() {
  const params = harness.navigation.at(-1)?.params;
  const path = params?.path;
  if (!Array.isArray(path) || !path.every((segment) => typeof segment === "string")) {
    throw new Error("Expected a file navigation destination.");
  }
  renderRoute({
    environmentId: String(params?.environmentId),
    ...(typeof params?.threadId === "string" ? { threadId: params.threadId } : {}),
    ...(typeof params?.cwd === "string" ? { cwd: params.cwd } : {}),
    ...(typeof params?.projectName === "string" ? { projectName: params.projectName } : {}),
    path,
  });
}

function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent === label,
  );
  expect(button, `Expected a visible ${label} button`).toBeDefined();
  act(() => button!.click());
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  harness.canReadFiles = true;
  harness.fileInspectorSupported = false;
  harness.renderInspector = undefined;
  harness.metadata.clear();
  harness.metadataPending.clear();
  harness.metadataErrors.clear();
  harness.entries.clear();
  harness.files.clear();
  harness.requests = [];
  harness.assetPaths = [];
  harness.assetResources = [];
  harness.navigation = [];
  harness.goBack.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

describe("ThreadFileScreen directory links", () => {
  it("browses an external directory, opens its child, and returns without losing its path", () => {
    const folder = "/tmp/hdx-old-composer/shots";
    harness.metadata.set(folder, { kind: "directory" });
    harness.entries.set(folder, [{ kind: "file", path: "report.txt" }]);
    harness.files.set(`${folder}/report.txt`, { contents: "Captured screenshot report" });

    renderFile(folder);
    expect(container.textContent).toContain("report.txt");
    expect(container.textContent).not.toContain("File unavailable");
    expect(harness.requests.some((request) => request.kind === "read")).toBe(false);

    click("report.txt");
    const destination = harness.navigation.at(-1);
    expect(destination?.type).toBe("PUSH");
    expect(destination?.name).toBe("ThreadFile");
    const path = destination?.params.path as string[];
    expect(path.join("/")).toBe(`${folder}/report.txt`);
    renderFile(path.join("/"));
    expect(container.textContent).toContain("Captured screenshot report");

    click("Back");
    expect(harness.goBack).toHaveBeenCalledOnce();
    renderFile(folder);
    expect(container.textContent).toContain("report.txt");
  });

  it("keeps directory children on the draft route", () => {
    const folder = "/tmp/draft-shots";
    harness.metadata.set(folder, { kind: "directory" });
    harness.entries.set(folder, [{ kind: "file", path: "draft.txt" }]);
    harness.files.set(`${folder}/draft.txt`, { contents: "Draft report" });

    renderFile(folder, true);
    click("draft.txt");
    const destination = harness.navigation.at(-1);
    expect(destination?.type).toBe("PUSH");
    expect(destination?.name).toBe("NewTaskFile");
    expect(destination?.params.threadId).toBeUndefined();
    const path = destination?.params.path as string[];
    renderFile(path.join("/"), true);
    expect(container.textContent).toContain("Draft report");
  });

  it("resolves a workspace-relative directory before loading its children", () => {
    harness.metadata.set("/workspace/docs", { kind: "directory" });
    harness.entries.set("/workspace/docs", [{ kind: "file", path: "guide.txt" }]);
    harness.files.set("/workspace/docs/guide.txt", { contents: "Workspace guide" });

    renderFile("docs");
    click("guide.txt");
    const path = harness.navigation.at(-1)?.params.path as string[];
    renderFile(path.join("/"));
    expect(container.textContent).toContain("Workspace guide");
  });

  it.each([false, true])(
    "keeps external siblings in the tablet inspector after opening a child (draft: %s)",
    (draft) => {
      const folder = "/tmp/hdx-old-composer/shots";
      harness.fileInspectorSupported = true;
      harness.metadata.set(folder, { kind: "directory" });
      harness.entries.set(folder, [
        { kind: "file", path: "first.txt" },
        { kind: "file", path: "second.txt" },
      ]);
      harness.files.set(`${folder}/first.txt`, { contents: "First screenshot report" });
      harness.files.set(`${folder}/second.txt`, { contents: "Second screenshot report" });

      renderFile(folder, draft);
      click("first.txt");
      followNavigation();
      expect(container.textContent).toContain("First screenshot report");
      const inspector = container.querySelector(`aside[aria-label="Files in ${folder}"]`);
      expect(inspector).not.toBeNull();
      expect(inspector?.querySelector('[aria-current="page"]')?.textContent).toBe("first.txt");

      click("second.txt");
      const siblingPath = harness.navigation.at(-1)?.params.path as string[];
      expect(siblingPath.join("/")).toBe(`${folder}/second.txt`);
      followNavigation();
      expect(container.textContent).toContain("Second screenshot report");
      const nextInspector = container.querySelector(`aside[aria-label="Files in ${folder}"]`);
      expect(nextInspector).not.toBeNull();
      expect(nextInspector?.querySelector('[aria-current="page"]')?.textContent).toBe("second.txt");
      expect(nextInspector?.textContent).toContain("first.txt");
    },
  );

  it("opens an external image sibling with a host-file resource", () => {
    const folder = "/tmp/hdx-old-composer/shots";
    harness.fileInspectorSupported = true;
    harness.metadata.set(folder, { kind: "directory" });
    harness.entries.set(folder, [
      { kind: "file", path: "report.txt" },
      { kind: "file", path: "screenshot.png" },
    ]);
    harness.files.set(`${folder}/report.txt`, { contents: "Screenshot report" });

    renderFile(folder);
    click("report.txt");
    followNavigation();
    click("screenshot.png");
    const path = harness.navigation.at(-1)?.params.path as string[];
    expect(path.join("/")).toBe(`${folder}/screenshot.png`);
    followNavigation();

    expect(container.textContent).toContain("Image preview");
    expect(harness.assetResources.at(-1)).toEqual({
      _tag: "media-file",
      threadId: "thread",
      path: `${folder}/screenshot.png`,
    });
  });

  it.each(["images.png", "page.html", "document.pdf", "movie.mp4", "sound.mp3"])(
    "browses a directory named %s instead of trying a media preview",
    (name) => {
      const folder = `/tmp/${name}`;
      harness.metadata.set(folder, { kind: "directory" });
      harness.entries.set(folder, [{ kind: "file", path: "inside.txt" }]);

      renderFile(folder);
      expect(container.textContent).toContain("inside.txt");
      expect(container.textContent).not.toContain("Preview unavailable");
      expect(harness.assetPaths).toEqual([]);
    },
  );

  it.each(["shots", "images.png"])(
    "waits for metadata for %s before showing a directory instead of a failed preview",
    async (name) => {
      const folder = `/tmp/${name}`;
      harness.metadataPending.add(folder);
      harness.entries.set(folder, [{ kind: "file", path: "inside.txt" }]);

      renderFile(folder);
      expect(container.textContent).toContain("Loading file...");
      expect(container.textContent).not.toContain("unavailable");
      expect(harness.assetPaths).toEqual([]);
      expect(harness.requests.some((request) => request.kind === "entries")).toBe(false);

      await Promise.resolve();
      harness.metadataPending.delete(folder);
      harness.metadata.set(folder, { kind: "directory" });
      renderFile(folder);
      expect(container.textContent).toContain("inside.txt");
      expect(container.textContent).not.toContain("unavailable");
      expect(harness.assetPaths).toEqual([]);
    },
  );

  it.each(["missing", "denied"])(
    "keeps an ordinary file readable when its metadata is %s",
    (metadataState) => {
      if (metadataState === "missing") {
        harness.metadata.set("/workspace/report.txt", null);
      } else {
        harness.metadataErrors.set("/workspace/report.txt", "Metadata access denied.");
      }
      harness.files.set("/workspace/report.txt", { contents: "Readable file contents" });

      renderFile("report.txt");
      expect(container.textContent).toContain("Readable file contents");
      expect(container.textContent).not.toContain("unavailable");
    },
  );

  it("keeps available file contents visible while fresh metadata is pending", () => {
    harness.metadataPending.add("/workspace/report.txt");
    harness.files.set("/workspace/report.txt", { contents: "Previously loaded report" });

    renderFile("report.txt");
    expect(container.textContent).toContain("Previously loaded report");
    expect(container.textContent).not.toContain("Loading file...");
  });

  it("retains the error for an unavailable ordinary file", () => {
    harness.files.set("/workspace/missing.txt", { error: "The file no longer exists." });
    renderFile("missing.txt");
    expect(container.textContent).toContain("File unavailable");
    expect(container.textContent).toContain("The file no longer exists.");
  });

  it("does not read metadata, contents, or directories without filesystem permission", () => {
    harness.canReadFiles = false;
    renderFile("/tmp/shots");
    expect(container.textContent).toContain("Files unavailable");
    expect(harness.requests).toEqual([]);
    expect(harness.assetPaths).toEqual([]);
  });
});

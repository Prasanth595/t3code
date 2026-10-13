// @vitest-environment jsdom
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { getSharedHighlighter } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/edit";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  appearance: "dark" as "light" | "dark",
  contents: "const answer = 42;\n",
  change: vi.fn(),
  addReviewComment: vi.fn(),
  removeReviewComment: vi.fn(),
}));

vi.mock("~/hooks/useTheme", () => ({ useRenderedAppearance: () => state.appearance }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => false,
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false }),
}));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => "test-env",
  useEnvironmentHttpBaseUrl: () => null,
}));
vi.mock("~/remoteOpen", () => ({ useRemoteOpenState: () => ({ mode: "local-exec" }) }));
vi.mock("~/browser/previewRuntime", () => ({ usePreviewAvailable: () => false }));
vi.mock("~/state/assets", () => ({ assetEnvironment: { createUrl: {} } }));
vi.mock("~/state/preview", () => ({ previewEnvironment: { open: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlRefresh: () => vi.fn(),
  useAssetUrlState: () => ({ _tag: "Initial" }),
}));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: () => {} }));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: typeof state) => unknown) => select(state),
}));
vi.mock("./projectFilesQueryState", () => ({
  useProjectFileQuery: () => ({ data: { contents: state.contents, truncated: false } }),
  getProjectFileContents: () => state.contents,
  setProjectFileQueryData: (_environmentId: string, _cwd: string, _path: string, text: string) => {
    state.contents = text;
  },
}));
vi.mock("./useFileSaveCoordinator", () => ({
  useFileSaveCoordinator: () => ({ change: state.change }),
}));
vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@pierre/diffs/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pierre/diffs/react")>()),
  // JSDOM has no layout. Keep the real File, EditProvider and Editor, and only
  // replace the viewport measurement wrapper with its scroll container.
  Virtualizer: ({ children, className }: { children: ReactNode; className: string }) => (
    <div className={className}>{children}</div>
  ),
}));
vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/components/chat/OpenInPicker", () => ({ OpenInPicker: () => null }));
vi.mock("~/components/media/MediaVideoPlayer", () => ({ MediaVideoPlayer: () => null }));
vi.mock("~/components/media/MediaActions", () => ({ MediaActions: () => null }));
vi.mock("~/components/MorphIcon", () => ({ MorphIcon: () => null }));
vi.mock("./AttachmentFilePreview", () => ({ AttachmentFilePreview: () => null }));
vi.mock("./AudioPreview", () => ({ AudioPreview: () => null }));
vi.mock("./DelimitedTablePreview", () => ({ DelimitedTablePreview: () => null }));
vi.mock("./FileBrowserPanel", () => ({ default: () => null }));
vi.mock("./FileBreadcrumbs", () => ({ FileBreadcrumbs: () => null }));
vi.mock("./FileMarkdownPreview", () => ({ FileMarkdownPreview: () => null }));
vi.mock("./ReadOnlySourcePreview", () => ({ default: () => null }));
vi.mock("../diffs/DiffCommentAnnotation", () => ({ DiffCommentAnnotation: () => null }));

import FilePreviewPanel from "./FilePreviewPanel";
import type { FileCommentAnnotationGroup } from "./fileCommentAnnotations";

const frames = new Map<number, FrameRequestCallback>();
const messages: unknown[] = [];
let nextFrameId = 0;
let root: Root;
let container: HTMLDivElement;

function drainFrames() {
  for (let frame = 0; frames.size > 0 || messages.length > 0; frame += 1) {
    if (frame === 20) throw new Error("The editor render queue did not settle");
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(frame);
    for (const data of messages.splice(0)) {
      window.dispatchEvent(new MessageEvent("message", { data }));
    }
  }
}

function syntaxColours(file: Element) {
  return [...file.shadowRoot!.querySelectorAll<HTMLElement>("[data-line] span")].map((token) => ({
    text: token.textContent,
    colour: token.style.color,
  }));
}

function attachedEditor(context: unknown) {
  return context as Editor<"file", FileCommentAnnotationGroup, undefined>;
}

function panel(relativePath = "answer.ts") {
  const environmentId = EnvironmentId.make("test-env");
  const threadRef = { environmentId, threadId: ThreadId.make("test-thread") };
  return (
    <FilePreviewPanel
      environmentId={environmentId}
      cwd="/workspace"
      projectName="Workspace"
      relativePath={relativePath}
      threadRef={threadRef}
      composerDraftTarget={threadRef}
      keybindings={[]}
      availableEditors={[]}
      revealLine={null}
      revealRequestId={0}
      onOpenFile={vi.fn()}
      onPendingChange={vi.fn()}
      selectedFilePending={false}
      workspaceMutationId={null}
    />
  );
}

beforeAll(async () => {
  await getSharedHighlighter({
    themes: ["pierre-dark", "pierre-light"],
    langs: ["typescript"],
    preferredHighlighter: "shiki-wasm",
  });
});

beforeEach(() => {
  state.appearance = "dark";
  state.contents = "const answer = 42;\n";
  state.change.mockClear();
  frames.clear();
  messages.length = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrameId;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("postMessage", (data: unknown) => messages.push(data));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({
    font: "",
    measureText: (text: string) => ({ width: text.length * 8 }),
  })) as unknown as HTMLCanvasElement["getContext"]);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    drainFrames();
  });
  container.remove();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("file editor appearance", () => {
  it("updates preview syntax colours in place and keeps selection, scroll and undo on cancel", async () => {
    const edit = vi.spyOn(Editor.prototype, "edit");
    await act(async () => root.render(panel()));
    await act(async () => drainFrames());
    expect(edit).toHaveBeenCalledTimes(1);
    const editor = attachedEditor(edit.mock.contexts[0]);
    const file = container.querySelector("diffs-container")!;
    const scroll = container.querySelector<HTMLElement>(".file-preview-virtualizer")!;
    const darkTheme = file.shadowRoot!.querySelector("[data-theme-css]")!.textContent;

    await act(async () => {
      editor.applyEdits([
        {
          range: { start: { line: 0, character: 15 }, end: { line: 0, character: 17 } },
          newText: "43",
        },
      ]);
      editor.setSelections([
        {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 12 },
          direction: "forward",
        },
      ]);
      drainFrames();
    });
    scroll.scrollTop = 120;
    const darkSyntax = syntaxColours(file);
    const selection = editor.getViewState().selections;
    expect(selection).toHaveLength(1);
    expect(editor.canUndo).toBe(true);

    for (const appearance of ["light", "dark"] as const) {
      state.appearance = appearance;
      await act(async () => root.render(panel()));
      await act(async () => drainFrames());
      expect(edit).toHaveBeenCalledTimes(1);
      expect(container.querySelector("diffs-container")).toBe(file);
      expect(container.querySelector(".file-preview-virtualizer")).toBe(scroll);
      expect(scroll.scrollTop).toBe(120);
      expect(editor.getViewState().selections).toEqual(selection);
      expect(editor.getText()).toBe("const answer = 43;\n");
      expect(editor.canUndo).toBe(true);
      const syntax = syntaxColours(file);
      const theme = file.shadowRoot!.querySelector("[data-theme-css]")!.textContent;
      if (appearance === "light") {
        expect(syntax).not.toEqual(darkSyntax);
        expect(theme).not.toBe(darkTheme);
      } else {
        expect(syntax).toEqual(darkSyntax);
        expect(theme).toBe(darkTheme);
      }
    }

    await act(async () => {
      editor.undo();
      drainFrames();
    });
    expect(editor.getText()).toBe("const answer = 42;\n");
    expect(editor.canRedo).toBe(true);
  });

  it("creates a fresh editor when switching files", async () => {
    const edit = vi.spyOn(Editor.prototype, "edit");
    await act(async () => root.render(panel()));
    await act(async () => drainFrames());
    const file = container.querySelector("diffs-container");
    await act(async () => root.render(panel("other.ts")));
    await act(async () => drainFrames());
    expect(edit).toHaveBeenCalledTimes(2);
    expect(edit.mock.contexts[1]).not.toBe(edit.mock.contexts[0]);
    expect(container.querySelector("diffs-container")).not.toBe(file);
    expect(attachedEditor(edit.mock.contexts[1]).canUndo).toBe(false);
  });
});

import {
  EnvironmentId,
  ThreadId,
  type ProjectReadFileResult,
  type ScopedThreadRef,
  type ServerConfig,
} from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProjectReadFileError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  formatFileCommentRange,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from "./fileCommentAnnotations";
import {
  filePreviewReadErrorMessage,
  isMarkdownPreviewFile,
  resolveFilePreviewPath,
  setMarkdownTaskChecked,
  shouldShowFileExplorer,
  workspaceAssetResource,
} from "./filePreviewMode";

const decodeReadError = Schema.decodeSync(ProjectReadFileError);

describe("file preview read errors", () => {
  it.each([
    ["path_not_file", "The path is a directory or special file, not a regular file."],
    ["binary_file", "The file is binary and cannot be displayed as text."],
    ["workspace_path_outside_root", "The requested path is outside the workspace."],
    ["resolved_path_outside_root", "The path resolves to a location outside the workspace."],
    [
      "operation_failed",
      "The file could not be accessed or read. It may be missing or inaccessible.",
    ],
  ] as const)("describes %s without revealing the platform cause", (failure, message) => {
    const error = new ProjectReadFileError({
      cwd: "/workspace",
      relativePath: "workspace/outline.md",
      failure,
      operation: "realpath-target",
      resolvedPath: "/workspace/workspace/outline.md",
      cause: new Error("EACCES: sensitive platform detail"),
    });
    expect(filePreviewReadErrorMessage(error)).toBe(message);
  });

  it("distinguishes an inaccessible workspace from an inaccessible file", () => {
    const error = new ProjectReadFileError({
      cwd: "/workspace",
      relativePath: "outline.md",
      failure: "operation_failed",
      operation: "realpath-workspace-root",
      operationPath: "/workspace",
    });
    expect(filePreviewReadErrorMessage(error)).toBe("The workspace folder could not be accessed.");
  });

  it("preserves the public message from older servers", () => {
    const error = decodeReadError({
      _tag: "ProjectReadFileError",
      message: "Legacy file read failure.",
    });
    expect(filePreviewReadErrorMessage(error)).toBe("Legacy file read failure.");
  });
});

describe("file comment annotations", () => {
  it("normalizes and formats selected line ranges", () => {
    expect(normalizeFileCommentRange({ start: 16, end: 7 })).toEqual({
      startLine: 7,
      endLine: 16,
    });
    expect(formatFileCommentRange(7, 7)).toBe("L7");
    expect(formatFileCommentRange(7, 16)).toBe("L7 to L16");
  });

  it("keeps an annotation range attached when Pierre remaps its anchor line", () => {
    expect(
      remapFileCommentAnnotations([
        {
          lineNumber: 20,
          metadata: {
            entries: [
              {
                id: "comment-1",
                kind: "comment",
                startLine: 7,
                endLine: 16,
                text: "Keep this guarded.",
              },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        lineNumber: 20,
        metadata: {
          entries: [
            {
              id: "comment-1",
              kind: "comment",
              startLine: 11,
              endLine: 20,
              text: "Keep this guarded.",
            },
          ],
        },
      },
    ]);
  });
});

describe("isMarkdownPreviewFile", () => {
  it("recognizes markdown and MDX files case-insensitively", () => {
    expect(isMarkdownPreviewFile("README.md")).toBe(true);
    expect(isMarkdownPreviewFile("docs/guide.MDX")).toBe(true);
  });

  it("does not treat other text files as markdown", () => {
    expect(isMarkdownPreviewFile("docs/guide.txt")).toBe(false);
    expect(isMarkdownPreviewFile("docs/markdown.ts")).toBe(false);
  });
});

describe("shouldShowFileExplorer", () => {
  it("hides the workspace tree for host files and attachments", () => {
    expect(
      shouldShowFileExplorer({
        relativePath: "/tmp/report.pdf",
        explorerOpen: true,
        attachmentOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldShowFileExplorer({
        relativePath: "~/.claude/CLAUDE.md",
        explorerOpen: true,
        attachmentOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldShowFileExplorer({
        relativePath: "report.pdf",
        explorerOpen: true,
        attachmentOpen: true,
      }),
    ).toBe(false);
  });

  it("keeps the saved explorer preference for workspace files", () => {
    expect(
      shouldShowFileExplorer({
        relativePath: "docs/report.pdf",
        explorerOpen: true,
        attachmentOpen: false,
      }),
    ).toBe(true);
    expect(
      shouldShowFileExplorer({
        relativePath: "docs/report.pdf",
        explorerOpen: false,
        attachmentOpen: false,
      }),
    ).toBe(false);
  });
});

describe("setMarkdownTaskChecked", () => {
  const markdown = "- [ ] First\n- [x] Second\n";

  it("checks and unchecks the task marker at the supplied offset", () => {
    expect(setMarkdownTaskChecked(markdown, 2, true)).toBe("- [x] First\n- [x] Second\n");
    expect(setMarkdownTaskChecked(markdown, 14, false)).toBe("- [ ] First\n- [ ] Second\n");
    expect(setMarkdownTaskChecked("1. [X] Ordered\n", 3, false)).toBe("1. [ ] Ordered\n");
  });

  it("leaves the document unchanged for a stale or invalid marker offset", () => {
    expect(setMarkdownTaskChecked(markdown, 0, true)).toBe(markdown);
    expect(setMarkdownTaskChecked(markdown, 200, true)).toBe(markdown);
  });
});

describe("resolveFilePreviewPath", () => {
  it.each([
    ["/repo/project", null],
    ["/repo/project/", null],
    [".", null],
    [null, null],
    ["/repo/project/src", "/repo/project/src"],
    ["/repo/project/src/main.ts", "/repo/project/src/main.ts"],
    ["src/main.ts", "src/main.ts"],
    ["/repo/project-other", "/repo/project-other"],
  ])("opens %s in the appropriate workspace surface", (path, expected) => {
    const relativePath = resolveFilePreviewPath(path, "/repo/project");
    expect(relativePath).toBe(expected);
    if (expected === null) {
      expect(
        shouldShowFileExplorer({ relativePath, explorerOpen: false, attachmentOpen: false }),
      ).toBe(true);
    }
  });
});

describe("workspaceAssetResource", () => {
  const input = {
    kind: "workspace-file" as const,
    threadRef: {
      environmentId: "env" as ScopedThreadRef["environmentId"],
      threadId: "thread-1" as ScopedThreadRef["threadId"],
    },
    workspaceRoot: "/repo",
    absolutePath: "/repo/docs/index.html",
  };

  it("names the thread once the server knows it", () => {
    expect(workspaceAssetResource({ ...input, draft: false })).toEqual({
      _tag: "workspace-file",
      threadId: "thread-1",
      path: "/repo/docs/index.html",
    });
  });

  it("names the workspace root for a draft, which the server cannot resolve from a thread", () => {
    expect(workspaceAssetResource({ ...input, draft: true })).toEqual({
      _tag: "draft-workspace-file",
      cwd: "/repo",
      path: "/repo/docs/index.html",
    });
  });
});

// Keep the read-result decoding, preview selection, fallback, and file menu real.
// Only the environment inputs and host/clipboard boundaries are substituted.
vi.mock(import("~/state/projects"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    projectEnvironment: {
      ...actual.projectEnvironment,
      readFile: () => readResult,
    },
  };
});
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: () => serverConfig },
  };
});
vi.mock(import("~/state/shell"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    shellEnvironment: {
      ...actual.shellEnvironment,
      openInEditor: {
        ...actual.shellEnvironment.openInEditor,
        permissionAtom: (id: EnvironmentId | null) =>
          id === environmentId ? hostPermission : Atom.make(true),
      },
    },
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => openInEditor) as never,
}));
vi.mock(import("~/state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => false,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => EnvironmentId.make("primary"),
  useEnvironmentHttpBaseUrl: () => null,
}));
vi.mock(import("~/remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenState: () => ({ mode: remoteMode }),
}));
vi.mock(import("~/browser/previewRuntime"), async (original) => ({
  ...(await original()),
  usePreviewAvailable: () => false,
}));
vi.mock(import("~/hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: (() => ({ resolvedTheme: "dark" })) as never,
}));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: vi.fn() }));
// Highlighting workers are unrelated to the choice between a read error and cached text.
vi.mock(import("./ReadOnlySourcePreview"), async (original) => ({
  ...(await original()),
  default: ({ text }: { text: string }) => <pre>{text}</pre>,
}));

import FilePreviewPanel from "./FilePreviewPanel";

const environmentId = EnvironmentId.make("destination");
const readResult = Atom.make<AsyncResult.AsyncResult<ProjectReadFileResult, ProjectReadFileError>>(
  AsyncResult.initial(),
);
const serverConfig = Atom.make<ServerConfig | null>(null);
const hostPermission = Atom.make(true);
let remoteMode: "local-exec" | "remote-unavailable" = "local-exec";
const openInEditor = vi.fn();
const config = {
  availableEditors: ["file-manager"],
  shellRevealInFileManager: true,
  shellRevealInFileManagerKind: "finder",
  environment: { platform: { os: "darwin" } },
} as unknown as ServerConfig;

describe("file preview binary fallback", () => {
  let registry: AtomRegistry.AtomRegistry;
  let root: Root;
  let container: HTMLDivElement;
  const path = "/workspace/slides.PPTX";

  beforeEach(() => {
    remoteMode = "local-exec";
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    registry = AtomRegistry.make();
    registry.mount(readResult);
    registry.mount(serverConfig);
    registry.mount(hostPermission);
    registry.set(serverConfig, config);
    registry.set(hostPermission, true);
    openInEditor.mockReset().mockResolvedValue(AsyncResult.success(undefined));
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    registry.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function fail(failure: ProjectReadFileError["failure"] = "binary_file") {
    registry.set(
      readResult,
      AsyncResult.failure(
        Cause.fail(new ProjectReadFileError({ cwd: "/workspace", relativePath: path, failure })),
      ),
    );
  }

  async function render(selectedPath = path) {
    const threadRef = { environmentId, threadId: ThreadId.make("thread") };
    await act(async () => {
      root.render(
        <RegistryContext.Provider value={registry}>
          <FilePreviewPanel
            environmentId={environmentId}
            cwd="/workspace"
            projectName="Workspace"
            relativePath={selectedPath}
            threadRef={threadRef}
            composerDraftTarget={threadRef}
            keybindings={[]}
            availableEditors={[]}
            openInShortcutEnabled={false}
            revealLine={null}
            revealRequestId={0}
            onOpenFile={vi.fn()}
            onNavigateFolder={vi.fn()}
            folderTrail={undefined}
            onPendingChange={vi.fn()}
            selectedFilePending={false}
            workspaceMutationId={null}
          />
        </RegistryContext.Provider>,
      );
    });
  }

  function button(label: string) {
    return [...container.querySelectorAll("button")].find((node) => node.textContent === label);
  }

  async function click(label: string) {
    const node = button(label);
    expect(node, label).toBeDefined();
    await act(async () => node!.click());
  }

  it("shows a file card only for a binary read failure with no cached contents", async () => {
    fail();
    await render();
    expect(container.querySelector("h2")?.textContent).toBe("slides.PPTX");
    expect(container.querySelector("dd")?.textContent).toBe("PowerPoint presentation");
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await act(async () => fail("operation_failed"));
    expect(container.querySelector("h2")).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "The file could not be accessed or read.",
    );

    await act(async () => {
      registry.set(
        readResult,
        AsyncResult.failure(
          Cause.fail(
            new ProjectReadFileError({
              cwd: "/workspace",
              relativePath: path,
              failure: "binary_file",
            }),
          ),
          {
            previousSuccess: Option.some(
              AsyncResult.success({
                relativePath: path,
                contents: "Cached file contents",
                byteLength: 20,
                truncated: false,
              }),
            ),
          },
        ),
      );
    });
    expect(container.querySelector("h2")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe("Cached file contents");
  });

  it.each([
    ["/workspace/slides.PPTX", "slides.PPTX"],
    ["/report.odt", "report.odt"],
    ["C:\\work\\report.docx", "report.docx"],
    ["\\\\server\\share\\report.pptx", "report.pptx"],
    ["/tmp/report\\final.pptx", "report\\final.pptx"],
  ])(
    "copies, opens, and reveals the exact selected file %s in its environment",
    async (selected, name) => {
      fail();
      await render(selected);
      await click("Copy path");
      expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(selected);
      expect(button("Copied path")).toBeDefined();

      await click("Open in default app");
      expect(openInEditor).toHaveBeenLastCalledWith({
        environmentId,
        input: { cwd: selected, editor: "file-manager" },
      });
      await click("Reveal in Finder");
      expect(openInEditor).toHaveBeenLastCalledWith({
        environmentId,
        input: { cwd: selected, editor: "file-manager", reveal: true },
      });
      expect(container.querySelector("h2")?.textContent).toBe(name);
    },
  );

  it.each([
    ["archive.zip", "Archive"],
    ["slides.pptx.exe", "EXE file"],
    ["unknown.bin", "BIN file"],
  ])("describes %s without offering default-app open", async (name, kind) => {
    fail();
    await render("/workspace/" + name);
    expect(container.querySelector("h2")?.textContent).toBe(name);
    expect(container.querySelector("dd")?.textContent).toBe(kind);
    expect(button("Open in default app")).toBeUndefined();
    expect(button("Reveal in Finder")).toBeDefined();
    expect(button("Copy path")).toBeDefined();
  });

  it("keeps copy available when the destination has no host file actions", async () => {
    registry.set(serverConfig, {
      ...config,
      availableEditors: [],
      shellRevealInFileManager: false,
    });
    fail();
    await render();
    expect(button("Open in default app")).toBeUndefined();
    expect(button("Reveal in Finder")).toBeUndefined();
    await click("Copy path");
    expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(path);
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("removes host actions when the destination grant becomes read-only, keeping copy", async () => {
    fail();
    await render();
    expect(button("Open in default app")).toBeDefined();
    expect(button("Reveal in Finder")).toBeDefined();
    await act(async () => registry.set(hostPermission, false));
    await render();
    await click("Copy path");
    expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(path);
    expect(button("Open in default app")).toBeUndefined();
    expect(button("Reveal in Finder")).toBeUndefined();
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("keeps copy available without host actions on a remote connection", async () => {
    remoteMode = "remote-unavailable";
    fail();
    await render();
    expect(button("Open in default app")).toBeUndefined();
    expect(button("Reveal in Finder")).toBeUndefined();
    await click("Copy path");
    expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(path);
    expect(openInEditor).not.toHaveBeenCalled();
  });
});

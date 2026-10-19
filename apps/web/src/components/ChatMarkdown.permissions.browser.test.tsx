import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  ProjectReadFileError,
  ThreadId,
  type AuthEnvironmentScope,
  type EditorId,
  type ThreadLinkedPullRequest,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useRightPanelStore } from "../rightPanelStore";

const state = vi.hoisted(() => ({
  allowed: true,
  listeners: new Set<() => void>(),
  openEditor: vi.fn(),
  updateMetadata: vi.fn(),
  search: vi.fn(),
  readFile: vi.fn(),
  openBrowser: vi.fn(),
  choose: vi.fn(),
  openFile: vi.fn(),
  openExternal: vi.fn(),
  copy: vi.fn(),
  linkedPullRequest: null as ThreadLinkedPullRequest | null,
}));

vi.mock(import("../state/use-atom-query-runner"), async (original) => {
  const { projectEnvironment } = await import("../state/projects");
  return {
    ...(await original()),
    useAtomQueryRunner: ((query: unknown) =>
      query === projectEnvironment.readFile ? state.readFile : state.search) as never,
  };
});
vi.mock(import("../browser/previewRuntime"), async (original) => ({
  ...(await original()),
  isPreviewAvailableFor: () => true,
}));
vi.mock(import("../browser/openFileInPreview"), async (original) => ({
  ...(await original()),
  openFileInPreview: state.openBrowser,
}));
vi.mock(import("../state/use-atom-command"), async (original) => {
  const { threadEnvironment } = await import("../state/threads");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === threadEnvironment.updateMetadata
        ? state.updateMetadata
        : state.openEditor) as never,
  };
});
vi.mock(import("../state/session"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const readEnvironmentScope = (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    id !== null &&
    (scope !== AuthOrchestrationOperateScope || id !== threadRef.environmentId || state.allowed);
  return {
    ...(await original()),
    readEnvironmentScope,
    readPreparedConnection: (() => ({ httpBaseUrl: "https://host.test" })) as never,
    useEnvironmentScope: (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => readEnvironmentScope(id, scope),
      ),
  };
});
// Atoms derived from the server config run in the real registry over this config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make(() => serverConfig);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => config) as never },
    environmentServerConfigsAtom: Atom.make(
      () => new Map([[threadRef.environmentId, serverConfig]]),
    ) as never,
  };
});
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readThreadShell: (() => ({ linkedPullRequest: state.linkedPullRequest })) as never,
  useProjects: (() => [
    { id: linkedPullRequest.projectId, environmentId: threadRef.environmentId },
  ]) as never,
}));
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
vi.mock(import("../hooks/useLocalStorage"), async (original) => ({
  ...(await original()),
  useLocalStorage: (() => ["vscode", vi.fn()]) as never,
  getLocalStorageItem: (() => "vscode") as never,
}));
vi.mock(import("../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: () =>
    ({
      contextMenu: { show: state.choose },
      shell: { openExternal: state.openExternal },
    }) as never,
}));
vi.mock(import("~/lib/openPullRequestLink"), async (original) => ({
  ...(await original()),
  resolvePullRequestPreviewTarget: () => null,
  findProjectForChangeRequest: ((projects: readonly { id: ProjectId }[]) => projects[0]) as never,
  matchesLinkedPullRequestUrl: (candidate: ThreadLinkedPullRequest, href: string) =>
    candidate.url === href,
  parseChangeRequestUrl: ((href: string) =>
    href === linkedPullRequest.url
      ? {
          host: "github.com",
          repository: linkedPullRequest.repository,
          number: linkedPullRequest.number,
        }
      : null) as never,
}));

import ChatMarkdown from "./ChatMarkdown";

const threadRef = {
  environmentId: EnvironmentId.make("selected"),
  threadId: ThreadId.make("thread"),
};
const linkedPullRequest: ThreadLinkedPullRequest = {
  projectId: ProjectId.make("project"),
  repository: "example/repo",
  number: 42,
  url: "https://github.com/example/repo/pull/42",
};
const serverConfig = {
  availableEditors: ["vscode", "file-manager"] as readonly EditorId[],
  shellRevealInFileManager: true,
  shellRevealInFileManagerKind: "xdg-open",
  environment: { platform: { os: "linux" }, capabilities: { threadPullRequestLinking: true } },
};
const roots: Root[] = [];
let container: HTMLDivElement;

beforeEach(() => {
  state.allowed = true;
  state.listeners.clear();
  state.linkedPullRequest = null;
  state.openEditor.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.updateMetadata.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.search.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  state.readFile.mockReset().mockResolvedValue(
    AsyncResult.failure(
      Cause.fail(
        new ProjectReadFileError({
          cwd: "/work",
          relativePath: "docs/GROUPS_PLAN.html",
          failure: "operation_failed",
          operation: "open",
          cause: "ENOENT",
        }),
      ),
    ),
  );
  state.openBrowser.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.choose.mockReset().mockResolvedValue(null);
  state.openFile.mockReset();
  state.openExternal.mockReset().mockResolvedValue(undefined);
  state.copy.mockReset().mockResolvedValue(undefined);
  useRightPanelStore.setState({ openFile: state.openFile });
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(state.copy);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderMarkdown(text: string, ref = threadRef) {
  container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<ChatMarkdown cwd="/work" threadRef={ref} text={text} />));
}

function anchor() {
  return container.querySelector("a")!;
}

async function openContextMenu() {
  await act(async () => {
    anchor().dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
    );
  });
}

function offeredActions() {
  return state.choose.mock.lastCall![0].map((item: { id: string }) => item.id);
}

async function setAllowed(allowed: boolean) {
  await act(async () => {
    state.allowed = allowed;
    for (const listener of state.listeners) listener();
  });
}

it("removes host actions after revocation while keeping file preview and copying", async () => {
  await renderMarkdown("[Readme](docs/readme.md)");
  await openContextMenu();
  expect(offeredActions()).toEqual(["open", "reveal", "copy-relative", "copy-full"]);
  await setAllowed(false);
  state.choose.mockResolvedValue("copy-full");
  await openContextMenu();
  expect(offeredActions()).toEqual(["copy-relative", "copy-full"]);
  await vi.waitFor(() => expect(state.copy).toHaveBeenCalledWith("/work/docs/readme.md"));
  await act(async () => anchor().click());
  expect(state.openFile).toHaveBeenCalledWith(threadRef, "docs/readme.md", undefined);
  expect(state.openEditor).not.toHaveBeenCalled();
});

it("does not launch an editor after revocation during a native context menu", async () => {
  let choose: (action: string) => void = () => {
    throw new Error("Menu not opened");
  };
  state.choose.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        choose = resolve;
      }),
  );
  await renderMarkdown("[Readme](docs/readme.md)");
  await openContextMenu();
  expect(offeredActions()).toContain("open");
  await act(async () => {
    state.allowed = false;
    choose("open");
  });
  expect(state.openEditor).not.toHaveBeenCalled();
});

it("does not reveal a file after revocation during its workspace lookup", async () => {
  let finishLookup: () => void = () => {
    throw new Error("Lookup not started");
  };
  state.search.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishLookup = () => resolve(AsyncResult.success({ entries: [] }));
      }),
  );
  state.choose.mockResolvedValue("reveal");
  await renderMarkdown("[Readme](readme.md)");
  await openContextMenu();
  expect(state.search).toHaveBeenCalledOnce();
  await act(async () => {
    state.allowed = false;
    finishLookup();
  });
  expect(state.openEditor).not.toHaveBeenCalled();
});

it.each([false, true])(
  "keeps PR links usable without offering metadata edits (linked=%s)",
  async (linked) => {
    state.allowed = false;
    state.linkedPullRequest = linked ? linkedPullRequest : null;
    state.choose.mockResolvedValue("open-external");
    await renderMarkdown(`[Review](${linkedPullRequest.url})`);
    await openContextMenu();
    expect(offeredActions()).toEqual(["open-external", "copy-link"]);
    await vi.waitFor(() => expect(state.openExternal).toHaveBeenCalledWith(linkedPullRequest.url));
    expect(state.updateMetadata).not.toHaveBeenCalled();
  },
);

it.each(["link-to-thread", "unlink-from-thread"])(
  "rechecks %s after a native context menu returns",
  async (action) => {
    state.linkedPullRequest = action === "unlink-from-thread" ? linkedPullRequest : null;
    let choose: (action: string) => void = () => {
      throw new Error("Menu not opened");
    };
    state.choose.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          choose = resolve;
        }),
    );
    await renderMarkdown(`[Review](${linkedPullRequest.url})`);
    await openContextMenu();
    expect(offeredActions()).toContain(action);
    await act(async () => {
      state.allowed = false;
      choose(action);
    });
    expect(state.updateMetadata).not.toHaveBeenCalled();

    await setAllowed(true);
    state.choose.mockResolvedValue(action);
    await openContextMenu();
    await vi.waitFor(() =>
      expect(state.updateMetadata).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          linkedPullRequest: action === "link-to-thread" ? linkedPullRequest : null,
        },
      }),
    );
  },
);

const indexedPath = "BudgetLens/docs/GROUPS_PLAN.html";
const fileChip = "`docs/GROUPS_PLAN.html:12:3`";

function searchResult(paths: string[]) {
  return AsyncResult.success({ entries: paths.map((path) => ({ path, kind: "file" as const })) });
}

function deferSearch() {
  let finish: (result: ReturnType<typeof searchResult>) => void = () => {
    throw new Error("Lookup not started");
  };
  state.search.mockReturnValueOnce(
    new Promise<ReturnType<typeof searchResult>>((resolve) => {
      finish = resolve;
    }),
  );
  return (paths: string[]) => act(async () => finish(searchResult(paths)));
}

async function activateFile(action: string) {
  if (action === "panel") {
    await act(async () => anchor().click());
  } else {
    state.choose.mockResolvedValue(action);
    await openContextMenu();
    expect(offeredActions()).toContain(action);
  }
}

it.each(["panel", "open", "open-in-browser", "reveal"])(
  "resolves the unique segment suffix for the %s file action",
  async (action) => {
    state.search.mockResolvedValue(
      searchResult(["other/GROUPS_PLAN.html", "BudgetLens/mydocs/GROUPS_PLAN.html", indexedPath]),
    );
    await renderMarkdown(fileChip);
    await activateFile(action);
    if (action === "panel") {
      expect(state.openFile).toHaveBeenCalledExactlyOnceWith(threadRef, indexedPath, 12);
    } else if (action === "open-in-browser") {
      expect(state.openBrowser).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          threadRef,
          filePath: `/work/${indexedPath}`,
          workspaceRoot: "/work",
        }),
      );
    } else {
      expect(state.openEditor).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadRef.environmentId,
        input:
          action === "reveal"
            ? { cwd: `/work/${indexedPath}`, editor: "file-manager", reveal: true }
            : { cwd: `/work/${indexedPath}:12:3`, editor: "vscode" },
      });
    }
  },
);

it("keeps a real literal file when the workspace index only returns a nested twin", async () => {
  state.search.mockResolvedValue(searchResult([indexedPath]));
  state.readFile.mockResolvedValue(
    AsyncResult.success({
      relativePath: "docs/GROUPS_PLAN.html",
      contents: "ignored local file",
      byteLength: 18,
      truncated: false,
    }),
  );
  await renderMarkdown(fileChip);
  await activateFile("panel");
  expect(state.openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "docs/GROUPS_PLAN.html", 12);
  expect(state.readFile).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: { cwd: "/work", relativePath: "docs/GROUPS_PLAN.html" },
  });
  await activateFile("open");
  expect(state.openEditor).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: { cwd: "/work/docs/GROUPS_PLAN.html:12:3", editor: "vscode" },
  });
});

it.each([
  { name: "no match", paths: [] },
  {
    name: "basename and partial segment matches",
    paths: ["other/GROUPS_PLAN.html", "BudgetLens/mydocs/GROUPS_PLAN.html"],
  },
  { name: "ambiguous suffixes", paths: [indexedPath, "Other/docs/GROUPS_PLAN.html"] },
])("keeps the authored path and position for $name", async ({ paths }) => {
  state.search.mockResolvedValue(searchResult(paths));
  await renderMarkdown(fileChip);
  await activateFile("panel");
  expect(state.openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "docs/GROUPS_PLAN.html", 12);
  await activateFile("open");
  expect(state.openEditor).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: { cwd: "/work/docs/GROUPS_PLAN.html:12:3", editor: "vscode" },
  });
});

it.each(["open", "open-in-browser"])(
  "discards a pending %s lookup after a newer panel action in the same thread",
  async (action) => {
    const finishLookup = deferSearch();
    await renderMarkdown(fileChip);
    await activateFile(action);
    expect(state.search).toHaveBeenCalledOnce();
    expect(state.openEditor).not.toHaveBeenCalled();
    expect(state.openBrowser).not.toHaveBeenCalled();

    await renderMarkdown("`/outside/newer.ts:8`");
    await act(async () => anchor().click());
    expect(state.openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "/outside/newer.ts", 8);
    await finishLookup([indexedPath]);
    expect(state.openEditor).not.toHaveBeenCalled();
    expect(state.openBrowser).not.toHaveBeenCalled();
    expect(state.openFile).toHaveBeenCalledOnce();
  },
);

it.each([
  { environmentId: threadRef.environmentId, threadId: ThreadId.make("other-thread") },
  { environmentId: EnvironmentId.make("other-environment"), threadId: threadRef.threadId },
])("keeps pending file actions isolated from $environmentId/$threadId", async (otherRef) => {
  const finishLookup = deferSearch();
  await renderMarkdown(fileChip);
  await activateFile("panel");
  expect(state.search).toHaveBeenCalledOnce();
  expect(state.openFile).not.toHaveBeenCalled();

  await renderMarkdown("`/outside/other.ts:8`", otherRef);
  await act(async () => anchor().click());
  expect(state.openFile).toHaveBeenCalledExactlyOnceWith(otherRef, "/outside/other.ts", 8);
  await finishLookup([indexedPath]);
  expect(state.openFile).toHaveBeenNthCalledWith(2, threadRef, indexedPath, 12);
  expect(state.openFile).toHaveBeenCalledTimes(2);
});

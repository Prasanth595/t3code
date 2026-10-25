import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import "../index.css";

import { filesystemEnvironment } from "../state/filesystem";
import { useRightPanelStore } from "../rightPanelStore";
import { setMarkdownTaskChecked } from "./files/filePreviewMode";

const { workspaceSearch, filesystemMetadata, chipMetadata } = vi.hoisted(() => ({
  workspaceSearch: vi.fn(),
  filesystemMetadata: vi.fn(),
  chipMetadata: new Map<string, AsyncResult.AsyncResult<{ kind: "file" } | null>>(),
}));
vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: ((family: unknown) =>
    family === filesystemEnvironment.getMetadata ? filesystemMetadata : workspaceSearch) as never,
}));
// What each chip already fetched about its own path; unset paths have not loaded.
vi.mock(import("../hooks/useFileMetadata"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original()),
    fileMetadataAtom: ((_environmentId: unknown, path: string) =>
      Atom.make(chipMetadata.get(path) ?? AsyncResult.initial())) as never,
  };
});

// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("../state/session"), async (original) => {
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (environmentId: unknown, scope: string) =>
    environmentId !== null && granted.has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
const { renderDiagram } = vi.hoisted(() => ({
  renderDiagram: vi.fn<(source: string) => Promise<string> | undefined>(),
}));
// Control rendering latency without running Mermaid layout.
vi.mock(import("./chat/MermaidDiagram"), async (original) => {
  const { use } = await import("react");
  return {
    ...(await original()),
    MermaidDiagram: ({ source }: { source: string }) => {
      const pending = renderDiagram(source);
      return <svg role="img" aria-label={pending ? use(pending) : "Diagram"} />;
    },
  };
});

const settingsOverrides = vi.hoisted(() => ({ mathRenderingEnabled: false }));
vi.mock(import("../hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = { ...actual.getClientSettings(), ...settingsOverrides };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings };
});

import ChatMarkdown from "./ChatMarkdown";

function setup() {
  settingsOverrides.mathRenderingEnabled = false;
  renderDiagram.mockReset();
  workspaceSearch.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  filesystemMetadata.mockReset().mockResolvedValue(AsyncResult.success({ entries: [null] }));
  chipMetadata.clear();
}

function fileChip(container: HTMLElement, label: string) {
  const chip = [...container.querySelectorAll<HTMLElement>(".chat-markdown-file-link")].find(
    (element) => element.textContent === label,
  );
  if (!chip) throw new Error(`No file chip labelled ${label}`);
  return chip;
}

function renderText(text: string, props: Partial<Parameters<typeof ChatMarkdown>[0]> = {}) {
  return render(<ChatMarkdown cwd="/tmp/project" text={text} {...props} />);
}

function buttonsLabelled(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.getAttribute("aria-label") === label,
  );
}

describe("ChatMarkdown favicon privacy", () => {
  it("suppresses private link images while preserving public links across updates", async () => {
    setup();
    const markdown = (url: string) => <ChatMarkdown cwd="/tmp/project" text={`[Link](${url})`} />;
    await using screen = await render(markdown("https://example.com"));
    const { container, rerender } = screen;
    expect([...container.querySelectorAll("img")].map((image) => image.src)).toEqual([
      "https://www.google.com/s2/favicons?domain=example.com&sz=32",
    ]);
    for (const url of ["http://192.168.1.10:8080", "http://localhost:3000", "http://home.arpa"]) {
      await rerender(markdown(url));
      expect(container.querySelectorAll("img")).toHaveLength(0);
    }
    await rerender(markdown("https://example.com"));
    expect(container.querySelectorAll("img")).toHaveLength(1);
    await rerender(markdown("https://github.com/pingdotgg/t3code/pull/1"));
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelector("a svg")).not.toBeNull();
  });
});

describe("ChatMarkdown streaming", () => {
  it("runs only a complete single-line shell block after a click", async () => {
    setup();
    const onRunShellCommand = vi.fn();
    const message = (text: string, isStreaming = false) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        isStreaming={isStreaming}
        onRunShellCommand={onRunShellCommand}
      />
    );
    await using screen = await render(message("```bash\necho hello\n```", true));
    const { container, rerender } = screen;
    const runButtons = () => buttonsLabelled(container, "Run in terminal");
    expect(runButtons()).toHaveLength(0);

    await rerender(message("```bash\necho hello\n```"));
    await act(async () => runButtons()[0]!.click());
    expect(onRunShellCommand).toHaveBeenCalledExactlyOnceWith("echo hello");

    for (const text of [
      "~~~bash\necho tilde\n~~~",
      "> ```bash\n> echo quote\n> ```",
      "````bash\necho four\n````",
      "- Command\n\n  ```bash\n  echo list\n  ```",
      "```bash\r\necho crlf\r\n```\r",
    ]) {
      await rerender(message(text));
      expect(runButtons()).toHaveLength(1);
    }

    for (const text of [
      "```bash\necho one\necho two\n```",
      "```typescript\necho hello\n```",
      "```bash\n\n```",
      "```bash\necho hello\n\n```",
      "```bash\necho hello\\\n```",
      "```bash\necho safe \u202e#\n```",
      "```bash\necho incomplete",
      "~~~bash\necho incomplete",
      "````bash\necho incomplete\n```",
      '<pre><code class="language-bash">echo html</code></pre>',
    ]) {
      await rerender(message(text));
      expect(runButtons()).toHaveLength(0);
    }
  });

  it("edits the current task text and marker after reusing a renderer", async () => {
    setup();
    let editedText: string | undefined;
    let rerender: (next: ReactElement) => Promise<void> = async () => {};
    const message = (text: string): ReactElement => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        onTaskListChange={({ markerOffset, checked }) => {
          editedText = setMarkdownTaskChecked(text, markerOffset, checked);
          void rerender(message(editedText));
        }}
      />
    );
    await using rendered = await render(message("- [ ] First\n- [ ] Second"));
    rerender = rendered.rerender;
    const { container } = rendered;
    const checkboxes = () => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const original = checkboxes()[1]!;
    await rerender(message("- [ ] A longer first task\n- [ ] Second"));
    expect(checkboxes()[1]).toBe(original);

    await act(async () => original.click());
    expect(editedText).toBe("- [ ] A longer first task\n- [x] Second");
    await vi.waitFor(() => expect(checkboxes()[1]!.checked).toBe(true));
  });
});

describe("ChatMarkdown workspace file opens", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("workspace"),
    threadId: ThreadId.make("thread"),
  };

  it("keeps a newer absolute file open when an earlier repo-relative lookup finishes", async () => {
    setup();
    const result = AsyncResult.success({
      entries: [{ path: "notes/a.md", kind: "file" }],
      truncated: false,
    });
    let resolvePending!: (value: typeof result) => void;
    const pending = new Promise<typeof result>((resolve) => {
      resolvePending = resolve;
    });
    workspaceSearch.mockReturnValueOnce(pending);
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    await using screen = await renderText(
      "[Notes](physics/notes/a.md) and [Other](/elsewhere/b.md:9)",
      {
        cwd: "/school/physics",
        threadRef,
      },
    );
    const { container } = screen;
    const [notes, other] = container.querySelectorAll("a");
    await act(async () => notes!.click());
    expect(workspaceSearch).toHaveBeenCalledOnce();
    expect(openFile).not.toHaveBeenCalled();

    await act(async () => other!.click());
    await act(async () => resolvePending(result));

    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "/elsewhere/b.md", 9);
    expect(workspaceSearch).toHaveBeenCalledOnce();
  });

  it("opens a path relative to a folder the reply names when the workspace root lacks it", async () => {
    setup();
    chipMetadata.set("/tmp/work/phase2/A-findings.md", AsyncResult.success(null));
    filesystemMetadata.mockResolvedValue(
      AsyncResult.success({ entries: [null, { kind: "file" }] }),
    );
    const message = (folders: string) => (
      <ChatMarkdown
        cwd="/tmp/work"
        threadRef={threadRef}
        text={`Everything is in ${folders}.\n\n- \`phase2/A-findings.md\`: raw audit`}
      />
    );
    await using screen = await render(message("`/tmp/work/backend/.notes/audit/`"));
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    await act(async () => fileChip(screen.container, "A-findings.md").click());

    await vi.waitFor(() =>
      expect(openFile).toHaveBeenLastCalledWith(
        threadRef,
        "backend/.notes/audit/phase2/A-findings.md",
        undefined,
      ),
    );
    expect(filesystemMetadata).toHaveBeenCalledExactlyOnceWith({
      environmentId: threadRef.environmentId,
      input: {
        paths: [
          "/tmp/work/phase2/A-findings.md",
          "/tmp/work/backend/.notes/audit/phase2/A-findings.md",
        ],
      },
    });
    expect(workspaceSearch).not.toHaveBeenCalled();

    // A directory by that name is not the file the chip names.
    filesystemMetadata.mockResolvedValue(
      AsyncResult.success({ entries: [null, { kind: "directory" }, { kind: "file" }] }),
    );
    await screen.rerender(
      message("`/tmp/work/backend/.notes/audit/` and `/tmp/work/frontend/.notes/audit/`"),
    );
    await act(async () => fileChip(screen.container, "A-findings.md").click());
    await vi.waitFor(() =>
      expect(openFile).toHaveBeenLastCalledWith(
        threadRef,
        "frontend/.notes/audit/phase2/A-findings.md",
        undefined,
      ),
    );

    // Both named folders hold the file, so guessing could open the wrong one.
    filesystemMetadata.mockResolvedValue(
      AsyncResult.success({ entries: [null, { kind: "file" }, { kind: "file" }] }),
    );
    await act(async () => fileChip(screen.container, "A-findings.md").click());
    await vi.waitFor(() =>
      expect(openFile).toHaveBeenLastCalledWith(threadRef, "phase2/A-findings.md", undefined),
    );
  });

  it("opens the one nested repository file a repository-relative path names", async () => {
    setup();
    chipMetadata.set("/tmp/work/infra/main.tf", AsyncResult.success({ kind: "file" }));
    chipMetadata.set("/tmp/work/tests/sandbox/test_real.py", AsyncResult.success(null));
    chipMetadata.set("/tmp/work/docs/guide.md", AsyncResult.success(null));
    const files = (...paths: Array<string>) =>
      AsyncResult.success({
        entries: paths.map((path) => ({ path, kind: "file" })),
        truncated: false,
      });
    workspaceSearch.mockImplementation(async ({ input }: { input: { query: string } }) =>
      input.query === "tests/sandbox/test_real.py"
        ? files("backend/tests/sandbox/test_real.py", "backend/tests/sandbox/test_real_more.py")
        : files("backend/docs/guide.md", "frontend/docs/guide.md"),
    );
    await using screen = await renderText(
      "Changed `infra/main.tf` and `notes/todo.md`, skipped `tests/sandbox/test_real.py`, kept `docs/guide.md`.",
      { cwd: "/tmp/work", threadRef },
    );
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    const { container } = screen;

    // A file the root has, or one whose metadata has not loaded, opens without waiting.
    await act(async () => fileChip(container, "main.tf").click());
    expect(openFile).toHaveBeenLastCalledWith(threadRef, "infra/main.tf", undefined);
    await act(async () => fileChip(container, "todo.md").click());
    expect(openFile).toHaveBeenLastCalledWith(threadRef, "notes/todo.md", undefined);
    expect(filesystemMetadata).not.toHaveBeenCalled();
    expect(workspaceSearch).not.toHaveBeenCalled();

    await act(async () => fileChip(container, "test_real.py").click());
    await vi.waitFor(() =>
      expect(openFile).toHaveBeenLastCalledWith(
        threadRef,
        "backend/tests/sandbox/test_real.py",
        undefined,
      ),
    );

    // Two repositories hold this path, so guessing could open the wrong file.
    await act(async () => fileChip(container, "guide.md").click());
    await vi.waitFor(() =>
      expect(openFile).toHaveBeenLastCalledWith(threadRef, "docs/guide.md", undefined),
    );
    expect(openFile).toHaveBeenCalledTimes(4);
  });
});

describe("ChatMarkdown headings", () => {
  it("never gives two headings the same id, even when a suffix matches another heading", async () => {
    setup();
    await using screen = await renderText(
      '## Setup\n\n## Setup\n\n## Setup-1\n\n<h2 id="install-1">Pinned</h2>\n\n## Install\n\n## Install',
      { parseRawHtml: true },
    );
    const { container } = screen;
    expect([...container.querySelectorAll("h2")].map((heading) => heading.id)).toEqual([
      "user-content-setup",
      "user-content-setup-1",
      "user-content-setup-1-1",
      "user-content-install-1",
      "user-content-install",
      "user-content-install-2",
    ]);
  });
});

describe("ChatMarkdown Windows file links", () => {
  const environmentId = EnvironmentId.make("env-windows");
  const renderWindows = (text: string, parseRawHtml: boolean) =>
    renderText(text, {
      cwd: "C:/Users/shawn/project",
      environmentId,
      lineBreaks: !parseRawHtml,
      parseRawHtml,
    });
  const fileHrefs = (container: HTMLElement) =>
    [...container.querySelectorAll(".chat-markdown-file-link")].map((chip) =>
      chip.getAttribute("href"),
    );

  it("still rejects unsafe schemes", async () => {
    setup();
    for (const parseRawHtml of [true, false]) {
      await using screen = await renderWindows(
        "[unsafe](javascript:alert(1)) and [unknown](d:alert(1))",
        parseRawHtml,
      );
      const { container } = screen;
      expect(container.innerHTML).not.toContain("javascript:");
      expect(container.innerHTML).not.toContain("d:alert");
      expect(fileHrefs(container)).toEqual([]);
    }
  });
});

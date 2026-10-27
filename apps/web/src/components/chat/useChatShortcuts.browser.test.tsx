import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type PullRequestReviewGuide,
} from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { useReviewGuideWriter } from "../pullRequest/guide/useReviewGuideWriter";
import { PullRequestGuideTab } from "../pullRequest/PullRequestGuideTab";
import type { ChatComposerHandle } from "./ChatComposer";
import { useChatShortcuts } from "./useChatShortcuts";

const shortcutContext = {
  terminalFocus: false,
  terminalOpen: false,
  previewFocus: false,
  previewOpen: false,
  isWeb: true,
  isDesktop: false,
  modelPickerOpen: false,
};

const focusOnMount = (element: HTMLElement | null) => element?.focus();

// Stands in for the right panel's launcher, which needs the whole app around it. Like the
// real one it takes focus, advertises its letters in `data-surface-launcher-keys`, and
// claims one from its own window capture listener unless the key was already handled.
function Launcher(props: { keys: string; received: string[] }) {
  useEffect(() => {
    const claim = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!props.keys.toLowerCase().split("").includes(event.key.toLowerCase())) return;
      event.preventDefault();
      props.received.push(event.key);
    };
    window.addEventListener("keydown", claim, true);
    return () => window.removeEventListener("keydown", claim, true);
  }, [props.keys, props.received]);
  return (
    <div
      ref={focusOnMount}
      tabIndex={0}
      aria-label="Open a surface"
      data-surface-launcher-keys={props.keys}
    />
  );
}

// The chat's shortcut listener registers when the chat mounts, so a launcher that opens
// later registers after it. Tests mount the chat first and add the launcher by rerendering.
function Chat(props: { composerKeys: string[]; launcher?: { keys: string; received: string[] } }) {
  useChatShortcuts({
    enabled: true,
    keybindings: [],
    scriptKeybindings: [],
    getShortcutContext: () => shortcutContext,
    threadFindActive: false,
    // Type-to-focus only calls insertTextAtEnd, so the stand-in composer implements just that.
    composerRef: {
      current: {
        insertTextAtEnd: (key: string) => {
          props.composerKeys.push(key);
          return true;
        },
      } as Partial<ChatComposerHandle> as ChatComposerHandle,
    },
    branchToolbarRef: { current: null },
    closeThreadFind: () => {},
    commands: {},
    fallback: () => undefined,
  });
  return props.launcher ? <Launcher {...props.launcher} /> : null;
}

// The guide tab's server query. A test delivers the guide through `setup`, which re-renders
// the tab the way a query result does; `null` keeps it loading.
const guideQuery = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    guide: null as PullRequestReviewGuide | null,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify: () => listeners.forEach((listener) => listener()),
  };
});
vi.mock(import("../pullRequest/guide/useReviewGuideWriter"), () => ({
  useReviewGuideWriter: function useReviewGuideWriterStub() {
    const guide = useSyncExternalStore(guideQuery.subscribe, () => guideQuery.guide);
    return {
      query: { isPending: guide === null, error: null },
      data: guide === null ? null : { currentHeadSha: "head", run: null, guide },
      running: false,
      canWrite: false,
      write: async () => {},
    } as Partial<ReturnType<typeof useReviewGuideWriter>> as ReturnType<
      typeof useReviewGuideWriter
    >;
  },
}));

// router: false because the chat shortcuts and the launcher stand-in never navigate.
const options = { router: false } as const;

it("leaves the launcher's letters to the launcher, in either case", async () => {
  const composerKeys: string[] = [];
  const received: string[] = [];
  await using screen = await render(<Chat composerKeys={composerKeys} />, options);
  await screen.rerender(<Chat composerKeys={composerKeys} launcher={{ keys: "BT", received }} />);

  await userEvent.keyboard("tT");

  expect(received).toEqual(["t", "T"]);
  expect(composerKeys).toEqual([]);
});

it("still types other letters into the composer while the launcher is open", async () => {
  const composerKeys: string[] = [];
  const received: string[] = [];
  await using screen = await render(<Chat composerKeys={composerKeys} />, options);
  await screen.rerender(<Chat composerKeys={composerKeys} launcher={{ keys: "BT", received }} />);

  await userEvent.keyboard("a");

  expect(composerKeys).toEqual(["a"]);
  expect(received).toEqual([]);
});

const guide: PullRequestReviewGuide = {
  headSha: "head",
  generatedAt: "2026-09-01T00:00:00Z",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  stops: ["First change", "Second change"].map((title) => ({
    title,
    summary: "",
    attention: null,
    excerpts: [],
    files: [],
    notes: [],
    questions: [],
  })),
};

function setup(loadedGuide: PullRequestReviewGuide | null) {
  guideQuery.guide = loadedGuide;
  guideQuery.notify();
}

// The chat and the right panel side by side. Each test reviews its own PR number because the
// tour remembers its position per PR.
function ChatBesideGuide(props: { composerKeys: string[]; number: number; active?: boolean }) {
  return (
    <>
      <Chat composerKeys={props.composerKeys} />
      <div data-chat-column>Transcript</div>
      <div data-right-panel-tabbar>
        <button type="button">Guide tab</button>
      </div>
      <PullRequestGuideTab
        environmentId={EnvironmentId.make("env-1")}
        reference={{
          projectId: ProjectId.make("project-1"),
          repository: "acme/app",
          number: props.number,
        }}
        title={null}
        workspaceRoot="/repo"
        active={props.active ?? true}
        canComment={false}
        rangeComments={false}
        onAskAboutLines={null}
        onAskAboutStop={null}
        onFinishReview={null}
        onOpenFile={() => {}}
      />
    </>
  );
}

const stop = (name: string) => page.getByRole("heading", { name });

it("steps the guide with J/K after a click in its panel, and types them after a chat click", async () => {
  setup(guide);
  const composerKeys: string[] = [];
  await using screen = await render(<Chat composerKeys={composerKeys} />, options);
  await screen.rerender(<ChatBesideGuide composerKeys={composerKeys} number={1} />);

  await stop("First change").click();
  await userEvent.keyboard("j");
  await expect.element(stop("Second change")).toBeVisible();
  expect(composerKeys).toEqual([]);

  await page.getByText("Transcript").click();
  await userEvent.keyboard("k");
  expect(composerKeys).toEqual(["k"]);
  await expect.element(stop("Second change")).toBeVisible();

  await page.getByRole("button", { name: "Guide tab" }).click();
  await userEvent.keyboard("k");
  await expect.element(stop("First change")).toBeVisible();
  expect(composerKeys).toEqual(["k"]);
});

it("types J into the composer after a chat click made while the guide was loading", async () => {
  setup(null);
  const composerKeys: string[] = [];
  await using screen = await render(<Chat composerKeys={composerKeys} />, options);
  await screen.rerender(<ChatBesideGuide composerKeys={composerKeys} number={2} />);
  await page.getByText("Transcript").click();

  setup(guide);
  await expect.element(stop("First change")).toBeVisible();
  await userEvent.keyboard("j");

  expect(composerKeys).toEqual(["j"]);
  await expect.element(stop("First change")).toBeVisible();
});

it("types J into the composer once the guide's panel closes", async () => {
  setup(guide);
  const composerKeys: string[] = [];
  await using screen = await render(<Chat composerKeys={composerKeys} />, options);
  await screen.rerender(<ChatBesideGuide composerKeys={composerKeys} number={3} />);
  await stop("First change").click();

  await screen.rerender(<ChatBesideGuide composerKeys={composerKeys} number={3} active={false} />);
  await userEvent.keyboard("j");

  expect(composerKeys).toEqual(["j"]);
  await expect.element(stop("First change")).toBeVisible();
});

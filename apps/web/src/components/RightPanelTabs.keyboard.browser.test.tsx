import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@t3tools/shared/keybindings";

import { act, fakeTimers, render, stubGlobal } from "../../test/render";
import { RightPanelTabs } from "./RightPanelTabs";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";

vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock(import("~/browser/browserDefaults"), async (importOriginal) => ({
  ...(await importOriginal()),
  useBrowserDefaults: (() => ({ profiles: [] })) as never,
}));

const noop = () => undefined;

function setup() {
  const state = useRightPanelStore.getState();
  useRightPanelStore.setState(useRightPanelStore.getInitialState(), true);
  return { [Symbol.dispose]: () => useRightPanelStore.setState(state, true) };
}

async function settle() {
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersToNextFrame());
}

async function renderPanel(
  overrides: Partial<ComponentProps<typeof RightPanelTabs>> = {},
  platform = "MacIntel",
) {
  await using stack = new AsyncDisposableStack();
  stack.use(fakeTimers());
  stack.use(
    stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    ),
  );
  // Menus wait for exit animations to finish, which never happens under fake timers.
  stack.use(vi.spyOn(Element.prototype, "getAnimations").mockReturnValue([]));
  stack.use(vi.spyOn(navigator, "platform", "get").mockReturnValue(platform));
  const addFiles = vi.fn();
  const panel = (props: Partial<ComponentProps<typeof RightPanelTabs>>) => (
    <RightPanelTabs
      mode="inline"
      open
      keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
      getShortcutContext={() => ({
        terminalFocus: false,
        terminalOpen: false,
        previewFocus: false,
        previewOpen: false,
        isWeb: true,
        isDesktop: false,
      })}
      surfaces={[]}
      environmentId={null}
      activeSurfaceId={null}
      pendingSurfaceIds={new Set()}
      previewSessions={{}}
      desktopByTabId={{}}
      terminalLabelsById={new Map()}
      onActivate={noop}
      onCloseSurface={noop}
      onCloseOtherSurfaces={noop}
      onCloseSurfacesToRight={noop}
      onCloseAllSurfaces={noop}
      onCopyFilePath={noop}
      onAddBrowser={noop}
      onAddBrowserInProfile={noop}
      onAddTerminal={noop}
      onAddDiff={noop}
      onAddFiles={addFiles}
      onAddPullRequest={noop}
      onAddPullRequests={noop}
      onAddDevice={noop}
      browserAvailable={false}
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable
      pullRequestAvailable={false}
      pullRequestsAvailable={false}
      deviceAvailable={false}
      {...props}
    >
      content
    </RightPanelTabs>
  );
  // Nothing here navigates, and the test router would load on the fake clock too.
  const screen = stack.use(await render(panel(overrides), { router: false }));
  await settle();
  const environment = stack.move();
  return {
    container: screen.container,
    addFiles,
    rerender: async (props: Partial<ComponentProps<typeof RightPanelTabs>>) => {
      await screen.rerender(panel(props));
      await settle();
    },
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

async function press(key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  await act(() => (document.activeElement ?? document.body).dispatchEvent(event));
  await settle();
  return event;
}

it("keeps native issue labels beside pull request tabs", async () => {
  using _state = setup();
  const issue = (tracker: string, scope: string, key: string) =>
    ({
      id: `issue:${tracker}:${scope}:${key}`,
      kind: "issue",
      projectId: "p",
      tracker,
      scope,
      key,
    }) as const;
  await using screen = await renderPanel({
    surfaces: [
      { ...issue("forgejo", "Mount/acme/web", "42"), connectionId: "Account/B" },
      issue("github", "acme/web", "7"),
      issue("gitlab", "acme/api", "7"),
      issue("linear", "ENG", "ENG-12"),
      issue("jira", "PROJ", "PROJ-3"),
      {
        id: "pull-request:p:acme/api:7",
        kind: "pull-request",
        projectId: "p",
        repository: "acme/api",
        number: 7,
      },
    ],
  });
  expect(
    [...screen.container.querySelectorAll('[aria-label^="Close "]')].map((button) =>
      button.getAttribute("aria-label"),
    ),
  ).toEqual([
    "Close Mount/acme/web#42",
    "Close acme/web#7",
    "Close acme/api#7",
    "Close ENG-12",
    "Close PROJ-3",
    "Close #7",
  ]);
});

describe("right panel new-tab shortcut", () => {
  const threadRef = scopeThreadRef(EnvironmentId.make("thread-A"), ThreadId.make("thread"));
  const otherRef = scopeThreadRef(EnvironmentId.make("other-B"), ThreadId.make("thread"));
  const linkedState = () =>
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);

  describe.each(["inline", "sheet"] as const)("linked issues in %s mode", (mode) => {
    it.each(["empty shortcut", "menu click", "menu shortcut"] as const)(
      "opens the native thread panel using %s",
      async (entry) => {
        using _state = setup();
        if (entry !== "empty shortcut") useRightPanelStore.getState().open(threadRef, "files");
        await using _screen = await renderPanel({
          mode,
          environmentId: threadRef.environmentId,
          ...linkedState(),
          issuesAvailable: true,
          onAddIssues: () => useRightPanelStore.getState().open(threadRef, "issues"),
        });
        if (entry === "empty shortcut") {
          expect((await press("i")).defaultPrevented).toBe(true);
          await press("i");
        } else {
          await press("t", { metaKey: true });
          const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
            (element) => element.textContent?.includes("Linked issues"),
          );
          expect(item).toBeDefined();
          expect(item?.getAttribute("aria-keyshortcuts")).toBe("I");
          if (entry === "menu click") await act(() => item?.click());
          else await press("i");
          expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
        }
        expect(linkedState().surfaces.filter((surface) => surface.kind === "issues")).toEqual([
          { id: "issues", kind: "issues" },
        ]);
        expect(linkedState().activeSurfaceId).toBe("issues");
        expect(
          selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, otherRef).surfaces,
        ).toEqual([]);
      },
    );
  });

  it.each([false, true])(
    "does not launch linked issues with unavailable configuration %s",
    async (missingHandler) => {
      using _state = setup();
      await using screen = await renderPanel(
        missingHandler
          ? { issuesAvailable: true }
          : {
              issuesAvailable: false,
              onAddIssues: () => useRightPanelStore.getState().open(threadRef, "issues"),
            },
      );
      expect((await press("i")).defaultPrevented).toBe(false);
      expect(
        Array.from(screen.container.querySelectorAll("button")).some((element) =>
          element.textContent?.includes("Linked issues"),
        ),
      ).toBe(false);
      await press("t", { metaKey: true });
      await press("i");
      const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
        (element) => element.textContent?.includes("Linked issues"),
      );
      expect(item?.getAttribute("aria-disabled")).toBe("true");
      expect(linkedState().surfaces).toEqual([]);
    },
  );

  it.each(["MacIntel", "Win32", "Linux x86_64"])(
    "opens the menu on %s and chooses a tab",
    async (platform) => {
      await using screen = await renderPanel({}, platform);
      const event = await press(
        "t",
        platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true },
      );
      expect(event.defaultPrevented).toBe(true);
      expect(document.querySelector('[role="menu"]')?.textContent).toContain(
        "Linked pull requests",
      );
      expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull();
      expect(
        (
          await press("t", {
            metaKey: platform === "MacIntel",
            ctrlKey: platform !== "MacIntel",
            repeat: true,
          })
        ).defaultPrevented,
      ).toBe(true);
      await press("f");
      expect(screen.addFiles).toHaveBeenCalledOnce();
      expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
    },
  );

  it("opens Files while a closed popup remains mounted", async () => {
    await using screen = await renderPanel();
    const popup = document.createElement("div");
    popup.dataset.slot = "menu-popup";
    popup.dataset.closed = "";
    screen.container.append(popup);

    expect((await press("f")).defaultPrevented).toBe(true);
    expect(screen.addFiles).toHaveBeenCalledOnce();
  });

  it("opens the add-surface menu while a closed popup remains mounted", async () => {
    await using screen = await renderPanel();
    const popup = document.createElement("div");
    popup.dataset.slot = "menu-popup";
    popup.dataset.closed = "";
    screen.container.append(popup);

    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(true);
    expect(document.querySelector('[role="menu"]:not([data-closed])')).not.toBeNull();
  });

  it("leaves the shortcut alone while the mounted panel is closed", async () => {
    await using _screen = await renderPanel({ open: false });
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
  });

  it.each(["Win32", "Linux x86_64"])(
    "leaves Ctrl+T for the focused terminal on %s",
    async (platform) => {
      await using screen = await renderPanel(
        {
          getShortcutContext: () => ({
            terminalFocus: true,
            terminalOpen: true,
            previewFocus: false,
            previewOpen: false,
            isWeb: true,
            isDesktop: false,
          }),
        },
        platform,
      );
      const terminal = document.createElement("textarea");
      const onKeyDown = vi.fn();
      terminal.addEventListener("keydown", onKeyDown);
      screen.container.append(terminal);
      await act(() => terminal.focus());
      const event = await press("t", { ctrlKey: true });
      expect(event.defaultPrevented).toBe(false);
      expect(onKeyDown).toHaveBeenCalledWith(event);
      expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
    },
  );

  it("uses a custom binding from a text field and closes on Escape", async () => {
    const input = document.createElement("input");
    await using screen = await renderPanel({
      keybindings: compileResolvedKeybindingsConfig([{ key: "mod+y", command: "rightPanel.new" }]),
    });
    document.body.append(input);
    using _input = { [Symbol.dispose]: () => input.remove() };
    input.focus();
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    await press("y", { metaKey: true });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await press("Escape");
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
    // The menu hands focus back to its trigger once its close finishes, a few frames later.
    // Timers are fake here, so advance them instead of polling in real time.
    const trigger = screen.container.querySelector('[aria-label="Add panel surface"]');
    for (let frame = 0; frame < 10 && document.activeElement !== trigger; frame++) {
      await act(() => vi.advanceTimersToNextFrame());
    }
    expect(document.activeElement).toBe(trigger);
  });

  it("does not open over another popup or during text composition", async () => {
    await using screen = await renderPanel();
    expect((await press("t", { metaKey: true, isComposing: true })).defaultPrevented).toBe(false);
    const dialog = document.createElement("div");
    dialog.dataset.slot = "dialog-popup";
    dialog.dataset.open = "";
    screen.container.append(dialog);
    for (const state of ["data-open", "data-ending-style"]) {
      dialog.setAttribute(state, "");
      expect((await press("f")).defaultPrevented, state).toBe(false);
      expect(screen.addFiles, state).not.toHaveBeenCalled();
      expect((await press("t", { metaKey: true })).defaultPrevented, state).toBe(false);
      expect(document.querySelector('[role="menu"]'), state).toBeNull();
      dialog.removeAttribute(state);
    }
  });

  it("blocks panel shortcuts until a mounted popup finishes closing", async () => {
    await using screen = await renderPanel();
    const popover = document.createElement("div");
    popover.dataset.slot = "popover-popup";
    popover.dataset.open = "";
    screen.container.append(popover);

    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    expect((await press("f")).defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(screen.addFiles).not.toHaveBeenCalled();

    delete popover.dataset.open;
    popover.dataset.closed = "";
    popover.dataset.endingStyle = "";
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    expect((await press("f")).defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(screen.addFiles).not.toHaveBeenCalled();

    delete popover.dataset.endingStyle;
    popover.hidden = true;
    expect((await press("f")).defaultPrevented).toBe(true);
    expect(screen.addFiles).toHaveBeenCalledOnce();
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(true);
    expect(document.querySelector('[role="menu"]')?.textContent).toContain("Files");
    expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull();
  });

  it("supports arrow keys with an existing tab in sheet mode and clears the menu on close", async () => {
    const panel = {
      mode: "sheet" as const,
      surfaces: [{ id: "files" as const, kind: "files" as const }],
    };
    await using screen = await renderPanel(panel);
    await press("t", { metaKey: true });
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(document.activeElement?.textContent).toContain("Files");
    await press("Enter");
    expect(screen.addFiles).toHaveBeenCalledOnce();
    await press("t", { metaKey: true });
    await screen.rerender({ ...panel, open: false });
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
    await screen.rerender(panel);
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
  });
});

describe("right panel tab middle click", () => {
  it("cancels middle-button defaults and closes once while preserving other buttons", async () => {
    const onActivate = vi.fn();
    const onCloseSurface = vi.fn();
    const files = { id: "files" as const, kind: "files" as const };
    await using screen = await renderPanel({
      surfaces: [files],
      activeSurfaceId: files.id,
      onActivate,
      onCloseSurface,
    });
    const tabLabel = screen.container.querySelector("[data-active-tab] span.truncate")!;
    const mouse = async (type: string, button: number) => {
      const event = new MouseEvent(type, { button, bubbles: true, cancelable: true });
      await act(() => tabLabel.dispatchEvent(event));
      return event;
    };

    expect((await mouse("mousedown", 0)).defaultPrevented).toBe(false);
    expect((await mouse("mouseup", 0)).defaultPrevented).toBe(false);
    expect((await mouse("click", 0)).defaultPrevented).toBe(false);
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(files);
    expect((await mouse("mousedown", 2)).defaultPrevented).toBe(false);
    expect((await mouse("mouseup", 2)).defaultPrevented).toBe(false);
    expect((await mouse("auxclick", 2)).defaultPrevented).toBe(false);
    expect(onCloseSurface).not.toHaveBeenCalled();

    expect((await mouse("mousedown", 1)).defaultPrevented).toBe(true);
    expect((await mouse("mouseup", 1)).defaultPrevented).toBe(true);
    expect(onCloseSurface).not.toHaveBeenCalled();
    expect((await mouse("auxclick", 1)).defaultPrevented).toBe(true);
    expect(onCloseSurface).toHaveBeenCalledExactlyOnceWith(files);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});

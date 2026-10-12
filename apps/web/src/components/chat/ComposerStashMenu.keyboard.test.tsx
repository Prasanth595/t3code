// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Dialog, DialogPopup } from "../ui/dialog";
import { ComposerStashMenu } from "./ComposerStashMenu";

const entries = ["first", "second"].map((id) => ({
  id,
  createdAt: new Date(0).toISOString(),
  prompt: `${id} prompt`,
  attachments: [],
  droppedImageNames: [],
}));

const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView",
);
const getAnimationsDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  if (scrollIntoViewDescriptor) {
    Object.defineProperty(Element.prototype, "scrollIntoView", scrollIntoViewDescriptor);
  } else {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  }
  if (getAnimationsDescriptor) {
    Object.defineProperty(Element.prototype, "getAnimations", getAnimationsDescriptor);
  } else {
    Reflect.deleteProperty(Element.prototype, "getAnimations");
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("stash keyboard scope", () => {
  it.each([
    { key: "Enter" },
    { key: "Backspace", ctrlKey: true },
    { key: "Backspace", metaKey: true },
  ])("lets $key reach a dialog input while the drawer is open", async (key) => {
    const composerFormRef = createRef<HTMLFormElement>();
    const onRestore = vi.fn();
    const onDelete = vi.fn();
    const onClose = vi.fn();
    const onKeyDown = vi.fn();
    await act(() =>
      root.render(
        <>
          <form ref={composerFormRef}>
            <div data-testid="composer-editor" contentEditable />
          </form>
          <ComposerStashMenu
            composerFormRef={composerFormRef}
            entries={entries}
            stashShortcutLabel="Ctrl+S"
            onRestore={onRestore}
            onDelete={onDelete}
            onClose={onClose}
          />
          <Dialog open>
            <DialogPopup aria-label="Command palette">
              <input aria-label="Search commands" onKeyDown={onKeyDown} />
            </DialogPopup>
          </Dialog>
        </>,
      ),
    );
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search commands"]')!;
    await act(() => input.focus());
    const event = new KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true });
    await act(() => {
      input.dispatchEvent(event);
    });
    expect(onRestore).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onKeyDown).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(false);
  });
});

async function renderComposer(
  initialFocus?: "editor" | "badge" | "other",
  editorDisabled = false,
  removeDeletedEntries = false,
) {
  const composerFormRef = createRef<HTMLFormElement>();
  let currentEntries = entries;
  const onRestore = vi.fn();
  const onDelete = vi.fn((entry: { id: string }) => {
    if (removeDeletedEntries) {
      currentEntries = currentEntries.filter((candidate) => candidate.id !== entry.id);
      root.render(render(currentEntries.length > 0));
    }
  });
  const onClose = vi.fn(() => root.render(render(false)));
  const render = (showDrawer: boolean) => (
    <>
      <form ref={composerFormRef}>
        <div
          data-testid="composer-editor"
          // jsdom treats contenteditable="false" as focusable; omit it for the disabled fixture.
          contentEditable={editorDisabled ? undefined : true}
          suppressContentEditableWarning
        >
          Draft
        </div>
        <input aria-label="Other composer field" />
        <button type="button" data-prompt-stash-badge="true">
          Stash
        </button>
      </form>
      <form>
        <div data-testid="composer-editor" contentEditable />
      </form>
      {showDrawer && (
        <ComposerStashMenu
          composerFormRef={composerFormRef}
          entries={currentEntries}
          stashShortcutLabel="Ctrl+S"
          onRestore={onRestore}
          onDelete={onDelete}
          onClose={onClose}
        />
      )}
    </>
  );
  if (initialFocus) {
    await act(() => root.render(render(false)));
    const selector =
      initialFocus === "editor"
        ? '[data-testid="composer-editor"]'
        : initialFocus === "badge"
          ? '[data-prompt-stash-badge="true"]'
          : 'input[aria-label="Other composer field"]';
    await act(() => host.querySelector<HTMLElement>(selector)!.focus());
  }
  await act(() => root.render(render(true)));
  return { onRestore, onDelete, onClose };
}

async function press(target: HTMLElement, key: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true });
  await act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

it.each([undefined, "badge"] as const)(
  "focuses the composer editor when the drawer opens from %s",
  async (initialFocus) => {
    const { onRestore } = await renderComposer(initialFocus);
    const editor = host.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
    expect(document.activeElement).toBe(editor);
    await press(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(editor);
    expect(
      host.querySelector('[data-stash-entry="second"]')?.getAttribute("data-highlighted"),
    ).toBe("true");
    await press(document.activeElement as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(editor);
    expect((await press(editor, { key: "Enter" })).defaultPrevented).toBe(true);
    expect(onRestore).toHaveBeenCalledExactlyOnceWith(entries[0]);
  },
);

it.each(["editor", "other"] as const)(
  "keeps focus in the %s field when the drawer opens",
  async (initialFocus) => {
    await renderComposer(initialFocus);
    expect(document.activeElement).toBe(
      host.querySelector(
        initialFocus === "editor"
          ? '[data-testid="composer-editor"]'
          : 'input[aria-label="Other composer field"]',
      ),
    );
  },
);

it.each([undefined, "badge"] as const)(
  "uses a drawer button when opening from %s with a disabled editor",
  async (initialFocus) => {
    const { onRestore } = await renderComposer(initialFocus, true);
    const first = host.querySelector<HTMLButtonElement>('[data-stash-restore="first"]')!;
    expect(document.activeElement).toBe(first);
    await press(first, { key: "ArrowDown" });
    const second = host.querySelector<HTMLButtonElement>('[data-stash-restore="second"]')!;
    expect(document.activeElement).toBe(second);
    expect((await press(second, { key: "Enter" })).defaultPrevented).toBe(false);
    await act(() => second.click());
    expect(onRestore).toHaveBeenCalledExactlyOnceWith(entries[1]);
    await press(second, { key: "Escape" });
    expect(host.querySelector('[data-composer-stash-drawer="true"]')).toBeNull();
    expect(document.activeElement).toBe(
      initialFocus === "badge"
        ? host.querySelector('[data-prompt-stash-badge="true"]')
        : document.body,
    );
  },
);

it.each([undefined, "badge"] as const)(
  "keeps editor focus after closing a drawer opened from %s",
  async (initialFocus) => {
    await renderComposer(initialFocus);
    const editor = host.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
    await press(editor, { key: "Escape" });
    expect(host.querySelector('[data-composer-stash-drawer="true"]')).toBeNull();
    expect(document.activeElement).toBe(editor);
  },
);

it.each([
  { editorDisabled: false, method: "shortcut" },
  { editorDisabled: true, method: "shortcut" },
  { editorDisabled: false, method: "button" },
  { editorDisabled: true, method: "button" },
])(
  "keeps drawer navigation after $method deletion with editorDisabled=$editorDisabled",
  async ({ editorDisabled, method }) => {
    const { onDelete, onRestore } = await renderComposer("badge", editorDisabled, true);
    const first = host.querySelector<HTMLButtonElement>('[data-stash-restore="first"]')!;
    await act(() => first.focus());
    if (method === "shortcut") {
      await press(first, { key: "Backspace", ctrlKey: true });
    } else {
      const remove = host.querySelector<HTMLButtonElement>(
        '[data-stash-entry="first"] button[aria-label="Delete stashed prompt"]',
      )!;
      await act(() => remove.focus());
      await press(remove, { key: "Enter" });
      await act(() => remove.click());
    }
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(entries[0]);
    expect(host.querySelector('[data-stash-entry="first"]')).toBeNull();
    const second = host.querySelector<HTMLButtonElement>('[data-stash-restore="second"]')!;
    expect(document.activeElement).toBe(second);
    expect((await press(second, { key: "ArrowUp" })).defaultPrevented).toBe(true);
    expect((await press(second, { key: "Enter" })).defaultPrevented).toBe(false);
    await act(() => second.click());
    expect(onRestore).toHaveBeenCalledExactlyOnceWith(entries[1]);
    await press(second, { key: "Backspace", ctrlKey: true });
    expect(host.querySelector('[data-composer-stash-drawer="true"]')).toBeNull();
  },
);

it.each(["editor", "drawer"])(
  "keeps stash navigation, restoration, deletion and dismissal in the %s",
  async (scope) => {
    const { onRestore, onDelete, onClose } = await renderComposer();
    const target = host.querySelector<HTMLElement>(
      scope === "editor"
        ? '[data-testid="composer-editor"]'
        : '[data-composer-stash-drawer="true"]',
    )!;
    target.tabIndex = -1;
    await act(() => target.focus());
    expect((await press(target, { key: "ArrowDown" })).defaultPrevented).toBe(true);
    expect(
      host.querySelector('[data-stash-entry="second"]')?.getAttribute("data-highlighted"),
    ).toBe("true");
    expect((await press(target, { key: "ArrowUp" })).defaultPrevented).toBe(true);
    expect(host.querySelector('[data-stash-entry="first"]')?.getAttribute("data-highlighted")).toBe(
      "true",
    );
    expect((await press(target, { key: "Enter" })).defaultPrevented).toBe(true);
    expect(onRestore).toHaveBeenCalledExactlyOnceWith(entries[0]);
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      expect((await press(target, { key: "Backspace", ...modifier })).defaultPrevented).toBe(true);
    }
    expect(onDelete).toHaveBeenCalledTimes(2);
    expect(onDelete).toHaveBeenLastCalledWith(entries[scope === "drawer" ? 1 : 0]);
    await press(target, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  },
);

it("moves focus between drawer rows and leaves Enter activation to the delete button", async () => {
  const { onRestore, onDelete } = await renderComposer();
  const first = host.querySelector<HTMLButtonElement>('[data-stash-restore="first"]')!;
  await act(() => first.focus());
  await press(first, { key: "ArrowDown" });
  expect(document.activeElement).toBe(host.querySelector('[data-stash-restore="second"]'));
  const remove = host.querySelector<HTMLButtonElement>(
    '[data-stash-entry="second"] button[aria-label="Delete stashed prompt"]',
  )!;
  await act(() => remove.focus());
  expect((await press(remove, { key: "Enter" })).defaultPrevented).toBe(false);
  // jsdom does not perform the native button click generated by Enter.
  await act(() => remove.click());
  expect(onDelete).toHaveBeenCalledExactlyOnceWith(entries[1]);
  expect(onRestore).not.toHaveBeenCalled();
});

it.each([
  'input[aria-label="Other composer field"]',
  'form:nth-child(2) [data-testid="composer-editor"]',
])("ignores stash keys in %s", async (selector) => {
  const { onRestore, onDelete, onClose } = await renderComposer();
  const target = host.querySelector<HTMLElement>(selector)!;
  await act(() => target.focus());
  for (const key of ["ArrowUp", "ArrowDown", "Enter", "Escape", "Backspace"]) {
    expect((await press(target, { key, ctrlKey: key === "Backspace" })).defaultPrevented).toBe(
      false,
    );
  }
  expect(onRestore).not.toHaveBeenCalled();
  expect(onDelete).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(host.querySelector('[data-stash-entry="first"]')?.getAttribute("data-highlighted")).toBe(
    "true",
  );
});

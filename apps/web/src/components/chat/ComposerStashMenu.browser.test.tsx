import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { Dialog, DialogPopup } from "../ui/dialog";
import { ComposerStashMenu } from "./ComposerStashMenu";

function Composer({ dialog = false }: { dialog?: boolean }) {
  const composerFormRef = useRef<HTMLFormElement>(null);
  const [entries, setEntries] = useState(
    ["first", "second"].map((id) => ({
      id,
      createdAt: "2026-10-01T00:00:00.000Z",
      prompt: `${id} prompt`,
      attachments: [],
      droppedImageNames: [],
    })),
  );
  const [draft, setDraft] = useState("Unsent draft");
  const [open, setOpen] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(dialog);
  return (
    <>
      <form ref={composerFormRef}>
        <textarea
          aria-label="Message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </form>
      <input aria-label="Search threads" />
      <button onClick={() => setOpen(true)}>Open stash</button>
      {open && (
        <ComposerStashMenu
          composerFormRef={composerFormRef}
          entries={entries}
          stashShortcutLabel="Ctrl+S"
          onRestore={(entry) => {
            setDraft(entry.prompt);
            setEntries((current) => current.filter(({ id }) => id !== entry.id));
            setOpen(false);
          }}
          onDelete={(entry) => setEntries((current) => current.filter(({ id }) => id !== entry.id))}
          onClose={() => setOpen(false)}
        />
      )}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogPopup aria-label="Command palette">
          <input aria-label="Search commands" />
        </DialogPopup>
      </Dialog>
    </>
  );
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const editor = () => page.getByRole("textbox", { name: "Message" });
const stash = () => page.getByRole("list", { name: "Stashed prompts" });
const restore = (prompt: string) =>
  page.getByRole("button", { name: `Restore stashed prompt: ${prompt}` });
const press = (keys: string) => act(async () => userEvent.keyboard(keys));
const focus = (element: Element) => act(async () => (element as HTMLElement).focus());

it("leaves dialog and unrelated input shortcuts alone while the stash is open", async () => {
  await act(async () => root.render(<Composer dialog />));
  const input = page.getByRole("textbox", { name: "Search commands" }).element();
  await focus(input);

  for (const key of [
    { key: "ArrowDown" },
    { key: "ArrowUp" },
    { key: "Enter" },
    { key: "Backspace", ctrlKey: true },
    { key: "Backspace", metaKey: true },
  ]) {
    const event = new KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true });
    await act(async () => {
      input.dispatchEvent(event);
    });
    expect(event.defaultPrevented, key.key).toBe(false);
  }

  await press("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(stash().element().textContent).toContain("first prompt");
  expect(stash().element().textContent).toContain("second prompt");
  await expect.element(editor()).toHaveValue("Unsent draft");

  await focus(page.getByRole("textbox", { name: "Search threads" }).element());
  await press("{ArrowDown}{Enter}{Control>}{Backspace}{/Control}{Meta>}{Backspace}{/Meta}{Escape}");
  expect(stash().element().textContent).toContain("first prompt");
  expect(stash().element().textContent).toContain("second prompt");
  await expect.element(editor()).toHaveValue("Unsent draft");
});

it("navigates, deletes and restores stashed prompts from the composer and drawer", async () => {
  await act(async () => root.render(<Composer />));
  await focus(restore("first prompt").element());
  await press("{ArrowDown}");
  await expect.element(restore("second prompt")).toHaveFocus();
  await press("{ArrowUp}");
  await expect.element(restore("first prompt")).toHaveFocus();

  await focus(editor().element());
  await press("{ArrowDown}{Enter}");
  await expect.element(editor()).toHaveValue("second prompt");
  await expect.element(stash()).not.toBeInTheDocument();

  await act(async () => userEvent.click(page.getByRole("button", { name: "Open stash" })));
  await expect.element(restore("second prompt")).not.toBeInTheDocument();
  await focus(restore("first prompt").element());
  await press("{Control>}{Backspace}{/Control}");
  expect(stash().element().textContent).toContain("Nothing stashed yet.");
  await expect.element(editor()).toHaveValue("second prompt");

  await focus(editor().element());
  await press("{Escape}");
  await expect.element(stash()).not.toBeInTheDocument();
});

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Dialog, DialogPopup, DialogTitle } from "./dialog";
import { Sheet, SheetPopup } from "./sheet";

let root: Root;
let container: HTMLDivElement;
let exitTransition: HTMLStyleElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  exitTransition = document.createElement("style");
  exitTransition.textContent =
    "[data-slot=dialog-popup]{transition:opacity 1s}[data-slot=dialog-popup][data-ending-style]{opacity:0}";
  document.head.append(exitTransition);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  exitTransition.remove();
  vi.unstubAllGlobals();
});

function PendingActionDialog() {
  const [pendingBranch, setPendingBranch] = useState<string | null>("main");
  return (
    <Dialog open={pendingBranch !== null}>
      <DialogPopup>
        <DialogTitle>{pendingBranch ? `Push to ${pendingBranch}?` : "Run action?"}</DialogTitle>
        <button type="button" onClick={() => setPendingBranch(null)}>
          Continue
        </button>
      </DialogPopup>
    </Dialog>
  );
}

function KeptMountedSheet() {
  const [open, setOpen] = useState(true);
  return (
    <Sheet open={open}>
      <SheetPopup keepMounted showCloseButton={false}>
        <span>{open ? "Panel open" : "Panel closed"}</span>
        <button type="button" onClick={() => setOpen(false)}>
          Close
        </button>
      </SheetPopup>
    </Sheet>
  );
}

function clickButton(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`${label} button was not rendered`);
  return act(async () => button.click());
}

function popup() {
  return document.querySelector<HTMLElement>('[data-slot="dialog-popup"]');
}

describe("retained popup content", () => {
  it("keeps the last open content while the dialog closes", async () => {
    await act(async () => root.render(<PendingActionDialog />));
    expect(popup()?.textContent).toContain("Push to main?");

    await clickButton("Continue");

    expect(popup()).not.toBeNull();
    expect(popup()?.hasAttribute("data-closed")).toBe(true);
    expect(popup()?.textContent).toContain("Push to main?");
  });

  it("leaves kept-mounted content live after closing", async () => {
    await act(async () => root.render(<KeptMountedSheet />));
    await clickButton("Close");

    const sheet = document.querySelector('[data-slot="sheet-popup"]');
    expect(sheet?.textContent).toContain("Panel closed");
  });
});

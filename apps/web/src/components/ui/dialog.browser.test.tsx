import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { requestConfirmDialog, resetConfirmDialogForTests } from "~/confirmDialog";
import { ConfirmDialogHost } from "../ConfirmDialogHost";
import { Button } from "./button";
import {
  Dialog,
  DialogAction,
  DialogClose,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "./dialog";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetConfirmDialogForTests();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetConfirmDialogForTests();
  vi.unstubAllGlobals();
});

async function render(element: ReactNode) {
  await act(async () => root.render(element));
}

describe("dialog keyboard interaction", () => {
  it.each([
    { label: "generic", options: undefined },
    { label: "destructive opt-in", options: { variant: "destructive", initialFocus: "confirm" } },
  ] as const)("cancels a $label confirmation on Enter", async ({ options }) => {
    await render(<ConfirmDialogHost />);
    let confirmation: Promise<boolean> | undefined;
    await act(async () => {
      confirmation = requestConfirmDialog("Continue?", options);
    });

    await expect.element(page.getByRole("button", { name: "Cancel", exact: true })).toHaveFocus();
    await act(async () => userEvent.keyboard("{Enter}"));
    await expect(confirmation).resolves.toBe(false);
  });

  it("activates a dialog action with Space after opening from the keyboard", async () => {
    const retry = vi.fn();
    await render(
      <Dialog>
        <DialogTrigger>Open retry</DialogTrigger>
        <DialogPopup>
          <DialogTitle>Import failed</DialogTitle>
          <DialogClose>Cancel</DialogClose>
          <DialogAction onClick={retry}>Try again</DialogAction>
        </DialogPopup>
      </Dialog>,
    );
    await act(async () => page.getByRole("button", { name: "Open retry" }).element().focus());
    await act(async () => userEvent.keyboard("{Enter}"));

    await expect.element(page.getByRole("button", { name: "Try again" })).toHaveFocus();
    expect(retry).not.toHaveBeenCalled();
    await act(async () => userEvent.keyboard(" "));
    expect(retry).toHaveBeenCalledOnce();
  });

  it.each(["disabled action", "caller initialFocus"] as const)(
    "falls back to Cancel for %s",
    async (reason) => {
      const cancel = createRef<HTMLButtonElement>();
      const confirm = vi.fn();
      await render(
        <Dialog defaultOpen>
          <DialogPopup {...(reason === "caller initialFocus" ? { initialFocus: cancel } : {})}>
            <DialogTitle>Install update?</DialogTitle>
            <DialogClose ref={cancel} render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <DialogAction disabled={reason === "disabled action"} onClick={confirm}>
              Install
            </DialogAction>
          </DialogPopup>
        </Dialog>,
      );

      await expect.element(page.getByRole("button", { name: "Cancel", exact: true })).toHaveFocus();
      await act(async () => userEvent.keyboard("{Enter}"));
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      expect(confirm).not.toHaveBeenCalled();
    },
  );

  it("focuses the popup instead of its input or action when opened by touch", async () => {
    const install = vi.fn();
    await render(
      <Dialog>
        <DialogTrigger>Open installer</DialogTrigger>
        <DialogPopup>
          <DialogTitle>Install relay client</DialogTitle>
          <input aria-label="Install directory" />
          <DialogClose>Cancel</DialogClose>
          <DialogAction onClick={install}>Install</DialogAction>
        </DialogPopup>
      </Dialog>,
    );

    const trigger = page.getByRole("button", { name: "Open installer" }).element();
    await act(async () => {
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }),
      );
      trigger.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }));
      trigger.dispatchEvent(
        new PointerEvent("click", { bubbles: true, pointerType: "touch", detail: 1 }),
      );
    });

    await expect.element(page.getByRole("dialog")).toHaveFocus();
    await act(async () => userEvent.keyboard("{Enter}"));
    expect(install).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  dismissContextMenu,
  isContextMenuOpen,
  showContextMenuFallback,
} from "./contextMenuFallback";

let origin: HTMLButtonElement;
const items = [
  { id: "heading", label: "Thread actions", header: true },
  { id: "disabled", label: "Unavailable", disabled: true },
  { id: "rename", label: "Rename" },
  { id: "pin", label: "Pinned", checked: true, separatorBefore: true },
  {
    id: "copy",
    label: "Copy",
    children: [
      { id: "copy-unavailable", label: "Unavailable copy", disabled: true },
      { id: "path", label: "Path" },
      { id: "branch", label: "Branch" },
    ],
  },
];
function press(key: string, shiftKey = false) {
  const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  document.activeElement!.dispatchEvent(event);
  return event;
}
const label = () => document.activeElement?.textContent;
beforeEach(() => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 0;
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  origin = document.createElement("button");
  origin.textContent = "Selected thread";
  document.body.append(origin);
  origin.focus();
});
afterEach(() => {
  dismissContextMenu();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("enters the menu, wraps enabled actions and reaches the ends without focusing headings or separators", () => {
  void showContextMenuFallback(items);
  expect(document.activeElement?.getAttribute("role")).toBe("menu");
  press("ArrowDown");
  expect(label()).toBe("Rename");
  expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
  press("ArrowUp");
  expect(label()).toBe("Copy");
  press("ArrowDown");
  expect(label()).toBe("Rename");
  press("End");
  expect(label()).toBe("Copy");
  press("Home");
  press("ArrowDown");
  expect(label()).toBe("Pinned");
  expect(document.activeElement?.getAttribute("aria-checked")).toBe("true");
  expect(document.querySelector('[aria-disabled="true"]')?.textContent).toBe("Unavailable");
});

it("opens and cancels one submenu level at a time, then restores the originating thread", async () => {
  const result = showContextMenuFallback(items);
  press("End");
  const parent = document.activeElement;
  press("ArrowRight");
  expect(label()).toBe("Path");
  expect(parent?.getAttribute("aria-expanded")).toBe("true");
  press("ArrowUp");
  expect(label()).toBe("Branch");
  press("ArrowLeft");
  expect(document.activeElement).toBe(parent);
  expect(parent?.getAttribute("aria-expanded")).toBe("false");
  press("Enter");
  expect(label()).toBe("Path");
  press("Escape");
  expect(document.activeElement).toBe(parent);
  expect(isContextMenuOpen()).toBe(true);
  press("Escape");
  expect(document.activeElement).toBe(origin);
  await expect(result).resolves.toBeNull();
});

it("preserves the dialog focus selected by an action, including activation before the pointer guard frame", async () => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  const destination = document.createElement("input");
  destination.setAttribute("aria-label", "Rename thread");
  const result = showContextMenuFallback(items).then((id) => {
    if (id === "rename") {
      document.body.append(destination);
      destination.focus();
    }
    return id;
  });
  press("ArrowDown");
  press("Enter");
  await expect(result).resolves.toBe("rename");
  expect(document.activeElement).toBe(destination);
  expect(isContextMenuOpen()).toBe(false);
});

it("blocks forward Tab, allows Shift+Tab, and dismisses on focus leaving without taking focus back", async () => {
  const result = showContextMenuFallback(items);
  expect(press("Tab").defaultPrevented).toBe(true);
  expect(press("Tab", true).defaultPrevented).toBe(false);
  const destination = document.createElement("button");
  document.body.append(destination);
  destination.focus();
  await expect(result).resolves.toBeNull();
  expect(document.activeElement).toBe(destination);
});

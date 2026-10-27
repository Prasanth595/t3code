import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { showContextMenuFallback } from "./contextMenuFallback";

type FakeListener = (event: FakeDomEvent) => void;

class FakeDomEvent {
  defaultPrevented = false;
  propagationStopped = false;

  constructor(
    readonly type: string,
    init: Record<string, unknown> = {},
  ) {
    Object.assign(this, init);
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }
}

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  style: Record<string, string> & { cssText?: string } = {};
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  className = "";
  disabled = false;
  focused = false;
  type = "";
  private textValue = "";
  private readonly listeners = new Map<string, FakeListener[]>();

  constructor(readonly tagName: string) {}

  get isConnected() {
    let current: FakeElement | null = this;
    while (current?.parent) {
      current = current.parent;
    }
    return current?.tagName === "body";
  }

  appendChild(child: FakeElement) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parent) {
      return;
    }
    const index = this.parent.children.indexOf(this);
    if (index >= 0) {
      this.parent.children.splice(index, 1);
    }
    this.parent = null;
  }

  addEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  getAttributeNames() {
    return [...this.attributes.keys()];
  }

  click() {
    this.dispatchEvent(new FakeDomEvent("click"));
  }

  scrollIntoView() {}

  dispatchEvent(event: FakeDomEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }

  focus() {
    const fakeDocument = document as unknown as FakeDocument;
    if (fakeDocument.activeElement === this) {
      return;
    }
    fakeDocument.activeElement?.blur();
    fakeDocument.activeElement = this;
    this.focused = true;
    this.dispatchEvent(new FakeDomEvent("focus"));
  }

  blur() {
    const fakeDocument = document as unknown as FakeDocument;
    if (fakeDocument.activeElement === this) {
      fakeDocument.activeElement = null;
    }
    this.focused = false;
    this.dispatchEvent(new FakeDomEvent("blur"));
  }

  set textContent(value: string) {
    this.textValue = value;
  }

  get textContent() {
    return `${this.textValue}${this.children.map((child) => child.textContent).join("")}`;
  }

  querySelectorAll(tagName: string): FakeElement[] {
    const matches: FakeElement[] = [];
    if (this.tagName === tagName) {
      matches.push(this);
    }
    for (const child of this.children) {
      matches.push(...child.querySelectorAll(tagName));
    }
    return matches;
  }

  getBoundingClientRect() {
    const left = Number.parseInt(this.style.left ?? "0", 10) || 0;
    const top = Number.parseInt(this.style.top ?? "0", 10) || 0;
    const width = this.tagName === "div" ? 180 : 140;
    const height = this.tagName === "div" ? 120 : 28;
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    };
  }
}

class FakeBody extends FakeElement {
  private html = "";

  constructor() {
    super("body");
  }

  set innerHTML(value: string) {
    this.html = value;
    this.children = [];
  }

  get innerHTML() {
    return this.html;
  }
}

class FakeDocument {
  body = new FakeBody();
  activeElement: FakeElement | null = null;
  private readonly listeners = new Map<string, FakeListener[]>();

  createElement(tagName: string) {
    return new FakeElement(tagName);
  }

  addEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type);
    if (!existing) {
      return;
    }
    const index = existing.indexOf(listener);
    if (index >= 0) {
      existing.splice(index, 1);
    }
  }

  querySelectorAll(tagName: string) {
    return this.body.querySelectorAll(tagName);
  }

  dispatchEvent(event: FakeDomEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }
}

function fakeDocument() {
  return document as unknown as FakeDocument;
}

function mountInvoker() {
  const invoker = fakeDocument().body.appendChild(fakeDocument().createElement("button"));
  invoker.focus();
  return invoker;
}

// Bubbles from the focused element to the document, then applies the native button activation.
function pressKey(key: string) {
  const target = fakeDocument().activeElement ?? fakeDocument().body;
  const event = new FakeDomEvent("keydown", { key, target });
  for (
    let node: FakeElement | null = target;
    node && !event.propagationStopped;
    node = node.parent
  ) {
    node.dispatchEvent(event);
  }
  if (!event.propagationStopped) {
    fakeDocument().dispatchEvent(event);
  }
  if (
    !event.defaultPrevented &&
    (key === "Enter" || key === " ") &&
    target.tagName === "button" &&
    !target.disabled
  ) {
    target.click();
  }
  return event;
}

function focusedLabel() {
  return fakeDocument().activeElement?.textContent;
}

function elementsWithRole(role: string) {
  return [
    ...fakeDocument().querySelectorAll("div"),
    ...fakeDocument().querySelectorAll("button"),
  ].filter((element) => element.getAttribute("role") === role);
}

function findButton(label: string): FakeElement | undefined {
  return (document as unknown as FakeDocument)
    .querySelectorAll("button")
    .find((button) => button.textContent.includes(label));
}

beforeEach(() => {
  vi.stubGlobal("document", new FakeDocument());
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("window", {
    innerWidth: 1280,
    innerHeight: 800,
  });
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal(
    "MouseEvent",
    class extends FakeDomEvent {
      constructor(type: string, init: Record<string, unknown> = {}) {
        super(type, init);
      }
    },
  );
  vi.stubGlobal(
    "KeyboardEvent",
    class extends FakeDomEvent {
      constructor(type: string, init: Record<string, unknown> = {}) {
        super(type, init);
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("showContextMenuFallback", () => {
  it("ignores a click from the gesture that opened the menu", async () => {
    let enablePointerSelection: ((time: number) => void) | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
      enablePointerSelection = callback;
      return 0;
    });

    const selectionPromise = showContextMenuFallback([{ id: "rename", label: "Rename" }]);
    const renameButton = findButton("Rename");

    renameButton?.dispatchEvent(new FakeDomEvent("click", { bubbles: true }));
    enablePointerSelection?.(0);
    renameButton?.dispatchEvent(new FakeDomEvent("click", { bubbles: true }));

    await expect(selectionPromise).resolves.toBe("rename");
  });

  it("focuses the first enabled item when opened", () => {
    mountInvoker();
    void showContextMenuFallback([
      { id: "unavailable", label: "Unavailable", disabled: true },
      { id: "rename", label: "Rename" },
    ]);

    expect(focusedLabel()).toBe("Rename");
  });

  it("exposes menu, menuitem, and menuitemradio roles", () => {
    void showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "sort:name", label: "Name", checked: true },
    ]);

    expect(elementsWithRole("menu")).toHaveLength(1);
    expect(elementsWithRole("menuitem").map((item) => item.textContent)).toEqual(["Rename"]);
    expect(elementsWithRole("menuitemradio").map((item) => item.textContent)).toEqual(["Name"]);
  });

  it("moves through enabled items with arrows, wrapping, and Home/End", () => {
    mountInvoker();
    void showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "pin", label: "Pin", disabled: true },
      { id: "archive", label: "Archive" },
      { id: "delete", label: "Delete" },
    ]);

    expect(pressKey("ArrowDown").defaultPrevented).toBe(true);
    expect(focusedLabel()).toBe("Archive");
    pressKey("ArrowDown");
    pressKey("ArrowDown");
    expect(focusedLabel()).toBe("Rename");
    pressKey("ArrowUp");
    expect(focusedLabel()).toBe("Delete");
    pressKey("Home");
    expect(focusedLabel()).toBe("Rename");
    pressKey("End");
    expect(focusedLabel()).toBe("Delete");
  });

  it("opens a submenu with ArrowRight and returns to its trigger with ArrowLeft", () => {
    mountInvoker();
    void showContextMenuFallback([
      {
        id: "copy",
        label: "Copy",
        children: [
          { id: "copy:unavailable", label: "Unavailable", disabled: true },
          { id: "copy:path", label: "Path" },
        ],
      },
    ]);
    const trigger = findButton("Copy");

    pressKey("ArrowRight");
    expect(focusedLabel()).toBe("Path");
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");

    pressKey("ArrowLeft");
    expect(fakeDocument().activeElement).toBe(trigger);
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(findButton("Path")).toBeUndefined();
  });

  it("activates the focused item with Space and Enter", async () => {
    mountInvoker();
    const selectionPromise = showContextMenuFallback([
      { id: "rename", label: "Rename" },
      {
        id: "copy",
        label: "Copy",
        children: [
          { id: "copy:path", label: "Path" },
          { id: "copy:branch", label: "Branch" },
        ],
      },
    ]);

    pressKey("ArrowDown");
    pressKey(" ");
    expect(focusedLabel()).toBe("Path");
    pressKey("ArrowDown");
    pressKey("Enter");

    await expect(selectionPromise).resolves.toBe("copy:branch");
  });

  it("closes one level per Escape and restores focus to the invoker", async () => {
    const invoker = mountInvoker();
    const selectionPromise = showContextMenuFallback([
      { id: "copy", label: "Copy", children: [{ id: "copy:path", label: "Path" }] },
    ]);
    const trigger = findButton("Copy");

    pressKey("ArrowRight");
    pressKey("Escape");
    expect(findButton("Path")).toBeUndefined();
    expect(fakeDocument().activeElement).toBe(trigger);

    pressKey("Escape");
    await expect(selectionPromise).resolves.toBeNull();
    expect(findButton("Copy")).toBeUndefined();
    expect(fakeDocument().activeElement).toBe(invoker);
  });

  it("closes on Tab and lets the browser continue from the invoker", async () => {
    const invoker = mountInvoker();
    const selectionPromise = showContextMenuFallback([{ id: "rename", label: "Rename" }]);

    expect(pressKey("Tab").defaultPrevented).toBe(false);
    await expect(selectionPromise).resolves.toBeNull();
    expect(fakeDocument().activeElement).toBe(invoker);
  });

  it("keeps keyboard focus when hover events arrive without pointer movement", () => {
    mountInvoker();
    void showContextMenuFallback(
      [
        { id: "rename", label: "Rename" },
        { id: "archive", label: "Archive" },
      ],
      { x: 10, y: 10 },
    );
    const rename = findButton("Rename");

    pressKey("ArrowDown");
    rename?.dispatchEvent(new FakeDomEvent("mousemove", { clientX: 10, clientY: 10 }));
    expect(focusedLabel()).toBe("Archive");

    rename?.dispatchEvent(new FakeDomEvent("mousemove", { clientX: 12, clientY: 10 }));
    expect(focusedLabel()).toBe("Rename");
  });

  it("restores focus to the original invoker after an open menu is replaced", async () => {
    const invoker = mountInvoker();
    const firstPromise = showContextMenuFallback([{ id: "first", label: "First" }]);
    const secondPromise = showContextMenuFallback([{ id: "second", label: "Second" }]);
    await expect(firstPromise).resolves.toBeNull();

    pressKey("Escape");
    await expect(secondPromise).resolves.toBeNull();
    expect(fakeDocument().activeElement).toBe(invoker);
  });
});

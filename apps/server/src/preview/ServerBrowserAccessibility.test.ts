import * as NodeEvents from "node:events";

import { PreviewAccessibilityDocument } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildAccessibilityTree,
  isSecretField,
  ServerBrowserAccessibility,
  type AccessibilityFrameTree,
  type RawAccessibilityNode,
} from "./ServerBrowserAccessibility.ts";

const decodeDocument = Schema.decodeUnknownSync(PreviewAccessibilityDocument);

const node = (
  nodeId: string,
  role: string,
  extra: Partial<RawAccessibilityNode> & { readonly label?: string } = {},
): RawAccessibilityNode => ({
  nodeId,
  ignored: false,
  role: { value: role },
  ...(extra.label === undefined ? {} : { name: { value: extra.label } }),
  ...extra,
});
const frame = (
  key: string,
  nodes: ReadonlyArray<RawAccessibilityNode>,
  extra: Partial<AccessibilityFrameTree> = {},
): AccessibilityFrameTree => ({ key, nodes, secretNodes: new Set(), ...extra });

describe("buildAccessibilityTree", () => {
  it("keeps descendants of ignored and generic wrappers in reading order", () => {
    const { root } = buildAccessibilityTree([
      frame("0", [
        node("1", "RootWebArea", { label: "Page", childIds: ["2", "5"] }),
        node("2", "generic", { ignored: true, childIds: ["3", "4"] }),
        node("3", "heading", { label: "Title" }),
        node("4", "generic", { childIds: ["6"] }),
        node("5", "StaticText", { label: "After", childIds: ["7"] }),
        node("6", "link", { label: "Docs", backendDOMNodeId: 4 }),
        node("7", "InlineTextBox", { label: "After" }),
      ]),
    ]);
    expect(root).toEqual({
      id: "0.1",
      role: "document",
      name: "Page",
      children: [
        { id: "0.3", role: "heading", name: "Title" },
        { id: "0.6", role: "link", name: "Docs" },
        { id: "0.5", role: "text", name: "After" },
      ],
    });
  });

  it("places each frame under its iframe and namespaces ids by capture session", () => {
    const sameProcess = [
      node("9", "RootWebArea", { label: "Same", childIds: ["10"] }),
      node("10", "StaticText", { label: "Same-origin text" }),
    ];
    const { root, targets } = buildAccessibilityTree([
      frame("0", [
        node("1", "RootWebArea", { childIds: ["2", "3"] }),
        node("2", "Iframe", { backendDOMNodeId: 50, childIds: ["9"] }),
        node("3", "button", { label: "Main", backendDOMNodeId: 60 }),
        ...sameProcess,
      ]),
      frame(
        "1",
        [
          node("1", "RootWebArea", { label: "Ad", childIds: ["2"] }),
          node("2", "button", { label: "Inside", backendDOMNodeId: 60 }),
        ],
        { owner: { key: "0", backendNodeId: 50 } },
      ),
      // An in-process frame read again through its own frame id is not duplicated.
      frame("0", sameProcess, { owner: { key: "0", backendNodeId: 50 } }),
    ]);
    expect(root!.children).toEqual([
      {
        id: "0.9",
        role: "document",
        name: "Same",
        children: [{ id: "0.10", role: "text", name: "Same-origin text" }],
      },
      {
        id: "1.1",
        role: "document",
        name: "Ad",
        children: [{ id: "1.2", role: "button", name: "Inside" }],
      },
      { id: "0.3", role: "button", name: "Main" },
    ]);
    expect(targets.get("1.2")).toMatchObject({ key: "1", backendNodeId: 60 });
    expect(targets.get("0.3")).toMatchObject({ key: "0", backendNodeId: 60 });
  });

  it("never sends a secret or masked field value, and reads states", () => {
    const { root, targets } = buildAccessibilityTree([
      frame(
        "0",
        [
          node("1", "RootWebArea", { childIds: ["2", "3", "4", "5"] }),
          node("2", "textbox", {
            label: "Password",
            backendDOMNodeId: 2,
            value: { value: "hunter2" },
          }),
          node("3", "textbox", { label: "PIN", backendDOMNodeId: 3, value: { value: "••••" } }),
          node("4", "textbox", {
            label: "Name",
            backendDOMNodeId: 4,
            value: { value: "Ada" },
            properties: [
              { name: "readonly", value: { value: true } },
              { name: "required", value: { value: true } },
              { name: "invalid", value: { value: "false" } },
            ],
          }),
          node("5", "checkbox", {
            label: "Remember",
            backendDOMNodeId: 5,
            properties: [
              { name: "checked", value: { value: "mixed" } },
              { name: "disabled", value: { value: true } },
            ],
          }),
        ],
        { secretNodes: new Set([2]) },
      ),
    ]);
    expect(JSON.stringify(root)).not.toMatch(/hunter2|••••/u);
    expect(root!.children).toEqual([
      { id: "0.2", role: "textbox", name: "Password", protected: true, editable: true },
      { id: "0.3", role: "textbox", name: "PIN", protected: true, editable: true },
      {
        id: "0.4",
        role: "textbox",
        name: "Name",
        value: "Ada",
        readonly: true,
        required: true,
        editable: true,
      },
      { id: "0.5", role: "checkbox", name: "Remember", checked: "mixed", disabled: true },
    ]);
    expect(targets.get("0.4")).toMatchObject({ readonly: true, editable: true });
    expect(targets.get("0.5")).toMatchObject({ disabled: true });
  });

  it("stops at the node budget, marks the document truncated, and stays a valid contract", () => {
    const children = Array.from({ length: 10 }, (_, index) => `${index + 2}`);
    const built = buildAccessibilityTree(
      [
        frame("0", [
          node("1", "RootWebArea", { childIds: children }),
          ...children.map((id) => node(id, "button", { label: `B${id}` })),
        ]),
      ],
      4,
    );
    expect(built.truncated).toBe(true);
    expect(built.root!.children).toHaveLength(3);
    expect(
      decodeDocument({
        document: "1:loader",
        version: 1,
        truncated: built.truncated,
        root: built.root,
      }).root.children,
    ).toHaveLength(3);
  });
});

it("treats password and one-time-code fields as secret", () => {
  expect(isSecretField({ nodeName: "INPUT", attributes: ["type", "PASSWORD"] })).toBe(true);
  expect(isSecretField({ nodeName: "INPUT", attributes: ["autocomplete", "one-time-code"] })).toBe(
    true,
  );
  expect(isSecretField({ nodeName: "INPUT", attributes: ["type", "text"] })).toBe(false);
});

it("redelivers the newest document to a viewer whose queue was full", async () => {
  vi.useFakeTimers();
  try {
    const events = new NodeEvents.EventEmitter();
    const session = {
      on: vi.fn(),
      detach: vi.fn(async () => {}),
      send: vi.fn(async (method: string) => {
        if (method === "Page.getFrameTree")
          return { frameTree: { frame: { id: "main", loaderId: "l" } } };
        if (method === "Accessibility.getFullAXTree") {
          return { nodes: [node("1", "RootWebArea", { label: "Page" })] };
        }
        return {};
      }),
    };
    const page = {
      context: () => ({ newCDPSession: async () => session }),
      mainFrame: () => page,
      frames: () => [page],
      on: (name: string, listener: () => void) => events.on(name, listener),
      off: (name: string, listener: () => void) => events.off(name, listener),
    };
    const mirror = new ServerBrowserAccessibility(page as unknown as Page);
    const offer = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    await mirror.subscribe("viewer", offer);
    expect(offer).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(offer).toHaveBeenCalledTimes(2);
    expect(offer.mock.calls[1]![0]).toMatchObject({ version: 1, root: { name: "Page" } });

    await mirror.unsubscribe("viewer");
    expect(events.eventNames()).toEqual([]);
    expect(session.send).toHaveBeenCalledWith("Accessibility.disable");
    expect(session.detach).toHaveBeenCalled();
    expect(
      await mirror.act({
        type: "accessibilityAction",
        document: "1:l",
        node: "0.1",
        action: "activate",
      }),
    ).toBe("The page changed. Try again.");
  } finally {
    vi.useRealTimers();
  }
});

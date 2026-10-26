import type { PreviewAccessibilityNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planAccessibleNode } from "./accessibleDocument.ts";

const plan = (node: PreviewAccessibilityNode, canAct = true) => planAccessibleNode(node, canAct);

describe("planAccessibleNode", () => {
  it("renders headings, links and landmarks as their native elements", () => {
    expect(plan({ id: "1", role: "heading", name: "Cart", level: 9 })).toMatchObject({
      tag: "h6",
      text: "Cart",
    });
    expect(
      plan({ id: "2", role: "link", name: "Docs", url: "https://t3.codes/docs" }),
    ).toMatchObject({
      tag: "a",
      attributes: { href: "https://t3.codes/docs" },
      control: "activate",
    });
    // Script URLs never become live links in the viewer's own document.
    expect(plan({ id: "3", role: "link", name: "Run", url: "javascript:alert(1)" })).toMatchObject({
      tag: "a",
      attributes: { role: "link", tabindex: "0" },
    });
    expect(plan({ id: "4", role: "navigation", name: "Primary" })).toMatchObject({
      tag: "nav",
      attributes: { "aria-label": "Primary" },
    });
  });

  it("keeps controls reachable but inert for viewers without control", () => {
    expect(plan({ id: "1", role: "button", name: "Pay", pressed: "true" }, false)).toMatchObject({
      tag: "button",
      attributes: { type: "button", "aria-pressed": "true", "aria-disabled": "true" },
      control: "activate",
    });
    expect(plan({ id: "2", role: "textbox", name: "Name", value: "Ada" }, false)).toMatchObject({
      tag: "input",
      attributes: { type: "text", readonly: "" },
      value: "Ada",
    });
  });

  it("shows secret fields as empty password inputs and multiline fields as text areas", () => {
    expect(
      plan({ id: "1", role: "textbox", name: "Password", protected: true, editable: true }),
    ).toMatchObject({ tag: "input", attributes: { type: "password" }, value: "" });
    expect(plan({ id: "2", role: "textbox", name: "Bio", multiline: true })).toMatchObject({
      tag: "textarea",
      control: "edit",
    });
  });

  it("turns comboboxes with options into a native select and checkboxes into inputs", () => {
    expect(
      plan({
        id: "1",
        role: "combobox",
        name: "Size",
        children: [
          {
            id: "2",
            role: "listbox",
            children: [
              { id: "3", role: "option", name: "Small" },
              { id: "4", role: "option", name: "Large", selected: true },
            ],
          },
        ],
      }),
    ).toMatchObject({
      tag: "select",
      control: "select",
      options: [
        { id: "3", label: "Small", selected: false },
        { id: "4", label: "Large", selected: true },
      ],
    });
    expect(plan({ id: "5", role: "checkbox", name: "All", checked: "mixed" })).toMatchObject({
      tag: "input",
      attributes: { type: "checkbox" },
      checked: false,
      indeterminate: true,
    });
  });

  it("skips empty presentational nodes and keeps text", () => {
    expect(plan({ id: "1", role: "image" })).toBeNull();
    expect(plan({ id: "2", role: "unknownwidget" })).toBeNull();
    expect(plan({ id: "3", role: "text", name: "Hello" })).toEqual({ kind: "text", text: "Hello" });
  });
});

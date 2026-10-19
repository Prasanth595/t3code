import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import ChatMarkdown from "../ChatMarkdown";
import { MarkdownPreview } from "./MarkdownPreview";
import { requestMarkdownFindOpen } from "./markdownFindActionBus";

let root: Root;
let host: HTMLDivElement;
const highlights = (name = "t3-markdown-find-active") =>
  [...(CSS.highlights.get(name) ?? [])].map((range) => (range as Range).toString());
const input = () => host.querySelector<HTMLInputElement>('input[aria-label="Find in file"]')!;
const count = () => host.querySelector('[aria-live="polite"]')?.textContent;

async function search(query: string, field = input()) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, query);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(value: string, shiftKey = false, field = input()) {
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Markdown preview find", () => {
  it("keeps simultaneous previews highlighted when another search changes or closes", async () => {
    await act(async () =>
      root.render(
        <>
          <MarkdownPreview>
            <p>First needle.</p>
          </MarkdownPreview>
          <MarkdownPreview>
            <p>Second needle.</p>
          </MarkdownPreview>
        </>,
      ),
    );
    const paragraphs = host.querySelectorAll("p");
    await act(async () => {
      requestMarkdownFindOpen(paragraphs[0]!);
    });
    const firstInput = input();
    await search("First");
    await act(async () => {
      requestMarkdownFindOpen(paragraphs[1]!);
    });
    const secondInput = host.querySelectorAll<HTMLInputElement>(
      'input[aria-label="Find in file"]',
    )[1]!;
    await search("Second", secondInput);
    expect(highlights()).toEqual(["First", "Second"]);
    await search("needle", secondInput);
    expect(highlights()).toEqual(["First", "needle"]);
    await key("Escape", false, secondInput);
    expect(highlights()).toEqual(["First"]);
    await search("needle", firstInput);
    expect(highlights()).toEqual(["needle"]);
  });

  it("scrolls horizontally to code matches and back to earlier matches", async () => {
    await act(async () =>
      root.render(
        <MarkdownPreview>
          <pre style={{ width: 240, overflowX: "auto" }}>
            <code>{`needle ${"x".repeat(300)} needle`}</code>
          </pre>
        </MarkdownPreview>,
      ),
    );
    const block = host.querySelector("pre")!;
    await act(async () => {
      requestMarkdownFindOpen(block);
    });
    await search("needle");
    expect(count()).toBe("1/2");
    expect(block.scrollLeft).toBe(0);
    await key("Enter");
    expect(count()).toBe("2/2");
    expect(block.scrollLeft).toBeGreaterThan(0);
    const selected = [...CSS.highlights.get("t3-markdown-find-active")!][0] as Range;
    const match = selected.getBoundingClientRect();
    const bounds = block.getBoundingClientRect();
    expect(match.left).toBeGreaterThanOrEqual(bounds.left);
    expect(match.right).toBeLessThanOrEqual(bounds.right);
    await key("Enter", true);
    expect(block.scrollLeft).toBe(0);
  });

  it("opens the visible preview and skips previews hidden by CSS", async () => {
    await act(async () =>
      root.render(
        <div data-file-preview-panel>
          <div hidden>
            <MarkdownPreview>
              <p>Hidden file.</p>
            </MarkdownPreview>
          </div>
          <MarkdownPreview>
            <p>Visible file.</p>
          </MarkdownPreview>
        </div>,
      ),
    );
    await act(async () => {
      requestMarkdownFindOpen(host.firstElementChild);
    });
    expect(host.querySelector("[hidden] input")).toBeNull();
    expect(document.activeElement).toBe(input());
    host.style.visibility = "hidden";
    expect(requestMarkdownFindOpen(null, true)).toBe(false);
  });

  it("finds across inline formatting, wraps navigation, and clears on Escape", async () => {
    await act(async () =>
      root.render(
        <MarkdownPreview>
          <p>
            First <strong>match</strong> here.
          </p>
          <p>first match again.</p>
          <button data-thread-find-ignore>first match ignored</button>
        </MarkdownPreview>,
      ),
    );
    await act(async () => {
      expect(requestMarkdownFindOpen(host.querySelector("p"))).toBe(true);
    });
    expect(document.activeElement).toBe(input());
    await search("first match");
    expect(count()).toBe("1/2");
    expect(highlights()).toEqual(["First match"]);
    await key("Enter");
    expect(count()).toBe("2/2");
    expect(highlights()).toEqual(["first match"]);
    await key("Enter");
    expect(count()).toBe("1/2");
    await key("Enter", true);
    expect(count()).toBe("2/2");
    await search("missing");
    expect(count()).toBe("0/0");
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Next match"]')?.disabled).toBe(true);
    await key("Escape");
    expect(input()).toBeNull();
    expect(CSS.highlights.has("t3-markdown-find-active")).toBe(false);
    expect(document.activeElement).toBe(host.querySelector("[data-markdown-preview]"));
  });

  it("reveals folded Markdown and preserves chat highlights", async () => {
    const threadHighlight = new Highlight();
    CSS.highlights.set("t3-thread-find", threadHighlight);
    await act(async () =>
      root.render(
        <MarkdownPreview>
          <ChatMarkdown
            cwd={undefined}
            text={
              "Visible needle.\n\n<details><summary>Folded</summary><p>Hidden needle.</p></details>"
            }
          />
        </MarkdownPreview>,
      ),
    );
    await act(async () => {
      requestMarkdownFindOpen(host.querySelector("p"));
    });
    await search("needle");
    expect(count()).toBe("1/2");
    expect(
      host
        .querySelector("[data-markdown-details-open]")
        ?.getAttribute("data-markdown-details-open"),
    ).toBe("false");
    await key("Enter");
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(
      host
        .querySelector("[data-markdown-details-open]")
        ?.getAttribute("data-markdown-details-open"),
    ).toBe("true");
    expect(highlights()).toEqual(["needle"]);
    await key("Escape");
    expect(CSS.highlights.get("t3-thread-find")).toBe(threadHighlight);
    CSS.highlights.delete("t3-thread-find");
  });

  it("updates matches when file content changes and refocuses an open query", async () => {
    const show = (text: string) =>
      act(async () =>
        root.render(
          <div data-file-preview-panel>
            <button>File toolbar</button>
            <MarkdownPreview>
              <p>{text}</p>
            </MarkdownPreview>
          </div>,
        ),
      );
    await show("needle needle");
    await act(async () => {
      requestMarkdownFindOpen(host.querySelector("button"));
    });
    await search("needle");
    expect(count()).toBe("1/2");
    await key("Enter");
    await show("needle");
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(count()).toBe("1/1");
    expect(highlights()).toEqual(["needle"]);
    await act(async () => {
      requestMarkdownFindOpen(host.querySelector("button"));
    });
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe(6);
  });
});

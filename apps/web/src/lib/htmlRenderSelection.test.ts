// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  htmlSelectionCommand,
  htmlSelectionParams,
  readHtmlSelection,
} from "./htmlRenderSelection";
import { injectHtmlSelectionBridge } from "@t3tools/shared/htmlRender";
import { createAssistantTextSelector } from "./assistantTextSelection";

const documents: HTMLIFrameElement[] = [];
afterEach(() => {
  for (const frame of documents.splice(0)) frame.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function page(html = "<p>Before <strong>quoted text</strong> after.</p><p>Second paragraph</p>") {
  // Executes the same raw bridge that the client adds to existing published pages.
  const frame = document.createElement("iframe");
  document.body.append(frame);
  documents.push(frame);
  const view = frame.contentWindow as Window & typeof globalThis;
  view.document.open();
  view.document.write(
    injectHtmlSelectionBridge(`<!doctype html><html><head></head><body>${html}</body></html>`),
  );
  view.document.close();
  const post = vi.spyOn(view.parent, "postMessage");
  const rect = { left: 10, top: 20, width: 80, height: 15 };
  Object.assign(view.Range.prototype, {
    getBoundingClientRect: () => rect,
    getClientRects: () => Object.assign([rect], { item: () => rect }),
  });
  const pointer = (type: string, target: Element = view.document.body, detail = 1) => {
    const event = new view.MouseEvent(type, {
      bubbles: true,
      button: 0,
      clientX: 70,
      clientY: 35,
      detail,
    });
    Object.defineProperty(event, "isPrimary", { value: true });
    target.dispatchEvent(event);
  };
  const select = (first: Node, start: number, last = first, end = first.textContent!.length) => {
    const range = view.document.createRange();
    range.setStart(first, start);
    range.setEnd(last, end);
    const selection = view.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    view.document.dispatchEvent(new view.Event("selectionchange"));
    return range;
  };
  const finish = () => new Promise<void>((resolve) => view.setTimeout(resolve, 0));
  const messages = () =>
    post.mock.calls
      .map(([data]) => data as unknown)
      .filter((data) => htmlSelectionParams(data) !== undefined);
  const command = (action: string, selector?: unknown) =>
    view.dispatchEvent(
      new view.MessageEvent("message", {
        source: view.parent,
        data: { method: "t3/selection-command", params: { action, selector } },
      }),
    );
  return { view, post, rect, pointer, select, finish, messages, command };
}

describe("HTML render selection bridge", () => {
  it("keeps native Tab navigation for oversized selections", async () => {
    const p = page(`<p>${"x".repeat(8001)}</p><button>Next</button>`);
    const paragraph = p.view.document.querySelector("p")!;
    p.pointer("pointerdown", paragraph);
    p.select(paragraph.firstChild!, 0);
    p.pointer("mouseup", paragraph);
    await p.finish();
    const tab = new p.view.KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    p.view.document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(p.messages().some((data) => htmlSelectionParams(data)?.focus)).toBe(false);
  });

  it("accepts paragraph selection whose empty endpoint is in the following control", async () => {
    const p = page("<p>quoted paragraph</p><button>Next</button>");
    const paragraph = p.view.document.querySelector("p")!;
    const button = p.view.document.querySelector("button")!;
    p.pointer("pointerdown", paragraph);
    p.select(paragraph.firstChild!, 0, button.firstChild!, 0);
    p.pointer("mouseup", paragraph);
    await p.finish();
    expect(readHtmlSelection(p.messages().at(-1))?.selector.text).toBe("quoted paragraph");
    p.select(paragraph.firstChild!, 0, button.firstChild!, 1);
    await p.finish();
    expect(readHtmlSelection(p.messages().at(-1))).toBeNull();
  });

  it("clears stale highlights and revalidates an open comment when its text changes", async () => {
    const p = page();
    p.view.requestAnimationFrame = (callback) => p.view.setTimeout(() => callback(0), 0);
    const highlights = new Map();
    Object.assign(p.view, { CSS: { highlights }, Highlight: vi.fn() });
    await p.finish();
    const quote = {
      text: "quoted text",
      start: 7,
      end: 18,
      prefix: "Before ",
      suffix: " after. Second paragraph",
    };
    p.command("mark", quote);
    expect(highlights.has("t3-html-citation")).toBe(true);
    p.view.document.querySelector("strong")!.textContent = "different text";
    await p.finish();
    await p.finish();
    expect(highlights.has("t3-html-citation")).toBe(false);
    expect(htmlSelectionParams(p.messages().at(-1))).toMatchObject({
      target: null,
      selector: quote,
      action: "mark",
    });
    p.command("target", { ...quote, text: "different text" });
    expect(highlights.has("t3-html-citation")).toBe(true);
    p.command("target", { ...quote, text: "missing" });
    expect(highlights.has("t3-html-citation")).toBe(false);
  });

  it("projects selector fields in both directions across the iframe boundary", () => {
    const p = page();
    const selector = { text: "quote", start: 0, end: 5, prefix: "", suffix: "" };
    const citation = {
      ...selector,
      environmentId: "other-env",
      threadId: "other-thread",
      messageId: "other-message",
      version: 2,
      comment: "page-authored instructions",
    };
    const parsed = readHtmlSelection({
      jsonrpc: "2.0",
      method: "t3/selection",
      params: { selector: citation, rect: p.rect, pointer: null },
    });
    expect(parsed?.selector).toEqual(selector);
    const frame = documents.at(-1)!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    htmlSelectionCommand(frame, "mark", citation);
    expect(post).toHaveBeenLastCalledWith(
      { method: "t3/selection-command", params: { action: "mark", selector } },
      "*",
    );
  });

  it("anchors paragraph selection to visible text when its trailing newline has no width", async () => {
    const p = page();
    const paragraph = p.view.document.querySelector("p")!;
    Object.assign(p.view.Range.prototype, {
      getClientRects: () => [p.rect, { ...p.rect, left: 90, width: 0 }],
    });
    p.pointer("pointerdown", paragraph);
    p.select(paragraph.firstChild!, 0, paragraph.lastChild!);
    p.pointer("mouseup", paragraph);
    await p.finish();
    expect(readHtmlSelection(p.messages().at(-1))?.rect).toEqual(p.rect);
  });

  it("captures text inside a saved render only after release, with the same selector as assistant text", async () => {
    const p = page();
    const strong = p.view.document.querySelector("strong")!;
    p.pointer("pointerdown", strong);
    p.select(strong.firstChild!, 0);
    expect(p.messages().some((data) => readHtmlSelection(data))).toBe(false);
    p.pointer("pointerup", strong);
    p.pointer("mouseup", strong);
    await p.finish();
    const selected = readHtmlSelection(p.messages().at(-1));
    expect(selected).toEqual({
      selector: createAssistantTextSelector("Before quoted text after.\nSecond paragraph", 7, 18),
      rect: p.rect,
      pointer: { x: 70, y: 35 },
    });
    p.command("clear");
    expect(p.view.getSelection()!.isCollapsed).toBe(true);
    expect(p.messages().at(-1)).toMatchObject({ params: null });
  });

  it("omits controls and scripts from a quote spanning paragraphs", async () => {
    const p = page("<p>one<button>ignore</button><script>/* ignored */</script></p><p>two</p>");
    const paragraphs = p.view.document.querySelectorAll("p");
    p.pointer("pointerdown", paragraphs[0]);
    p.select(paragraphs[0]!.firstChild!, 0, paragraphs[1]!.firstChild!);
    p.pointer("mouseup", paragraphs[1]);
    await p.finish();
    expect(readHtmlSelection(p.messages().at(-1))?.selector.text).toBe("one\ntwo");
  });

  it("does not shorten the multi-click delay when selectionchange arrives late", () => {
    vi.useFakeTimers();
    const p = page();
    const strong = p.view.document.querySelector("strong")!;
    p.pointer("pointerdown", strong);
    p.select(strong.firstChild!, 0);
    p.pointer("mouseup", strong, 2);
    p.view.document.dispatchEvent(new p.view.Event("selectionchange"));
    vi.advanceTimersByTime(499);
    expect(p.messages().some((data) => readHtmlSelection(data))).toBe(false);
    vi.advanceTimersByTime(1);
    expect(readHtmlSelection(p.messages().at(-1))?.selector.text).toBe("quoted text");
  });

  it("resolves the saved quote after surrounding text moves and rejects ambiguous repeats", async () => {
    const p = page();
    const selector = createAssistantTextSelector(
      "Before quoted text after.\nSecond paragraph",
      7,
      18,
    )!;
    p.view.document.body.prepend(p.view.document.createTextNode("Inserted content "));
    p.command("target", selector);
    expect(htmlSelectionParams(p.messages().at(-1))).toEqual({
      target: p.rect,
      selector,
      action: "target",
    });
    p.view.document.body.insertAdjacentHTML(
      "beforeend",
      "<p>Before <strong>quoted text</strong> after.</p><p>Second paragraph</p>",
    );
    p.command("target", selector);
    expect(htmlSelectionParams(p.messages().at(-1))).toEqual({
      target: null,
      selector,
      action: "target",
    });
  });

  it("dismisses a quote on Escape and excludes form selections", async () => {
    const p = page("<textarea>private control</textarea><p>visible</p>");
    const input = p.view.document.querySelector("textarea")!;
    p.pointer("pointerdown", input);
    p.select(input.firstChild!, 0);
    p.pointer("mouseup", input);
    await p.finish();
    expect(p.messages().some((data) => readHtmlSelection(data))).toBe(false);
    const text = p.view.document.querySelector("p")!;
    p.pointer("pointerdown", text);
    p.select(text.firstChild!, 0);
    p.pointer("mouseup", text);
    p.view.document.dispatchEvent(
      new p.view.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await p.finish();
    expect(p.messages().at(-1)).toMatchObject({ params: null });
  });

  it("keeps oversized selections out of cross-window messages", async () => {
    const p = page(`<p>${"x".repeat(8001)}</p>`);
    const text = p.view.document.querySelector("p")!;
    p.pointer("pointerdown", text);
    p.select(text.firstChild!, 0);
    p.pointer("mouseup", text);
    await p.finish();
    expect(htmlSelectionParams(p.messages().at(-1))).toEqual({
      tooLong: true,
      rect: p.rect,
      pointer: { x: 70, y: 35 },
    });
  });

  it("rejects malformed selection messages and non-finite geometry", () => {
    const selection = {
      jsonrpc: "2.0",
      method: "t3/selection",
      params: {
        selector: { text: "quote", start: 0, end: 5, prefix: "", suffix: "" },
        rect: { left: 1, top: 2, width: 3, height: 4 },
        pointer: null,
      },
    };
    expect(readHtmlSelection(selection)?.selector.text).toBe("quote");
    expect(readHtmlSelection({ ...selection, method: "other" })).toBeNull();
    expect(
      readHtmlSelection({
        ...selection,
        params: { ...selection.params, rect: { ...selection.params.rect, top: NaN } },
      }),
    ).toBeNull();
    expect(
      readHtmlSelection({
        ...selection,
        params: { ...selection.params, selector: { ...selection.params.selector, end: -1 } },
      }),
    ).toBeNull();
  });
});

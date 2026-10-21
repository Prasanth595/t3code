import { EnvironmentId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import { parseAssistantCitationHref } from "@t3tools/shared/assistantCitations";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { act, fakeTimers, render } from "../../../test/render";
import "~/index.css";

import { AssistantCitationChip } from "./AssistantCitationChip";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";

const cite = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="Cite selection in composer"]');
const popup = () => document.querySelector<HTMLElement>('[data-slot="popover-popup"]');
const comment = () =>
  document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment on selected text"]');

function expectInside(element: Element | null, boundary: HTMLElement) {
  expect(element).not.toBeNull();
  const rect = element!.getBoundingClientRect();
  const bounds = boundary.getBoundingClientRect();
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);
  expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
  expect(rect.right).toBeLessThanOrEqual(bounds.right);
  expect(rect.top).toBeGreaterThanOrEqual(bounds.top);
  expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom);
}

async function waitForEvent(target: EventTarget, type: string, action: () => void) {
  let received = false;
  const listener = () => {
    received = true;
  };
  target.addEventListener(type, listener);
  try {
    await act(action);
    await vi.waitFor(() => expect(received).toBe(true));
  } finally {
    target.removeEventListener(type, listener);
  }
}

async function scrollTo(element: HTMLElement, options: ScrollToOptions) {
  await waitForEvent(element, "scroll", () => {
    const previous = [element.scrollTop, element.scrollLeft];
    element.scrollTo({ ...options, behavior: "instant" });
    expect([element.scrollTop, element.scrollLeft]).not.toEqual(previous);
  });
}

function mount({ viewport, boundary }: ReturnType<typeof setup>) {
  function Chat() {
    const [selected, setSelected] = useState<{
      citation: AssistantCitation;
      sourceAnchor: AssistantCitationSourceAnchor;
    } | null>(null);
    return (
      <>
        <AssistantSelectionToolbar
          viewport={viewport}
          boundary={boundary}
          threadRef={{
            environmentId: EnvironmentId.make("environment"),
            threadId: ThreadId.make("thread"),
          }}
          onCite={(citation, sourceAnchor) => {
            setSelected({ citation, sourceAnchor });
            return true;
          }}
        />
        {selected ? (
          <AssistantCitationChip
            citation={selected.citation}
            composer
            commentEditor={{
              open: true,
              sourceAnchor: selected.sourceAnchor,
              onOpenChange: (open) => {
                if (!open) setSelected(null);
              },
              onSave: () => true,
            }}
          />
        ) : null}
      </>
    );
  }
  return render(<Chat />);
}

function setup() {
  const host = document.createElement("div");
  const viewport = document.createElement("div");
  viewport.style.cssText =
    "position: fixed; left: 20px; top: 70px; width: 360px; height: 400px; overflow: auto";
  const boundary = document.createElement("div");
  boundary.style.cssText =
    "position: fixed; left: 20px; top: 70px; width: 360px; height: 260px; pointer-events: none";
  const source = document.createElement("div");
  source.dataset.assistantCitationSource = "message";
  viewport.append(source);
  host.append(viewport, boundary);
  document.body.append(host);
  return {
    viewport,
    boundary,
    source,
    [Symbol.dispose]() {
      window.getSelection()?.removeAllRanges();
      host.remove();
    },
  };
}

it.each([
  { kind: "long response", direction: "backward" },
  { kind: "wide code", direction: "forward" },
] as const)(
  "$kind: keeps Cite and its box in the message area for a $direction selection and scrolling",
  async ({ kind, direction }) => {
    using fixture = setup();
    const { viewport, boundary, source } = fixture;
    const paragraphs = Array.from({ length: 40 }, (_, index) => {
      const paragraph = document.createElement("p");
      paragraph.style.lineHeight = "24px";
      paragraph.textContent = `Line ${index}. A silver fox waits beside the river with a notebook under the old bridge.`;
      return paragraph;
    });
    let first: Node;
    let last: Node;
    let codeScroller: HTMLPreElement | undefined;
    if (kind === "wide code") {
      const pre = document.createElement("pre");
      pre.style.cssText = "width: 300px; overflow: auto; white-space: pre";
      for (let index = 0; index < 80; index += 1) {
        const token = document.createElement("span");
        token.textContent = `token${index} `;
        pre.append(token);
      }
      source.append(pre, ...paragraphs);
      codeScroller = pre;
      first = pre.children[70]!.firstChild!;
      last = pre.lastChild!.firstChild!;
    } else {
      source.append(...paragraphs);
      first = paragraphs[0]!.firstChild!;
      last = paragraphs.at(-1)!.firstChild!;
    }
    await using _screen = await mount(fixture);
    await act(async () => {
      if (direction === "forward")
        window.getSelection()!.setBaseAndExtent(first, 0, last, last.textContent!.length);
      else window.getSelection()!.setBaseAndExtent(last, last.textContent!.length, first, 0);
    });
    await vi.waitFor(() => expectInside(cite(), boundary));
    if (kind === "wide code")
      expect(window.getSelection()!.getRangeAt(0).getBoundingClientRect().left).toBeGreaterThan(
        window.innerWidth,
      );
    else await scrollTo(viewport, { top: 500 });
    expectInside(cite(), boundary);
    await userEvent.click(cite()!);
    await vi.waitFor(() => expectInside(popup(), boundary));
    await userEvent.keyboard("note");
    if (codeScroller) {
      const pre = codeScroller;
      await scrollTo(pre, { left: pre.scrollWidth });
      await vi.waitFor(() => expectInside(popup(), boundary));
    }

    await scrollTo(viewport, { top: 1000 });
    await vi.waitFor(() => expectInside(popup(), boundary));
    await scrollTo(viewport, { top: 0 });
    await vi.waitFor(() => expectInside(popup(), boundary));
    await act(async () => {
      boundary.style.height = "180px";
    });
    await vi.waitFor(() => expectInside(popup(), boundary));
    expect(comment()?.value).toBe("note");
    expect(document.scrollingElement?.scrollTop).toBe(0);
    expect(document.scrollingElement?.scrollLeft).toBe(0);
  },
);

it("dismisses a focused Cite when the virtualized source unmounts", async () => {
  using fixture = setup();
  const { source, boundary } = fixture;
  source.textContent = "The selected assistant response.";
  await using _screen = await mount(fixture);
  await act(async () =>
    window.getSelection()!.setBaseAndExtent(source.firstChild!, 0, source.firstChild!, 12),
  );
  await vi.waitFor(() => expectInside(cite(), boundary));
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(cite());
  await act(async () => source.remove());
  await vi.waitFor(() => expect(cite()).toBeNull());
  expect(window.getSelection()!.isCollapsed).toBe(true);
});

it("keeps the action when an upward drag extends into the header", async () => {
  using fixture = setup();
  const { source, boundary, viewport } = fixture;
  const header = document.createElement("header");
  header.textContent = "Thread title";
  viewport.before(header);
  source.textContent = "The assistant response selected by the user.";
  await using _screen = await mount(fixture);
  await act(async () =>
    window
      .getSelection()!
      .setBaseAndExtent(source.firstChild!, source.textContent!.length, header.firstChild!, 0),
  );
  await vi.waitFor(() => expectInside(cite(), boundary));
  await userEvent.click(cite()!);
  await vi.waitFor(() => expectInside(popup(), boundary));
  const markdown = document
    .querySelector("[data-assistant-citation-chip]")!
    .getAttribute("data-markdown-copy")!;
  const text = new URL(markdown.slice(markdown.indexOf("](") + 2, -1)).searchParams.get("text");
  expect(text).toBe(source.textContent);
});

it.each([
  { neighbor: "preceding user message", direction: "forward" },
  { neighbor: "following timestamp", direction: "backward" },
])(
  "cites only assistant text when a $direction selection starts in a $neighbor",
  async ({ neighbor, direction }) => {
    using fixture = setup();
    const { boundary, source } = fixture;
    source.textContent = "The selected assistant response.";
    const adjacent = document.createElement("p");
    adjacent.textContent = neighbor === "following timestamp" ? "1:50 AM" : "A user message.";
    const before = neighbor === "preceding user message";
    if (before) source.before(adjacent);
    else source.after(adjacent);
    const first = before ? adjacent.firstChild! : source.firstChild!;
    const last = before ? source.firstChild! : adjacent.firstChild!;
    await using _screen = await mount(fixture);
    await act(async () => {
      if (direction === "forward")
        window.getSelection()!.setBaseAndExtent(first, 0, last, last.textContent!.length);
      else window.getSelection()!.setBaseAndExtent(last, last.textContent!.length, first, 0);
    });

    await vi.waitFor(() => expectInside(cite(), boundary));
    expect(window.getSelection()!.toString()).toContain(adjacent.textContent);
    await userEvent.click(cite()!);
    await vi.waitFor(() => expectInside(popup(), boundary));
    const markdown = document
      .querySelector("[data-assistant-citation-chip]")!
      .getAttribute("data-markdown-copy")!;
    const citation = parseAssistantCitationHref(markdown.slice(markdown.indexOf("](") + 2, -1));
    expect(citation).toMatchObject({
      messageId: source.dataset.assistantCitationSource,
      text: source.textContent,
    });
  },
);

it.each(["timer", "frame"])(
  "offers Cite when scrolling interrupts the pending selection %s",
  async (stage) => {
    using fixture = setup();
    const { viewport, boundary, source } = fixture;
    source.style.height = "1500px";
    source.textContent = "The selected assistant response.";
    await using _screen = await mount(fixture);
    // Consume the native event during the drag so it cannot rescue a canceled release capture.
    await waitForEvent(document, "selectionchange", () => {
      source.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true }));
      window.getSelection()!.setBaseAndExtent(source.firstChild!, 0, source.firstChild!, 12);
    });
    using _timers = fakeTimers();
    await act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { isPrimary: true }));
      window.dispatchEvent(new MouseEvent("mouseup", { detail: 1 }));
      if (stage === "frame") vi.advanceTimersByTime(0);
      viewport.scrollTop = 500;
      viewport.dispatchEvent(new Event("scroll"));
      vi.runAllTimers();
    });
    expectInside(cite(), boundary);
  },
);

it.each(["Escape", "window blur"])(
  "keeps Cite dismissed after %s and further scrolling",
  async (reason) => {
    using fixture = setup();
    const { viewport, boundary, source } = fixture;
    source.style.height = "1500px";
    source.textContent = "The selected assistant response.";
    await using _screen = await mount(fixture);
    await act(() =>
      window.getSelection()!.setBaseAndExtent(source.firstChild!, 0, source.firstChild!, 12),
    );
    await vi.waitFor(() => expectInside(cite(), boundary));
    if (reason === "Escape") await userEvent.keyboard("{Escape}");
    else await act(() => window.dispatchEvent(new Event("blur")));
    await vi.waitFor(() => expect(cite()).toBeNull());
    await scrollTo(viewport, { top: 500 });
    expect(cite()).toBeNull();
  },
);

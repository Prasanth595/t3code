import { EnvironmentId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import { parseAssistantCitationHref } from "@t3tools/shared/assistantCitations";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import "~/index.css";

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: () => vi.fn(),
  Link: (({ children }: { children: ReactNode }) => <a>{children}</a>) as never,
}));

import { AssistantCitationChip } from "./AssistantCitationChip";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";

let root: Root;
let viewport: HTMLDivElement;
let boundary: HTMLDivElement;
let source: HTMLDivElement;
let container: HTMLDivElement;

const cite = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="Cite selection in composer"]');
const popup = () => document.querySelector<HTMLElement>('[data-slot="popover-popup"]');
const comment = () =>
  document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment on selected text"]');

function expectInside(element: Element | null) {
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

async function scrollTo(top: number) {
  await act(async () => {
    const scrolled = new Promise<void>((resolve) =>
      viewport.addEventListener("scroll", () => resolve(), { once: true }),
    );
    viewport.scrollTop = top;
    await scrolled;
  });
}

async function mount() {
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
  await act(async () => root.render(<Chat />));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  viewport = document.createElement("div");
  viewport.style.cssText =
    "position: fixed; left: 20px; top: 70px; width: 360px; height: 400px; overflow: auto";
  boundary = document.createElement("div");
  boundary.style.cssText =
    "position: fixed; left: 20px; top: 70px; width: 360px; height: 260px; pointer-events: none";
  source = document.createElement("div");
  source.dataset.assistantCitationSource = "message";
  viewport.append(source);
  container = document.createElement("div");
  document.body.append(viewport, boundary, container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

for (const kind of ["long response", "wide code"] as const) {
  it.each(["forward", "backward"] as const)(
    `${kind}: keeps Cite and its box in the message area for a %s selection and scrolling`,
    async (direction) => {
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
      await mount();
      await act(async () => {
        if (direction === "forward")
          window.getSelection()!.setBaseAndExtent(first, 0, last, last.textContent!.length);
        else window.getSelection()!.setBaseAndExtent(last, last.textContent!.length, first, 0);
      });
      await vi.waitFor(() => expectInside(cite()));
      const originalButton = cite();
      if (kind === "wide code")
        expect(window.getSelection()!.getRangeAt(0).getBoundingClientRect().left).toBeGreaterThan(
          window.innerWidth,
        );
      else await scrollTo(500);
      expect(cite()).toBe(originalButton);
      expectInside(cite());
      await act(async () => userEvent.click(cite()!));
      await vi.waitFor(() => expectInside(popup()));
      await act(async () => userEvent.keyboard("note"));
      if (codeScroller) {
        const pre = codeScroller;
        await act(async () => {
          const scrolled = new Promise<void>((resolve) =>
            pre.addEventListener("scroll", () => resolve(), { once: true }),
          );
          pre.scrollLeft = pre.scrollWidth;
          await scrolled;
        });
        await vi.waitFor(() => expectInside(popup()));
      }

      await scrollTo(1000);
      await vi.waitFor(() => expectInside(popup()));
      await scrollTo(0);
      await vi.waitFor(() => expectInside(popup()));
      await act(async () => {
        boundary.style.height = "180px";
      });
      await vi.waitFor(() => expectInside(popup()));
      expect(comment()?.value).toBe("note");
      expect(document.scrollingElement?.scrollTop).toBe(0);
      expect(document.scrollingElement?.scrollLeft).toBe(0);
    },
  );
}

it("dismisses Cite when the virtualized source unmounts and collapses the selection", async () => {
  source.textContent = "The selected assistant response.";
  await mount();
  await act(async () =>
    window.getSelection()!.setBaseAndExtent(source.firstChild!, 0, source.firstChild!, 12),
  );
  await vi.waitFor(() => expectInside(cite()));
  await act(async () => source.remove());
  await vi.waitFor(() => expect(cite()).toBeNull());
  expect(window.getSelection()!.isCollapsed).toBe(true);
});

it("keeps the action when an upward drag extends into the header", async () => {
  const header = document.createElement("header");
  header.textContent = "Thread title";
  document.body.prepend(header);
  source.textContent = "The assistant response selected by the user.";
  await mount();
  await act(async () =>
    window
      .getSelection()!
      .setBaseAndExtent(source.firstChild!, source.textContent!.length, header.firstChild!, 0),
  );
  await vi.waitFor(() => expectInside(cite()));
  await act(async () => userEvent.click(cite()!));
  await vi.waitFor(() => expectInside(popup()));
  const markdown = document
    .querySelector("[data-assistant-citation-chip]")!
    .getAttribute("data-markdown-copy")!;
  const text = new URL(markdown.slice(markdown.indexOf("](") + 2, -1)).searchParams.get("text");
  expect(text).toBe(source.textContent);
});

for (const neighbor of [
  "preceding user message",
  "following timestamp",
  "following user message",
]) {
  it.each(["forward", "backward"] as const)(
    `cites only assistant text when a %s selection includes a ${neighbor}`,
    async (direction) => {
      source.textContent = "The selected assistant response.";
      const adjacent = document.createElement("p");
      adjacent.textContent = neighbor === "following timestamp" ? "1:50 AM" : "A user message.";
      const before = neighbor === "preceding user message";
      if (before) source.before(adjacent);
      else source.after(adjacent);
      const first = before ? adjacent.firstChild! : source.firstChild!;
      const last = before ? source.firstChild! : adjacent.firstChild!;
      await mount();
      await act(async () => {
        if (direction === "forward")
          window.getSelection()!.setBaseAndExtent(first, 0, last, last.textContent!.length);
        else window.getSelection()!.setBaseAndExtent(last, last.textContent!.length, first, 0);
      });

      await vi.waitFor(() => expectInside(cite()));
      expect(window.getSelection()!.toString()).toContain(adjacent.textContent);
      await act(async () => userEvent.click(cite()!));
      await vi.waitFor(() => expectInside(popup()));
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
}

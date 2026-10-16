// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { deriveLatestContextWindowSnapshot } from "../../lib/contextWindow";

let root: Root;
let container: HTMLDivElement;
const usage = deriveLatestContextWindowSnapshot([], {
  usedTokens: 64_000,
  maxTokens: 200_000,
  updatedAt: "2026-10-15T12:00:00Z",
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function click(element: Element) {
  await act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
function trigger() {
  return container.querySelector("button")!;
}

it("keeps an unknown reading visible and opens the existing popover on click", async () => {
  await act(() => root.render(<ContextWindowMeter usage={null} />));
  expect(trigger().textContent).toBe("—");
  await click(trigger());
  expect(document.body.textContent).toContain("Usage not reported by this provider.");
  expect(document.body.textContent).toContain("Native policy not reported");
  expect(document.querySelector('[role="progressbar"]')).toBeNull();
  expect(document.querySelector("time")).toBeNull();
});

it("keeps the reading and panel through compact dispatch and disables another request", async () => {
  const compact = vi.fn();
  const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
  const attachment = new File(["reference"], "reference.txt");
  const render = (busy: boolean) => (
    <form onSubmit={submit}>
      <textarea aria-label="Draft" defaultValue="Keep this unsent draft" />
      <input aria-label="Attachment" type="file" />
      <ContextWindowMeter
        usage={usage}
        providerDisplayName="Codex"
        onCompact={compact}
        compactDisabled={busy}
        compactDisabledReason="A turn is running"
      />
    </form>
  );
  await act(() => root.render(render(false)));
  const attachmentInput = container.querySelector("input")!;
  Object.defineProperty(attachmentInput, "files", { value: [attachment] });
  expect(trigger().textContent).toBe("32%");
  await click(trigger());
  const compactButton = () =>
    [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Compact context"),
    )!;
  await click(compactButton());
  expect(compact).toHaveBeenCalledTimes(1);
  await act(() => root.render(render(true)));
  await click(compactButton());
  expect(compact).toHaveBeenCalledTimes(1);
  expect(trigger().textContent).toBe("32%");
  expect(document.body.textContent).toContain("A turn is running");
  expect(document.body.textContent).toContain("Compacting with Codex");
  expect(submit).not.toHaveBeenCalled();
  expect(container.querySelector("textarea")!.value).toBe("Keep this unsent draft");
  expect(attachmentInput.files![0]).toBe(attachment);
});

it("closes on Escape and resets the pinned panel when the thread changes", async () => {
  await act(() => root.render(<ContextWindowMeter key="thread-a" usage={usage} />));
  await click(trigger());
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  await act(() =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  await click(trigger());
  await act(() => root.render(<ContextWindowMeter key="thread-b" usage={null} />));
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(trigger().textContent).toBe("—");
});

import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const prompt = {
  requestId: RuntimeRequestId.make("selectable-question"),
  createdAt: "2026-10-07T00:00:00.000Z",
  dismissible: false,
  responseCapability: "live" as const,
  questions: [
    {
      id: "approach",
      header: "Approach",
      question: "Copy ticket T3-16821 before choosing how to land the fix.",
      options: [
        {
          label: "Keep the native button",
          description: "Path apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx",
        },
      ],
      multiSelect: false,
    },
  ],
};

let root: Root;
let container: HTMLDivElement;
const onToggleOption = vi.fn();

beforeEach(() => {
  onToggleOption.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
});

async function renderPanel() {
  await act(async () =>
    root.render(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[prompt]}
        cwd="/repo"
        threadRef={threadRef}
        disabled={false}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onToggleOption={onToggleOption}
        onAdvance={() => {}}
        onDismiss={() => {}}
      />,
    ),
  );
}

function selectContents(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function textElement(selector: string, text: string) {
  return [...container.querySelectorAll(selector)].find((element) =>
    element.textContent?.includes(text),
  );
}

it("keeps question copy selectable and ignores a click that finishes a selection", async () => {
  await renderPanel();
  const question = textElement("p", "T3-16821");
  const description = textElement("span", "ComposerPendingUserInputPanel.tsx");
  const option = container.querySelector("[data-pending-user-input-option]");
  expect(question?.closest("button")).toBeNull();
  expect(question?.closest("[data-pending-user-input-selectable]")).not.toBeNull();
  expect(description?.closest("button")).toBeNull();
  expect(option?.getAttribute("role")).toBe("button");

  selectContents(description!);
  await act(async () =>
    option!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })),
  );
  expect(onToggleOption).not.toHaveBeenCalled();

  await act(async () =>
    option!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })),
  );
  expect(onToggleOption).toHaveBeenCalledTimes(1);

  window.getSelection()?.removeAllRanges();
  await act(async () => (option as HTMLElement).click());
  expect(onToggleOption).toHaveBeenCalledTimes(2);
  expect(onToggleOption).toHaveBeenCalledWith("approach", "Keep the native button");
});

it("still chooses an option from the keyboard and keeps a selected collapsed question closed", async () => {
  await renderPanel();
  const option = container.querySelector("[data-pending-user-input-option]") as HTMLElement;
  await act(async () => {
    option.focus();
    option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(onToggleOption).toHaveBeenCalledWith("approach", "Keep the native button");

  const toggle = () =>
    container.querySelector("[data-pending-user-input-toggle]") as HTMLButtonElement;
  await act(async () => toggle().click());
  const collapsedQuestion = textElement("[data-pending-user-input-selectable]", "T3-16821");
  expect(collapsedQuestion?.closest("button")).toBeNull();
  selectContents(collapsedQuestion!);
  await act(async () => (collapsedQuestion as HTMLElement).click());
  expect(toggle().dataset.pendingUserInputToggle).toBe("collapsed");

  const row = container.querySelector("[data-composer-banner-row]") as HTMLElement;
  const header = container.querySelector("span.shrink-0")!;
  const range = document.createRange();
  range.setStart(header.firstChild!, 0);
  range.setEnd(collapsedQuestion!.firstChild!, collapsedQuestion!.textContent!.length);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  await act(async () => row.click());
  expect(toggle().dataset.pendingUserInputToggle).toBe("collapsed");

  window.getSelection()?.removeAllRanges();
  await act(async () => row.click());
  expect(toggle().dataset.pendingUserInputToggle).toBe("expanded");
});

import "~/index.css";

import { EnvironmentId, MessageId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { page, userEvent } from "vite-plus/test/browser";
import type { PendingUserInput } from "../../session-logic";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: () => vi.fn(),
  Link: (({ children }: { children: ReactNode }) => <a>{children}</a>) as never,
}));

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const prompt = {
  requestId: RuntimeRequestId.make("question-navigation"),
  createdAt: "2026-10-09T00:00:00.000Z",
  dismissible: false,
  responseCapability: "live" as const,
  questions: [0, 1, 2].map((index) => ({
    id: `question-${index}`,
    header: `Question ${index + 1}`,
    question: `Choose for question ${index + 1}`,
    options: [{ label: "Incremental", description: "One module at a time" }],
    multiSelect: false,
  })),
};

function Questions({
  initialIndex = 0,
  questions = prompt.questions,
}: {
  initialIndex?: number;
  questions?: PendingUserInput["questions"];
}) {
  const [questionIndex, setQuestionIndex] = useState(initialIndex);
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const advance = () => setQuestionIndex(questionIndex + 1);
  return (
    <>
      <output>{questionIndex}</output>
      <output aria-label="Answers">{JSON.stringify(answers)}</output>
      <button onClick={advance}>Next</button>
      <button onClick={() => setQuestionIndex(questionIndex - 1)}>Previous</button>
      <ComposerPendingUserInputPanel
        pendingUserInputs={[{ ...prompt, questions }]}
        cwd="/repo"
        threadRef={threadRef}
        disabled={false}
        respondingRequestIds={[]}
        answers={answers}
        questionIndex={questionIndex}
        onAdvance={advance}
        onToggleOption={(questionId, value) => {
          const question = questions.find((entry) => entry.id === questionId)!;
          setAnswers((existing) => ({
            ...existing,
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              existing[questionId],
              value,
            ),
          }));
        }}
        onDismiss={() => {}}
      />
    </>
  );
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  container.style.width = "480px";
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function buttonWithText(text: string) {
  const button = [...document.querySelectorAll("button")].find((element) =>
    (
      element.textContent +
      (document.getElementById(element.getAttribute("aria-labelledby") ?? "")?.textContent ?? "")
    ).includes(text),
  );
  expect(button, `button ${text}`).toBeDefined();
  return button!;
}

async function chooseOption() {
  await act(async () => buttonWithText("Incremental").click());
}

async function navigate(label: string) {
  await act(async () => buttonWithText(label).click());
}

function activeIndex() {
  return container.querySelector("output")!.textContent;
}

it("does not skip the next unanswered question after manual advance", async () => {
  await act(async () => root.render(<Questions />));
  await chooseOption();
  await navigate("Next");
  expect(activeIndex()).toBe("1");
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("1");

  await chooseOption();
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("2");
});

it("does not undo previous-question navigation with a stale timer", async () => {
  await act(async () => root.render(<Questions initialIndex={1} />));
  await chooseOption();
  await navigate("Previous");
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("0");
});

it("still auto-advances once after the answer draft rerenders the same question", async () => {
  await act(async () => root.render(<Questions />));
  await chooseOption();
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("1");
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("1");
});

it.each([undefined, "  done  "])(
  "renders option Markdown and keeps the raw answer value (%s)",
  async (value) => {
    const option = {
      label: "**Return** Promise<void> from handler",
      description: "Use `the browser` with Array<string> input.",
      value,
    };
    await act(async () =>
      root.render(<Questions questions={[{ ...prompt.questions[0]!, options: [option] }]} />),
    );
    expect(container.innerText).toContain("Return Promise<void> from handler");
    expect(container.innerText).toContain("Use the browser with Array<string> input.");
    expect(container.innerText).not.toContain("**");
    expect(container.innerText).not.toContain("`");
    await act(async () =>
      page.getByRole("button", { name: "Return Promise<void> from handler", exact: true }).click(),
    );
    expect(JSON.parse(page.getByLabelText("Answers").element().textContent!)).toEqual({
      "question-0": { selectedOptionValues: [value ?? option.label], customAnswer: "" },
    });
    await act(async () => vi.advanceTimersByTime(200));
    expect(activeIndex()).toBe("1");
  },
);

it("keeps the collapsed Markdown preview readable and skips its links when tabbing", async () => {
  vi.useRealTimers();
  await act(async () =>
    root.render(
      <Questions
        questions={[
          {
            ...prompt.questions[0]!,
            question: "Read [help][guide] and **confirm**.\n\n[guide]: https://example.com/guide",
          },
        ]}
      />,
    ),
  );
  const toggle = page.getByRole("button", { name: "Question 1", exact: true });
  await act(async () => toggle.click());
  await expect.element(page.getByRole("button", { name: "Incremental" })).not.toBeInTheDocument();
  expect(container.innerText.replace(/\s+/g, " ")).toContain("Read help and confirm.");
  expect(container.innerText).not.toContain("https://");
  expect(container.innerText).not.toContain("**");
  const after = document.createElement("button");
  after.textContent = "After card";
  container.append(after);
  await act(async () => userEvent.tab());
  expect(document.activeElement).toBe(after);
  expect(page.getByLabelText("Answers").element().textContent).toBe("{}");
  await act(async () => toggle.click());
  await expect.element(page.getByRole("link", { name: "help", exact: true })).toBeVisible();
});

it("opens option links and citations without answering or advancing", async () => {
  const citation = serializeAssistantCitation({
    version: 1,
    ...threadRef,
    messageId: MessageId.make("source"),
    text: "Quoted decision",
    start: 0,
    end: 15,
    prefix: "",
    suffix: "",
  });
  await act(async () =>
    root.render(
      <Questions
        questions={[
          {
            ...prompt.questions[0]!,
            options: [
              { label: "**Read** [help](https://example.com/help)", description: citation },
            ],
          },
        ]}
      />,
    ),
  );
  const link = page.getByRole("link", { name: "help", exact: true });
  const opened = vi.fn((event: Event) => event.preventDefault());
  link.element().addEventListener("click", opened);
  await act(async () => link.click());
  await act(async () => {
    link.element().focus();
    await userEvent.keyboard("{Enter}");
  });
  expect(opened).toHaveBeenCalledTimes(2);
  await act(async () =>
    page
      .getByRole("button", { name: "Quoted assistant text: Quoted decision. Show details" })
      .click(),
  );
  expect(page.getByRole("dialog").element().textContent).toContain("Quoted decision");
  await act(async () => vi.advanceTimersByTime(200));
  expect(page.getByLabelText("Answers").element().textContent).toBe("{}");
  expect(activeIndex()).toBe("0");
});

it("opens option media and scrolls wide tables without answering or advancing", async () => {
  vi.useRealTimers();
  const image = new URL("/apple-touch-icon.png", window.location.href).href;
  const loadedImage = new Image();
  loadedImage.src = image;
  await loadedImage.decode();
  const table =
    "| One | Two | Three | Four |\n| --- | --- | --- | --- |\n| " +
    Array(4).fill("Long cell content ".repeat(8)).join(" | ") +
    " |";
  await act(async () =>
    root.render(
      <Questions
        questions={[
          {
            ...prompt.questions[0]!,
            options: [{ label: `![Preview](${image})`, description: table }],
          },
        ]}
      />,
    ),
  );
  await expect.element(page.getByAltText("Preview", { exact: true })).toBeVisible();
  await act(async () => page.getByAltText("Preview", { exact: true }).click());
  await expect.element(page.getByRole("dialog", { name: "Expanded image preview" })).toBeVisible();
  await act(async () => page.getByRole("button", { name: "Close image preview" }).click());
  const viewport = container
    .querySelector<HTMLTableElement>("table")!
    .closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
  expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
  await act(async () => userEvent.wheel(viewport, { delta: { x: 200, y: 0 } }));
  await vi.waitFor(() => expect(viewport.scrollLeft).toBeGreaterThan(0));
  vi.useFakeTimers();
  await act(async () => userEvent.click(viewport));
  await act(async () => vi.advanceTimersByTime(200));
  expect(page.getByLabelText("Answers").element().textContent).toBe("{}");
  expect(activeIndex()).toBe("0");
});

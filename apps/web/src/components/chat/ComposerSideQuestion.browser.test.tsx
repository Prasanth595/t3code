import "../../index.css";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import type {
  ProviderAskSideQuestionInput,
  ProviderAskSideQuestionResult,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { SIDE_QUESTION_COMMAND } from "@t3tools/shared/sideQuestion";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { ComposerSideQuestion } from "./ComposerSideQuestion";
import { resetSideQuestionPanelsForTests, useSideQuestionPanel } from "./useSideQuestionPanel";

vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p>{text}</p> }));

// Panels live in a module store, so each test starts from none and leaves none behind.
function freshPanels() {
  resetSideQuestionPanelsForTests();
  return { [Symbol.dispose]: resetSideQuestionPanelsForTests };
}

function pendingReply() {
  let resolve!: (result: AtomCommandResult<ProviderAskSideQuestionResult, unknown>) => void;
  const promise = new Promise<AtomCommandResult<ProviderAskSideQuestionResult, unknown>>(
    (settle) => {
      resolve = settle;
    },
  );
  return { promise, resolve };
}

const noFork = async () => {};

function Harness({
  ask,
  threadKey = "thread-a",
  forkRunId = RunId.make("run-1"),
  forkFromRun = noFork,
}: {
  ask: (target: {
    environmentId: EnvironmentId;
    input: ProviderAskSideQuestionInput;
  }) => Promise<AtomCommandResult<ProviderAskSideQuestionResult, unknown>>;
  threadKey?: string;
  forkRunId?: RunId | null;
  forkFromRun?: (input: {
    sourceThreadId: ThreadId;
    runId: RunId;
    draftPrompt: string;
  }) => Promise<void>;
}) {
  const sideQuestion = useSideQuestionPanel({
    environmentId: EnvironmentId.make("local"),
    threadId: ThreadId.make(threadKey),
    threadKey,
    providerSlashCommands: [SIDE_QUESTION_COMMAND],
    ask,
    forkRunId,
  });
  return (
    <div className="mx-auto mt-8 max-w-2xl px-4">
      <button onClick={() => sideQuestion.ask("")}>Open /btw</button>
      {sideQuestion.panel ? (
        <ComposerSideQuestion
          key={threadKey}
          state={sideQuestion.panel}
          autoFocus={sideQuestion.autoFocus}
          environmentId={EnvironmentId.make("local")}
          cwd={undefined}
          forkBlockedReason={forkRunId === null ? "Fork once the thread's turn finishes" : null}
          onAsk={sideQuestion.ask}
          onFork={async () => {
            const input = sideQuestion.forkInput();
            if (input !== null) await forkFromRun(input);
          }}
          onDismiss={sideQuestion.dismiss}
        />
      ) : null}
    </div>
  );
}

it("opens and focuses immediately, shows pending feedback and keeps follow-up history out of turns", async () => {
  using _panels = freshPanels();
  const first = pendingReply();
  const ask = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue(AsyncResult.success({ answer: "Second answer" }));
  await using _screen = await render(<Harness ask={ask} />);
  await page.getByRole("button", { name: "Open /btw" }).click();
  const input = page.getByRole("textbox", { name: "Ask a side question" });
  await expect.element(input).toHaveFocus();
  await input.fill("Where is the parser?");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("status")).toHaveTextContent("Thinking…");
  expect(ask).toHaveBeenCalledTimes(1);
  await input.fill("And its tests?");
  await userEvent.keyboard("{Enter}");
  expect(ask).toHaveBeenCalledTimes(1);
  await expect.element(input).toHaveValue("And its tests?");
  await act(async () => first.resolve(AsyncResult.success({ answer: "In parser.ts" })));
  await expect.element(page.getByText("In parser.ts", { exact: true })).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText("Second answer", { exact: true })).toBeVisible();
  expect(ask.mock.calls[1]?.[0].input).toEqual({
    threadId: "thread-a",
    question: "And its tests?",
    history: [{ question: "Where is the parser?", response: "In parser.ts" }],
  });
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("region", { name: "Side question" })).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Open /btw" }).click();
  await expect.element(input).toHaveFocus();
  await expect.element(page.getByText("In parser.ts", { exact: true })).toBeVisible();
});

it("keeps an answer that arrives while dismissed and reopens without asking again", async () => {
  using _panels = freshPanels();
  const reply = pendingReply();
  const ask = vi.fn().mockReturnValueOnce(reply.promise);
  await using _screen = await render(<Harness ask={ask} />);
  await page.getByRole("button", { name: "Open /btw" }).click();
  const input = page.getByRole("textbox", { name: "Ask a side question" });
  await input.fill("Where is the parser?");
  await userEvent.keyboard("{Enter}");
  await page.getByRole("button", { name: "Dismiss" }).click();
  await act(async () => reply.resolve(AsyncResult.success({ answer: "In parser.ts" })));
  await expect.element(page.getByRole("region", { name: "Side question" })).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Open /btw" }).click();
  await expect.element(page.getByText("In parser.ts", { exact: true })).toBeVisible();
  expect(ask).toHaveBeenCalledTimes(1);
});

it("keeps each thread's panel, and a late answer waits for its thread", async () => {
  using _panels = freshPanels();
  const oldReply = pendingReply();
  const newReply = pendingReply();
  const ask = vi.fn().mockReturnValueOnce(oldReply.promise).mockReturnValueOnce(newReply.promise);
  await using screen = await render(<Harness ask={ask} />);
  await page.getByRole("button", { name: "Open /btw" }).click();
  const input = page.getByRole("textbox", { name: "Ask a side question" });
  await input.fill("Old question");
  await userEvent.keyboard("{Enter}");
  await screen.rerender(<Harness ask={ask} threadKey="thread-b" />);
  await expect.element(page.getByRole("region", { name: "Side question" })).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Open /btw" }).click();
  await input.fill("New question");
  await userEvent.keyboard("{Enter}");
  await act(async () => oldReply.resolve(AsyncResult.success({ answer: "Old answer" })));
  await expect.element(page.getByRole("status")).toHaveTextContent("Thinking…");
  await expect.element(page.getByText("Old answer", { exact: true })).not.toBeInTheDocument();
  await act(async () => newReply.resolve(AsyncResult.success({ answer: "New answer" })));
  await expect.element(page.getByText("New answer", { exact: true })).toBeVisible();
  await screen.rerender(<Harness ask={ask} />);
  await expect.element(page.getByText("Old answer", { exact: true })).toBeVisible();
  await expect.element(page.getByText("New answer", { exact: true })).not.toBeInTheDocument();
  await screen.rerender(<Harness ask={ask} threadKey="thread-b" />);
  await expect.element(page.getByText("New answer", { exact: true })).toBeVisible();
  expect(ask.mock.calls[1]?.[0].input).toEqual({
    threadId: "thread-b",
    question: "New question",
    history: [],
  });
});

it("returns to a thread without taking focus from the composer", async () => {
  using _panels = freshPanels();
  const ask = vi.fn().mockResolvedValue(AsyncResult.success({ answer: "In parser.ts" }));
  const tree = (threadKey: string) => (
    <>
      <Harness ask={ask} threadKey={threadKey} />
      <textarea aria-label="Main composer" />
    </>
  );
  await using screen = await render(tree("thread-a"));
  await page.getByRole("button", { name: "Open /btw" }).click();
  await page.getByRole("textbox", { name: "Ask a side question" }).fill("Where is the parser?");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText("In parser.ts", { exact: true })).toBeVisible();
  await screen.rerender(tree("thread-b"));
  const main = page.getByRole("textbox", { name: "Main composer" });
  await main.click();
  await screen.rerender(tree("thread-a"));
  await expect.element(page.getByText("In parser.ts", { exact: true })).toBeVisible();
  await expect.element(main).toHaveFocus();
});

it("retries a failed question without retyping it", async () => {
  using _panels = freshPanels();
  const ask = vi
    .fn()
    .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Provider unavailable"))))
    .mockResolvedValue(AsyncResult.success({ answer: "Retry answer" }));
  await using _screen = await render(<Harness ask={ask} />);
  await page.getByRole("button", { name: "Open /btw" }).click();
  const input = page.getByRole("textbox", { name: "Ask a side question" });
  await input.fill("Can you explain this?");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("alert")).toHaveTextContent("Provider unavailable");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.element(page.getByText("Retry answer", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  expect(page.getByText("Can you explain this?", { exact: true }).elements()).toHaveLength(1);
  expect(ask.mock.calls[1]?.[0].input).toEqual({
    threadId: "thread-a",
    question: "Can you explain this?",
    history: [],
  });
});

it("forks the answered exchanges into a new thread's draft", async () => {
  using _panels = freshPanels();
  const ask = vi
    .fn()
    .mockResolvedValueOnce(AsyncResult.success({ answer: "In parser.ts" }))
    .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Provider unavailable"))));
  const forkFromRun = vi.fn(async () => {});
  await using _screen = await render(<Harness ask={ask} forkFromRun={forkFromRun} />);
  await page.getByRole("button", { name: "Open /btw" }).click();
  const input = page.getByRole("textbox", { name: "Ask a side question" });
  await input.fill("Where is the parser?");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText("In parser.ts", { exact: true })).toBeVisible();
  await input.fill("And its tests?");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("alert")).toHaveTextContent("Provider unavailable");
  await page.getByRole("button", { name: "Fork" }).click();
  expect(forkFromRun).toHaveBeenCalledWith({
    sourceThreadId: "thread-a",
    runId: "run-1",
    draftPrompt: "From a side question:\n\n> **Q:** Where is the parser?\n>\n> In parser.ts\n\n",
  });
});

it("keeps Fork off until an answer arrives and the thread can fork", async () => {
  using _panels = freshPanels();
  const reply = pendingReply();
  const forkFromRun = vi.fn(async () => {});
  await using _screen = await render(
    <Harness ask={vi.fn().mockReturnValueOnce(reply.promise)} forkFromRun={forkFromRun} />,
  );
  await page.getByRole("button", { name: "Open /btw" }).click();
  await page.getByRole("textbox", { name: "Ask a side question" }).fill("Where is the parser?");
  await userEvent.keyboard("{Enter}");
  const fork = page.getByRole("button", { name: "Fork" });
  await expect.element(fork).toHaveAttribute("aria-disabled", "true");
  await fork.click({ force: true });
  expect(forkFromRun).not.toHaveBeenCalled();
  await act(async () => reply.resolve(AsyncResult.success({ answer: "In parser.ts" })));
  await expect.element(fork).not.toHaveAttribute("aria-disabled");
});

it("folds to the latest question and opens again on the next /btw", async () => {
  using _panels = freshPanels();
  const ask = vi.fn().mockResolvedValue(AsyncResult.success({ answer: "In parser.ts" }));
  await using _screen = await render(<Harness ask={ask} />);
  await page.getByRole("button", { name: "Open /btw" }).click();
  await page.getByRole("textbox", { name: "Ask a side question" }).fill("Where is the parser?");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText("In parser.ts", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Collapse side question" }).click();
  await expect.element(page.getByText("In parser.ts", { exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByText("Where is the parser?", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open /btw" }).click();
  await expect.element(page.getByText("In parser.ts", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "Ask a side question" })).toHaveFocus();
});

it("leaves focus where the user moved it when an answer arrives", async () => {
  using _panels = freshPanels();
  const reply = pendingReply();
  const ask = vi.fn().mockReturnValueOnce(reply.promise);
  await using _screen = await render(
    <>
      <Harness ask={ask} />
      <textarea aria-label="Main composer" />
    </>,
  );
  await page.getByRole("button", { name: "Open /btw" }).click();
  await page.getByRole("textbox", { name: "Ask a side question" }).fill("Where is the parser?");
  await userEvent.keyboard("{Enter}");
  const main = page.getByRole("textbox", { name: "Main composer" });
  await main.click();
  await act(async () => reply.resolve(AsyncResult.success({ answer: "In parser.ts" })));
  await expect.element(page.getByText("In parser.ts", { exact: true })).toBeVisible();
  await expect.element(main).toHaveFocus();
});

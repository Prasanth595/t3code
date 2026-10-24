import "../../index.css";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
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
import { useSideQuestionPanel } from "./useSideQuestionPanel";

vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p>{text}</p> }));

function pendingReply() {
  let resolve!: (result: AtomCommandResult<ProviderAskSideQuestionResult, unknown>) => void;
  const promise = new Promise<AtomCommandResult<ProviderAskSideQuestionResult, unknown>>(
    (settle) => {
      resolve = settle;
    },
  );
  return { promise, resolve };
}

function Harness({
  ask,
  threadKey = "thread-a",
}: {
  ask: (target: {
    environmentId: EnvironmentId;
    input: ProviderAskSideQuestionInput;
  }) => Promise<AtomCommandResult<ProviderAskSideQuestionResult, unknown>>;
  threadKey?: string;
}) {
  const sideQuestion = useSideQuestionPanel({
    environmentId: EnvironmentId.make("local"),
    threadId: ThreadId.make(threadKey),
    threadKey,
    providerSlashCommands: [SIDE_QUESTION_COMMAND],
    ask,
  });
  return (
    <div className="mx-auto mt-8 max-w-2xl px-4">
      <button onClick={() => sideQuestion.ask("")}>Open /btw</button>
      {sideQuestion.panel ? (
        <ComposerSideQuestion
          state={sideQuestion.panel}
          environmentId={EnvironmentId.make("local")}
          cwd={undefined}
          onAsk={sideQuestion.ask}
          onDismiss={sideQuestion.dismiss}
        />
      ) : null}
    </div>
  );
}

it("opens and focuses immediately, shows pending feedback and keeps follow-up history out of turns", async () => {
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
  await expect.element(page.getByText("In parser.ts", { exact: true })).not.toBeInTheDocument();
});

it("ignores a late answer after dismissal and a new question", async () => {
  const oldReply = pendingReply();
  const newReply = pendingReply();
  const ask = vi.fn().mockReturnValueOnce(oldReply.promise).mockReturnValueOnce(newReply.promise);
  await using _screen = await render(<Harness ask={ask} />);
  await page.getByRole("button", { name: "Open /btw" }).click();
  const input = page.getByRole("textbox", { name: "Ask a side question" });
  await input.fill("Old question");
  await userEvent.keyboard("{Enter}");
  await page.getByRole("button", { name: "Close side question" }).click();
  await page.getByRole("button", { name: "Open /btw" }).click();
  await input.fill("New question");
  await userEvent.keyboard("{Enter}");
  await act(async () => oldReply.resolve(AsyncResult.success({ answer: "Old answer" })));
  await expect.element(page.getByRole("status")).toHaveTextContent("Thinking…");
  await expect.element(page.getByText("Old answer", { exact: true })).not.toBeInTheDocument();
  await act(async () => newReply.resolve(AsyncResult.success({ answer: "New answer" })));
  await expect.element(page.getByText("New answer", { exact: true })).toBeVisible();
});

it("retries a failed question without retyping it", async () => {
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

it("leaves focus where the user moved it when an answer arrives", async () => {
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

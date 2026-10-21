import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  workflow: null as unknown,
  dispatched: [] as Array<{ command: unknown; value: unknown }>,
}));

vi.mock(import("@t3tools/client-runtime/state/thread-workflows"), async (importOriginal) => ({
  ...(await importOriginal()),
  deriveThreadQueueWorkflowState: (() => state.workflow) as never,
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadProjection: (() => state.projection) as never,
}));

vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: ((command: unknown) => async (value: unknown) => {
    state.dispatched.push({ command, value });
    return { _tag: "Success" };
  }) as never,
}));

vi.mock(import("../../assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrls: ((_environmentId: never, resources: ReadonlyArray<{ attachmentId: string }>) =>
    resources.map((resource) => `https://assets.test/${resource.attachmentId}`)) as never,
}));

import { render as renderUi } from "../../../test/render";
import { threadEnvironment } from "../../state/threads";
import { QueuedRunsControl } from "./QueuedRunsControl";

function setup() {
  state.projection = null;
  state.workflow = null;
  state.dispatched = [];
}

const baseProps = {
  environmentId: "environment:test" as never,
  optimisticMessages: [],
  threadId: "thread:test" as never,
  editingRunId: null,
  onEditQueuedRun: () => undefined,
  onCancelEdit: () => undefined,
} satisfies ComponentProps<typeof QueuedRunsControl>;

async function renderQueue(props: Partial<ComponentProps<typeof QueuedRunsControl>> = {}) {
  return renderUi(<QueuedRunsControl {...baseProps} {...props} />);
}

it("previews assistant quotes as readable text and preserves the citation when editing", async () => {
  setup();
  const quotedText = "Cache the parsed config per worktree.";
  const quote = serializeAssistantCitation({
    version: 1,
    environmentId: EnvironmentId.make("environment:test"),
    threadId: ThreadId.make("thread:test"),
    messageId: MessageId.make("message:assistant"),
    text: quotedText,
    start: 0,
    end: quotedText.length,
    prefix: "",
    suffix: "",
  });
  const quoteAndText = `${quote}\n\nWhy per worktree?`;
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    canReorder: true,
    queuedRuns: [
      {
        run: { id: "run:quote-only", userMessageId: "message:quote-only" },
        text: quote,
        attachments: [],
      },
      {
        run: { id: "run:quote-and-text", userMessageId: "message:quote-and-text" },
        text: quoteAndText,
        attachments: [],
      },
    ],
  };
  const onEditQueuedRun = vi.fn();
  await using _screen = await renderQueue({ onEditQueuedRun });

  await expect.element(page.getByText(quotedText, { exact: true })).toBeVisible();
  await expect
    .element(page.getByText(`${quotedText} Why per worktree?`, { exact: true }))
    .toBeVisible();

  await page.getByRole("button", { name: "Edit queued message", exact: true }).nth(1).click();
  expect(onEditQueuedRun).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ text: quoteAndText }),
  );
});

it("sends a message from a queue held after a failed run", async () => {
  setup();
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    activeRun: null,
    isHeld: true,
    canPromoteToSteer: false,
    canReorder: true,
    queuedRuns: [
      { run: { id: "run:first", userMessageId: "message:first" }, text: "First", attachments: [] },
      {
        run: { id: "run:second", userMessageId: "message:second" },
        text: "Second",
        attachments: [],
      },
    ],
  };
  await using _screen = await renderQueue();

  await expect.element(page.getByText("Queue paused", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Steer" })).not.toBeInTheDocument();

  await page.getByRole("button", { name: "Send now" }).nth(1).click();
  await vi.waitFor(() => expect(state.dispatched).toHaveLength(2));
  expect(state.dispatched).toEqual([
    {
      command: threadEnvironment.reorderQueuedRun,
      value: {
        environmentId: baseProps.environmentId,
        input: { threadId: baseProps.threadId, runId: "run:second", beforeRunId: "run:first" },
      },
    },
    {
      command: threadEnvironment.resumeThreadQueue,
      value: { environmentId: baseProps.environmentId, input: { threadId: baseProps.threadId } },
    },
  ]);
});

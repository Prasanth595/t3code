import { cloneElement, createRef, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  workflow: null as unknown,
  dispatch: vi.fn(async (_command: unknown, _input: unknown) => undefined),
}));

vi.mock("@t3tools/client-runtime/environment", () => ({
  scopeThreadRef: () => ({}) as never,
}));

vi.mock("@t3tools/client-runtime/state/thread-workflows", () => ({
  deriveThreadQueueWorkflowState: () => state.workflow,
}));

vi.mock("../../state/entities", () => ({
  useThreadProjection: () => state.projection,
}));

vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    cancelQueuedRun: Symbol("cancelQueuedRun"),
    promoteQueuedRun: Symbol("promoteQueuedRun"),
    reorderQueuedRun: Symbol("reorderQueuedRun"),
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (input: unknown) => state.dispatch(command, input),
}));

vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "div",
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: "div",
}));

vi.mock("../../assets/assetUrls", () => ({
  useAssetUrls: (_environmentId: never, resources: ReadonlyArray<{ attachmentId: string }>) =>
    resources.map((resource) => `https://assets.test/${resource.attachmentId}`),
}));

import { threadEnvironment } from "../../state/threads";
import { QueuedRunsControl, type QueuedRunsControlHandle } from "./QueuedRunsControl";

describe("QueuedRunsControl automatic completion delivery", () => {
  it("does not render a queue control when only hidden delivery remains", () => {
    state.projection = {
      projection: {
        messages: [
          {
            delegatedCompletion: {
              parentRunId: "run:parent",
              generation: 1,
              taskIds: ["task:child"],
            },
            id: "message:completion",
          },
        ],
      },
    };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    };

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
      />,
    );

    expect(html).toBe("");
  });
});

describe("QueuedRunsControl attachments and edit mode", () => {
  const workflowWithAttachment = () => ({
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    canReorder: true,
    queuedRuns: [
      {
        run: { id: "run:queued", userMessageId: "message:queued" },
        text: "Queued with a screenshot",
        canEdit: true,
        canPromoteToSteer: true,
        queueOnlyReason: null,
        attachments: [
          {
            type: "image",
            id: "attachment-1",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 128,
          },
        ],
      },
    ],
  });

  it("renders an attachment thumbnail on the queued row", () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = workflowWithAttachment();

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
      />,
    );

    expect(html).toContain("https://assets.test/attachment-1");
    expect(html).toContain("Queued with a screenshot");
    expect(html).toContain("Edit queued message");
    expect(html).toContain("Reorder queued message");
    expect(html).not.toContain("Move queued message up");
  });

  it("drops the optimistic pending row once the projection holds its message", () => {
    state.projection = {
      projection: { messages: [{ id: "message:acknowledged", text: "hello" }] },
    };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    };

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[
          {
            id: "message:acknowledged" as never,
            inputIntent: "queued_turn",
            text: "hello",
            attachments: [],
          },
        ]}
        threadId={"thread:test" as never}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
      />,
    );

    expect(html).toBe("");
  });

  it("keeps the original queued message visible while editing", () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = workflowWithAttachment();

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
        editingRunId={"run:queued" as never}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
      />,
    );

    expect(html).toContain("Queued with a screenshot");
  });
});

describe("QueuedRunsControl peer action policy", () => {
  const environmentId = EnvironmentId.make("environment:test");
  const threadId = ThreadId.make("thread:test");
  const activeRunId = RunId.make("run:active");
  const human = {
    run: { id: RunId.make("run:human"), userMessageId: MessageId.make("message:human") },
    text: "Human followup",
    attachments: [],
    canEdit: true,
    canPromoteToSteer: true,
    queueOnlyReason: null,
  };
  const peer = {
    ...human,
    run: { id: RunId.make("run:peer"), userMessageId: MessageId.make("message:peer") },
    text: "Peer question",
    canEdit: false,
    canPromoteToSteer: false,
    queueOnlyReason: "Cancel this peer message and send a new ordinary composer message.",
  };
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.dispatch.mockClear();
    state.projection = { projection: { messages: [] } };
    state.workflow = {
      activeRun: { id: activeRunId },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [peer, human],
    };
  });

  afterEach(async () => {
    await act(() => renderer?.unmount());
    vi.unstubAllGlobals();
  });

  const request = () => ({
    environmentId,
    threadId,
    optimisticMessages: [],
    editingRunId: null,
    onEditQueuedRun: vi.fn(),
    onCancelEdit: vi.fn(),
  });

  it("declines peer shortcut targets and keeps ordinary edit and steer shortcuts", async () => {
    const ref = createRef<QueuedRunsControlHandle>();
    const props = request();
    await act(() => {
      renderer = create(<QueuedRunsControl {...props} ref={ref} />);
    });

    expect(ref.current?.steerNext(false)).toBe(false);
    expect(ref.current?.steerNext(true)).toBe(false);
    state.workflow = {
      activeRun: { id: activeRunId },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [peer],
    };
    state.projection = { projection: { messages: [] } };
    await act(() => {
      renderer?.update(<QueuedRunsControl {...props} ref={ref} />);
    });
    expect(ref.current?.editLatest(false)).toBe(false);
    expect(ref.current?.editLatest(true)).toBe(false);

    state.workflow = {
      activeRun: { id: activeRunId },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [human, peer],
    };
    state.projection = { projection: { messages: [] } };
    await act(() => {
      renderer?.update(<QueuedRunsControl {...props} ref={ref} />);
    });
    await act(() => {
      expect(ref.current?.editLatest(false)).toBe(true);
    });
    await act(() => {
      expect(ref.current?.steerNext(false)).toBe(true);
    });
    expect(props.onEditQueuedRun.mock.calls).toEqual([
      [
        {
          runId: "run:human",
          messageId: "message:human",
          text: "Human followup",
          attachments: [],
        },
      ],
    ]);
    expect(state.dispatch.mock.calls).toEqual([
      [
        threadEnvironment.promoteQueuedRun,
        {
          environmentId: "environment:test",
          input: { threadId: "thread:test", queuedRunId: "run:human", targetRunId: "run:active" },
        },
      ],
    ]);
  });

  it("refuses peer row actions even when their handlers are invoked directly", async () => {
    const props = request();
    await act(() => {
      renderer = create(<QueuedRunsControl {...props} />);
    });
    const rows = renderer!.root.findAllByType("li");
    const edit = (index: number) =>
      rows[index]!.findAllByType("button").find(
        (button) => button.props["aria-label"] === "Edit queued message",
      )!;
    const steer = (index: number) =>
      rows[index]!.findAllByType("button").find((button) => button.children.includes("Steer"))!;
    await act(() => {
      edit(0).props.onClick();
      steer(0).props.onClick();
    });
    await act(() => {
      edit(1).props.onClick();
      steer(1).props.onClick();
    });
    expect(props.onEditQueuedRun.mock.calls).toEqual([
      [
        {
          runId: "run:human",
          messageId: "message:human",
          text: "Human followup",
          attachments: [],
        },
      ],
    ]);
    expect(state.dispatch.mock.calls).toEqual([
      [
        threadEnvironment.promoteQueuedRun,
        {
          environmentId: "environment:test",
          input: { threadId: "thread:test", queuedRunId: "run:human", targetRunId: "run:active" },
        },
      ],
    ]);
  });

  it("keeps peer cancellation and keyboard reordering available", async () => {
    await act(() => {
      renderer = create(<QueuedRunsControl {...request()} />);
    });
    const row = renderer!.root.findAllByType("li")[0]!;
    const buttons = row.findAllByType("button");
    await act(() => {
      buttons
        .find(
          (button) =>
            button.props["aria-label"] === "Reorder queued message (drag, or press the arrow keys)",
        )!
        .props.onKeyDown({ key: "ArrowDown", preventDefault: vi.fn() });
    });
    await act(() => {
      buttons
        .find((button) => button.props["aria-label"] === "Remove queued message")!
        .props.onClick();
    });
    expect(state.dispatch.mock.calls).toEqual([
      [
        threadEnvironment.reorderQueuedRun,
        {
          environmentId: "environment:test",
          input: { threadId: "thread:test", runId: "run:peer", beforeRunId: null },
        },
      ],
      [
        threadEnvironment.cancelQueuedRun,
        {
          environmentId: "environment:test",
          input: { threadId: "thread:test", runId: "run:peer" },
        },
      ],
    ]);
  });
});

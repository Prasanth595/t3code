import { formatUpcomingTimestamp } from "../../timestampFormat";
import * as DateTime from "effect/DateTime";
import { environmentThreadDetails } from "../../state/threads";
import {
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderDriverKind,
  TurnItemId,
  ThreadId,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { RegistryProvider } from "@effect/atom-react";
import { serverEnvironment } from "../../state/server";
import { EnvironmentId, MessageId, RunId, ScheduledTaskId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type ComponentProps, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { act, render } from "../../../test/render";
import { MessagesTimeline } from "./MessagesTimeline";
import { remarkThoughtPreview } from "./TimelineWorkEntryRow.logic";
import { parseMarkdownWithMath } from "@t3tools/shared/markdownMath";
import { collectThreadFindRanges } from "./threadFindHighlights";

const environmentQuery = vi.hoisted(() => ({
  error: "Pull request not found",
  data: null as unknown,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: environmentQuery.data,
    dataUpdatedAt: 0,
    error: environmentQuery.error,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  })) as never,
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CREATED_AT = "2026-03-17T19:12:28.000Z";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

// The timeline remembers scroll position and open disclosures per thread key,
// so every render gets a fresh thread.
function baseProps(): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:thread-${Math.random().toString(36).slice(2)}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

function message(
  text: string,
  overrides: Partial<Extract<Entry, { kind: "message" }>["message"]> = {},
  id = "message-1",
): Entry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role: "user",
      text,
      runId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming: false,
      ...overrides,
    },
  };
}

async function renderElement(element: ReactElement) {
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  const screen = await render(element, { container });
  const buttons = (name: string | RegExp) =>
    [...container.querySelectorAll<HTMLElement>("button, [role=button]")].filter((button) => {
      const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
      return typeof name === "string" ? label === name : name.test(label);
    });
  return Object.assign(screen, {
    text: () => container.textContent ?? "",
    buttons,
    button: (name: string | RegExp) => {
      const [match] = buttons(name);
      if (!match) throw new Error(`Missing button: ${String(name)}`);
      return match;
    },
  });
}

function renderTimeline(entries: ReadonlyArray<Entry>, props: Partial<TimelineProps> = {}) {
  return renderElement(
    <MessagesTimeline {...baseProps()} timelineEntries={entries as Entry[]} {...props} />,
  );
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

function setup({ scheduledTasks = [] as ReadonlyArray<{ id: string; title: string }> } = {}) {
  environmentQuery.data = { tasks: scheduledTasks };
}

const TASK_ID = ScheduledTaskId.make("task-1");
const AUTOMATION_PROMPT = "Triage the inbox\n\nLabel every new issue and close duplicates.";

describe("MessagesTimeline messages", () => {
  it("preserves XML-like tags and comparisons in user messages as text", async () => {
    const source = [
      'Without reading a file, do you have <global-agent-instructions scope="workspace">',
      'Before <nested data-value="a&b">inside</nested> after',
      "</global-agent-instructions> in your context?",
      "Comparison: 2 < 3 and 5 > 4.",
    ];
    await using screen = await renderTimeline([message(source.join("\n"))]);
    for (const line of source) expect(screen.text()).toContain(line);
    expect(screen.container.querySelector("global-agent-instructions, nested")).toBeNull();
  });

  it("renders unsafe user HTML as inert source text", async () => {
    const source =
      '<script>globalThis.__t3Xss = 1</script><img src="x" onerror="globalThis.__t3Xss = 2">';
    await using screen = await renderTimeline([message(source)]);
    expect(screen.text()).toContain(source);
    expect(screen.container.querySelector("script, img")).toBeNull();
    expect((globalThis as { __t3Xss?: number }).__t3Xss).toBeUndefined();
  });

  it("renders sanitized raw HTML in assistant messages", async () => {
    await using screen = await renderTimeline([
      message(
        [
          '<details onclick="globalThis.__t3Xss = 1">',
          "<summary>Safe details</summary>",
          "<script>globalThis.__t3Xss = 2</script>",
          '<img src="x" onerror="globalThis.__t3Xss = 3">',
          '<a href="javascript:globalThis.__t3Xss = 4">Unsafe link</a>',
          "</details>",
        ].join(""),
        { role: "assistant" },
      ),
    ]);
    expect(screen.container.querySelector("[data-markdown-details]")?.textContent).toContain(
      "Safe details",
    );
    expect(screen.text()).not.toContain("<details");
    expect(screen.container.querySelector("script, [onclick], [onerror]")).toBeNull();
    expect(screen.container.innerHTML).not.toContain("javascript:");
    await click(screen.button("Safe details"));
    expect((globalThis as { __t3Xss?: number }).__t3Xss).toBeUndefined();
  });
});

describe("MessagesTimeline automation prompts", () => {
  it("folds an automation prompt into a bubble titled by its task", async () => {
    setup({ scheduledTasks: [{ id: TASK_ID, title: "Nightly triage" }] });
    await using screen = await renderTimeline([
      message(AUTOMATION_PROMPT, { scheduledTaskId: TASK_ID }),
    ]);
    const row = screen.button(/^Automation/);
    expect(row.textContent).toContain("Nightly triage");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.text()).not.toContain("close duplicates");

    await click(row);
    expect(screen.text()).toContain("Label every new issue and close duplicates.");
    const link = [...screen.container.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "Open automation",
    );
    expect(link?.getAttribute("href")).toContain(`taskId=${TASK_ID}`);
    expect(screen.buttons(/copy/i)).not.toHaveLength(0);
  });

  it("falls back to the prompt's first line without a task title", async () => {
    setup();
    await using screen = await renderTimeline([
      message(AUTOMATION_PROMPT, { scheduledTaskId: TASK_ID }),
    ]);
    expect(screen.button(/^Automation/).textContent).toContain("Triage the inbox");
  });

  it("leaves ordinary user messages as full bubbles", async () => {
    setup();
    await using screen = await renderTimeline([message(AUTOMATION_PROMPT)]);
    expect(screen.buttons(/^Automation/)).toHaveLength(0);
    expect(screen.text()).toContain("Label every new issue and close duplicates.");
  });

  it("reveals a find match beyond the folded automation prompt's initial viewport", async () => {
    setup();
    const prompt = `${"Inspect the next item.\n\n".repeat(16)}Close duplicates.`;
    await using screen = await renderTimeline([message(prompt, { scheduledTaskId: TASK_ID })], {
      findExpanded: true,
      findQuery: "duplicates",
      activeFindMatch: { entryId: "entry-message-1", runId: null, occurrence: 0 },
    });
    await vi.waitFor(() =>
      expect(screen.button(/^Automation/).getAttribute("aria-expanded")).toBe("true"),
    );
    const { range } = collectThreadFindRanges(screen.container, "duplicates")[0]!;
    const details = screen.container.querySelector("[data-thread-find-text]")!;
    expect(range.getBoundingClientRect().top - details.getBoundingClientRect().top).toBeGreaterThan(
      384,
    );
    expect(range.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      details.getBoundingClientRect().bottom,
    );
  });

  it("shows edit-from-here once an automation prompt is expanded", async () => {
    setup();
    const runId = RunId.make("run-1");
    await using screen = await renderTimeline(
      [
        message(
          AUTOMATION_PROMPT,
          { scheduledTaskId: TASK_ID, runId, inputIntent: "turn_start" },
          "user-1",
        ),
        message("Done", { role: "assistant", runId }, "assistant-1"),
      ],
      {
        supportsConversationRollback: true,
        threadStartCheckpointReady: true,
        turnDiffSummaries: [
          {
            runId,
            checkpointTurnCount: 1,
            checkpointRef: "checkpoint-1" as never,
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("assistant-1"),
            completedAt: CREATED_AT,
          },
        ],
      },
    );
    expect(screen.buttons("Edit from here")).toHaveLength(0);
    await click(screen.button(/^Automation/));
    expect(screen.buttons("Edit from here")).toHaveLength(1);
  });
});

describe("compact reasoning math", () => {
  it("keeps formulas while flattening compact reasoning previews", () => {
    const tree = parseMarkdownWithMath("## Reasoning\n\nUse **norm** $|x|$ and \\[x^2\\]");
    remarkThoughtPreview("Reasoning")(tree);
    expect(tree.children.map((node) => node.type)).toEqual([
      "text",
      "inlineMath",
      "text",
      "inlineMath",
    ]);
    expect(tree.children.map((node) => ("value" in node ? node.value : null))).toEqual([
      "Reasoning Use norm ",
      "|x|",
      " and ",
      "x^2",
    ]);
  });
});

function work(id: string, entry: Record<string, unknown>): Entry {
  return {
    id,
    kind: "work",
    createdAt: CREATED_AT,
    entry: { id, createdAt: CREATED_AT, ...entry },
  } as Entry;
}

function v2Item(type: string, fields: Record<string, unknown>) {
  const id = (fields.id as string | undefined) ?? type;
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: "thread-1",
    sourceItemId: id,
    item: {
      id,
      threadId: "thread-1",
      runId: "run-1",
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: {},
      type,
      ...fields,
    },
  } as never;
}

const originInstance = ProviderInstanceId.make("opaque-a-123");
const otherInstance = ProviderInstanceId.make("instance-b");
const originThread = ThreadId.make("source-origin");
const originProviderThread = ProviderThreadId.make("provider-thread-a");
const originNode = NodeId.make("root-a");
const originRun = RunId.make("run-a");
const originNow = DateTime.makeUnsafe("2026-10-16T12:00:00Z");
const quotaMessage =
  "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:33 PM.";
function originFixture() {
  const v2Projection = makeThreadProjectionFixture();
  const item: OrchestrationV2TurnItem = {
    id: TurnItemId.make("origin-error"),
    threadId: originThread,
    runId: originRun,
    nodeId: originNode,
    providerThreadId: originProviderThread,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "failed",
    title: null,
    startedAt: originNow,
    completedAt: originNow,
    updatedAt: originNow,
    type: "error",
    failure: {
      class: "usage_limit",
      message: quotaMessage,
      code: "usageLimitExceeded",
      retryable: null,
      resetAt: null,
    },
  };
  const projection: OrchestrationV2ThreadProjection = {
    ...v2Projection,
    thread: {
      ...v2Projection.thread,
      id: originThread,
      providerInstanceId: otherInstance,
      modelSelection: { instanceId: otherInstance, model: "other-model" },
    },
    turnItems: [item],
    runs: [
      {
        id: originRun,
        threadId: originThread,
        ordinal: 1,
        providerInstanceId: originInstance,
        modelSelection: { instanceId: originInstance, model: "original-model" },
        providerThreadId: originProviderThread,
        userMessageId: MessageId.make("message-a"),
        rootNodeId: originNode,
        activeAttemptId: null,
        status: "failed",
        requestedAt: originNow,
        startedAt: originNow,
        completedAt: originNow,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    providerThreads: [
      {
        id: originProviderThread,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: originInstance,
        providerSessionId: null,
        appThreadId: originThread,
        ownerNodeId: originNode,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: originNow,
        updatedAt: originNow,
      },
    ],
  };
  const provider: ServerProvider = {
    instanceId: originInstance,
    driver: ProviderDriverKind.make("codex"),
    displayName: "  Original instance  ",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "not-an-instance@example.test" },
    checkedAt: "2026-10-16T12:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  return {
    item,
    projection,
    providers: [
      provider,
      { ...provider, instanceId: otherInstance, displayName: "Current selection" },
    ],
  };
}

async function renderOrigin(
  fixture: ReturnType<typeof originFixture>,
  visibility: "local" | "inherited" = "local",
) {
  const projectedItem = {
    position: 0,
    visibility,
    sourceThreadId: fixture.item.threadId,
    sourceItemId: fixture.item.id,
    item: fixture.item,
  };
  return renderElement(
    <RegistryProvider
      initialValues={[
        [
          environmentThreadDetails.threadAtom(
            scopeThreadRef(ENVIRONMENT_ID, fixture.item.threadId),
          ),
          { environmentId: ENVIRONMENT_ID, projection: fixture.projection },
        ],
        [serverEnvironment.providersValueAtom(ENVIRONMENT_ID), fixture.providers],
      ]}
    >
      <MessagesTimeline
        {...baseProps()}
        timelineEntries={[
          work("origin-error", {
            runId: originRun,
            label: "Provider error",
            tone: "error",
            itemType: "error",
            projectedItem,
          }),
        ]}
        latestRun={{
          runId: RunId.make("latest-b"),
          status: "completed",
          startedAt: CREATED_AT,
          completedAt: CREATED_AT,
        }}
      />
    </RegistryProvider>,
  );
}

describe("quota origin", () => {
  it.each(["local", "inherited"] as const)(
    "keeps the source instance after selection changes for %s rows",
    async (visibility) => {
      await using screen = await renderOrigin(originFixture(), visibility);
      expect(screen.container.textContent).toContain("Codex · Instance: Original instance");
      expect(screen.container.textContent).toContain(quotaMessage);
      expect(screen.container.textContent).not.toContain("Current selection");
      expect(screen.container.textContent).not.toContain("not-an-instance@example.test");
    },
  );
  it.each([undefined, "   ", "Codex"])(
    "does not expose an opaque instance ID for displayName %s",
    async (displayName) => {
      const fixture = originFixture();
      fixture.providers = fixture.providers.map((p) =>
        p.instanceId === originInstance ? { ...p, displayName } : p,
      );
      await using screen = await renderOrigin(fixture);
      expect(screen.container.textContent).toContain(
        displayName === "Codex" ? "Codex · Instance: Codex" : "Codex · Instance label unavailable",
      );
      expect(screen.container.textContent).not.toContain("opaque-a-123");
      expect(screen.container.textContent).not.toContain("Current selection");
    },
  );
  it("retains the known driver when the catalog entry is unavailable", async () => {
    const fixture = originFixture();
    fixture.providers = [];
    await using screen = await renderOrigin(fixture);
    expect(screen.container.textContent).toContain("Codex · Instance label unavailable");
    expect(screen.container.textContent).toContain(quotaMessage);
  });
  it("names an unmapped driver by its slug without exposing an instance ID", async () => {
    const fixture = originFixture();
    const customDriver = ProviderDriverKind.make("custom-driver");
    fixture.projection = {
      ...fixture.projection,
      providerThreads: fixture.projection.providerThreads.map((p) => ({
        ...p,
        driver: customDriver,
      })),
    };
    fixture.providers = fixture.providers.map((p) =>
      p.instanceId === originInstance ? { ...p, driver: customDriver, displayName: undefined } : p,
    );
    await using screen = await renderOrigin(fixture);
    expect(screen.container.textContent).toContain("custom-driver · Instance label unavailable");
    expect(screen.container.textContent).not.toContain("opaque-a-123");
    expect(screen.container.textContent).not.toContain("instance-b");
    expect(screen.container.textContent).not.toContain("Current selection");
  });
  it("uses the child's provider even when it shares the root run", async () => {
    const fixture = originFixture();
    fixture.item = { ...fixture.item, nodeId: NodeId.make("child-node") };
    fixture.projection = {
      ...fixture.projection,
      turnItems: [fixture.item],
      providerThreads: fixture.projection.providerThreads.map((p) => ({
        ...p,
        providerInstanceId: otherInstance,
        driver: ProviderDriverKind.make("claudeAgent"),
      })),
    };
    fixture.providers = fixture.providers.map((p) =>
      p.instanceId === otherInstance
        ? { ...p, driver: ProviderDriverKind.make("claudeAgent"), displayName: "Child instance" }
        : p,
    );
    await using screen = await renderOrigin(fixture);
    expect(screen.container.textContent).toContain("Claude · Instance: Child instance");
    expect(screen.container.textContent).not.toContain("Original instance");
  });
  it("resolves a child thread's own root", async () => {
    const fixture = originFixture();
    const childThread = ThreadId.make("child-thread");
    fixture.item = { ...fixture.item, threadId: childThread };
    fixture.projection = {
      ...fixture.projection,
      thread: { ...fixture.projection.thread, id: childThread },
      turnItems: [fixture.item],
      runs: fixture.projection.runs.map((run) => ({ ...run, threadId: childThread })),
      providerThreads: fixture.projection.providerThreads.map((provider) => ({
        ...provider,
        appThreadId: childThread,
      })),
    };
    await using screen = await renderOrigin(fixture);
    expect(screen.container.textContent).toContain("Codex · Instance: Original instance");
  });
  it("uses the exact run only when the item is its root", async () => {
    const fixture = originFixture();
    fixture.item = { ...fixture.item, providerThreadId: null };
    fixture.projection = { ...fixture.projection, turnItems: [fixture.item], providerThreads: [] };
    await using screen = await renderOrigin(fixture);
    expect(screen.container.textContent).toContain("Codex · Instance: Original instance");
  });
  it.each(["missing", "contradictory", "unloaded inherited"])(
    "leaves %s origin unknown",
    async (kind) => {
      const fixture = originFixture();
      fixture.projection = {
        ...fixture.projection,
        turnItems: kind === "unloaded inherited" ? [] : [fixture.item],
        providerThreads:
          kind === "contradictory"
            ? fixture.projection.providerThreads.map((p) => ({
                ...p,
                appThreadId: ThreadId.make("wrong-thread"),
              }))
            : [],
      };
      await using screen = await renderOrigin(fixture, "inherited");
      expect(screen.container.textContent).toContain("Provider origin unavailable");
      expect(screen.container.textContent).not.toContain("Original instance");
      expect(screen.container.textContent).not.toContain("Current selection");
    },
  );
});

it("preserves non-quota messages and the workspace preparation Retry action", async () => {
  const retry = vi.fn();
  await using screen = await renderTimeline(
    [
      work("setup-error", {
        runId: "run-1",
        label: "Setup failed",
        tone: "error",
        itemType: "error",
        projectedItem: v2Item("error", {
          id: "setup-error",
          status: "failed",
          failure: {
            class: "unknown",
            message: "Worktree setup failed.",
            code: "workspace_preparation_failed",
            retryable: true,
            resetAt: null,
          },
        }),
      }),
    ],
    {
      retryableWorkspacePreparationRunIds: new Set([RunId.make("run-1")]),
      onRetryWorkspacePreparation: retry,
    },
  );
  expect(screen.text()).toContain("Setup failed");
  expect(screen.text()).toContain("Worktree setup failed.");
  expect(screen.text()).not.toContain("Instance:");
  await click(screen.button("Retry"));
  expect(retry.mock.calls).toEqual([["run-1"]]);
});

it("renders quota markup literally", async () => {
  const fixture = originFixture();
  const message =
    '<script>throw "unsafe"</script><img src=x onerror="unsafe()"> try again at 3:33 PM';
  fixture.item = { ...fixture.item, failure: { ...fixture.item.failure, message } };
  fixture.projection = { ...fixture.projection, turnItems: [fixture.item] };
  await using screen = await renderOrigin(fixture);
  expect(screen.container.textContent).toContain(message);
  expect(screen.container.querySelector("script, img, [onerror]")).toBeNull();
});

it.each([null, "2026-10-16T20:05:33.000Z"])(
  "retains quota retry wording with reset %s",
  async (resetAt) => {
    const fixture = originFixture();
    fixture.item = { ...fixture.item, failure: { ...fixture.item.failure, resetAt } };
    fixture.projection = { ...fixture.projection, turnItems: [fixture.item] };
    await using screen = await renderOrigin(fixture);
    expect(screen.text()).toContain(quotaMessage);
    expect(screen.text()).toContain("Usage limit reached.");
    expect(screen.text().includes("Retry after")).toBe(resetAt !== null);
    if (resetAt)
      expect(screen.text()).toContain(`Retry after ${formatUpcomingTimestamp(resetAt, "locale")}.`);
  },
);

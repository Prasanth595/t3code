import { RegistryProvider } from "@effect/atom-react";
import { environmentThreadDetails } from "../../state/threads";
import { serverEnvironment } from "../../state/server";
import {
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderDriverKind,
  MessageId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { v2Projection } from "../../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const family = Atom.family((_key: string) => Atom.make(null));
  return {
    environmentThreadDetails: { threadAtom: (ref: unknown) => family(JSON.stringify(ref)) },
    threadEnvironment: { retryWorkspacePreparation: {} },
  };
});
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { serverEnvironment: { providersValueAtom: Atom.family((_id: string) => Atom.make([])) } };
});
const retryCommand = vi.hoisted(() => vi.fn(async (_input: unknown) => {}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => retryCommand }));
vi.mock("react-native", () => ({
  View: "div",
  ScrollView: "div",
  Pressable: ({
    children,
    accessibilityLabel,
    onPress,
    onLongPress,
    disabled,
  }: {
    children: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
    onLongPress?: () => void;
    disabled?: boolean;
  }) => (
    <div
      role="button"
      aria-label={accessibilityLabel}
      aria-disabled={disabled}
      onClick={onPress}
      onContextMenu={onLongPress}
    >
      {children}
    </div>
  ),
  StyleSheet: { create: (styles: unknown) => styles },
  AccessibilityInfo: {},
  AppState: {},
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({}),
  useIsFocused: () => true,
  StackActions: {},
}));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => {} }));
vi.mock("expo-image", () => ({ Image: "img" }));
vi.mock("@expo/ui/community/masked-view", () => ({ MaskedView: "div" }));
vi.mock("@legendapp/list/reanimated", () => ({ AnimatedLegendList: () => null }));
vi.mock("react-native-svg", () => ({
  default: "svg",
  Defs: "defs",
  LinearGradient: "linearGradient",
  Rect: "rect",
  Stop: "stop",
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
  LinearTransition: { duration: () => ({}) },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));
vi.mock("../../state/queries", () => ({ useTurnItemDetail: () => ({ data: null }) }));
vi.mock("../../state/assets", () => ({ useAssetUrl: () => null }));
vi.mock("./thread-command-output", () => ({
  ThreadCommandOutput: () => null,
  useCommandOutputStreaming: () => false,
}));
vi.mock("./markdownCodeHighlightState", () => ({ useMarkdownCodeHighlight: () => null }));
vi.mock("./ProposedPlanCard", () => ({ ProposedPlanCard: () => null }));
vi.mock("./SubagentStatusDot", () => ({ SubagentStatusDot: () => null }));
vi.mock("./thread-subagent-group", () => ({ ThreadSubagentGroup: () => null }));
vi.mock("./QuestionAnswerHistory", () => ({ QuestionAnswerHistory: () => null }));
vi.mock("../../components/T3Wordmark", () => ({ T3Wordmark: () => null }));
vi.mock("./BrowserAppIcon", () => ({ BrowserAppIcon: () => null }));
vi.mock("../../components/FilePreviewGallery", () => ({ FilePreviewGallery: () => null }));
vi.mock("./ThreadMarkdownImage", () => ({ ThreadMarkdownImage: () => null }));
vi.mock("../pull-requests/pullRequestGlyphs", () => ({ PullRequestGlyph: () => null }));

import { ThreadWorkLog } from "./thread-work-log";

const environmentId = EnvironmentId.make("environment-test");
const threadId = ThreadId.make("source-thread");
const runId = RunId.make("run-a");
const now = DateTime.makeUnsafe("2026-10-16T12:00:00Z");
let root: Root;
let container: HTMLDivElement;

function failureRow(
  resetAt: string | null,
  message = "Please try again at 3:33 PM. <b>literal</b>",
): ComponentProps<typeof ThreadWorkLog>["activities"][number] {
  const item: OrchestrationV2TurnItem = {
    id: TurnItemId.make("quota-error"),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "failed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "error",
    failure: {
      class: "usage_limit",
      message,
      code: "usageLimitExceeded",
      retryable: null,
      resetAt,
    },
  };
  return {
    id: "quota-error",
    createdAt: "2026-10-16T12:00:00Z",
    runId,
    attemptId: null,
    summary: "Provider error",
    detail: null,
    canExpand: false,
    fetchesDetail: false,
    getFullDetail: () => null,
    getCopyText: () => message,
    icon: "warning",
    logo: null,
    toolLike: false,
    prominent: true,
    status: "failure",
    lifecycleStatus: "failed",
    workEntry: {
      id: "quota-error",
      createdAt: "2026-10-16T12:00:00Z",
      label: "Provider error",
      tone: "error",
    },
    projectedItem: {
      position: 0,
      visibility: "local",
      sourceThreadId: threadId,
      sourceItemId: item.id,
      item,
    },
  };
}
function renderRow(row: ReturnType<typeof failureRow>, fixture?: ReturnType<typeof originFixture>) {
  act(() =>
    root.render(
      <RegistryProvider
        initialValues={
          fixture
            ? [
                [
                  environmentThreadDetails.threadAtom(
                    scopeThreadRef(environmentId, fixture.item.threadId),
                  ),
                  { environmentId, projection: fixture.projection },
                ],
                [serverEnvironment.providersValueAtom(environmentId), fixture.providers],
              ]
            : []
        }
      >
        <ThreadWorkLog
          activities={[row]}
          anchorKey="test"
          environmentId={environmentId}
          copiedRowId={null}
          expandedRows={{}}
          scrollPositions={new Map()}
          rowSizing={{ textSizeKey: "test", estimatedRowHeight: 24, fixedRowHeight: 24 }}
          iconSubtleColor="#888"
          edgeFadeColor="#fff"
          themeAppearance="light"
          onCopyRow={() => {}}
          onToggleRow={() => {}}
          renderImage={() => null}
          renderReasoning={(text) => text}
          onPressPreview={() => {}}
        />
      </RegistryProvider>,
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  retryCommand.mockClear();
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("quota warning", () => {
  it.each([null, "2026-10-16T20:05:33.000Z"])(
    "retains message and accessible origin with reset %s",
    (resetAt) => {
      vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (
        this: Date,
        _locale,
        options,
      ) {
        return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(this);
      });
      const row = failureRow(
        resetAt,
        resetAt ? quotaMessage.replace("3:33 PM", "4:05 AM") : quotaMessage,
      );
      renderRow(row);
      expect(container.textContent).toContain("Usage limit reached.");
      expect(container.textContent).toContain(row.getCopyText());
      expect(container.textContent).toContain("Provider origin unavailable");
      expect(container.querySelector('[role="button"]')?.getAttribute("aria-label")).toContain(
        row.getCopyText(),
      );
      expect(container.textContent?.includes("Retry after")).toBe(resetAt !== null);
      if (resetAt) expect(container.textContent).toContain("Retry after Oct 16, 8:05 PM.");
      expect(container.querySelector("b")).toBeNull();
    },
  );
});

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

function renderOrigin(
  fixture: ReturnType<typeof originFixture>,
  visibility: "local" | "inherited" = "local",
) {
  const row = {
    ...failureRow(null),
    projectedItem: {
      position: 0,
      visibility,
      sourceThreadId: fixture.item.threadId,
      sourceItemId: fixture.item.id,
      item: fixture.item,
    },
  };
  renderRow(row, fixture);
}

describe("quota origin", () => {
  it.each(["local", "inherited"] as const)(
    "keeps the source instance after selection changes for %s rows",
    async (visibility) => {
      await renderOrigin(originFixture(), visibility);
      expect(container.textContent).toContain("Codex · Instance: Original instance");
      expect(container.querySelector('[role="button"]')?.getAttribute("aria-label")).toContain(
        "Codex · Instance: Original instance",
      );
      expect(container.textContent).toContain(quotaMessage);
      expect(container.textContent).not.toContain("Current selection");
      expect(container.textContent).not.toContain("not-an-instance@example.test");
    },
  );
  it.each([undefined, "   ", "Codex"])(
    "does not expose an opaque instance ID for displayName %s",
    async (displayName) => {
      const fixture = originFixture();
      fixture.providers = fixture.providers.map((p) =>
        p.instanceId === originInstance ? { ...p, displayName } : p,
      );
      await renderOrigin(fixture);
      expect(container.textContent).toContain(
        displayName === "Codex" ? "Codex · Instance: Codex" : "Codex · Instance label unavailable",
      );
      expect(container.textContent).not.toContain("opaque-a-123");
      expect(container.textContent).not.toContain("Current selection");
    },
  );
  it("retains the known driver when the catalog entry is unavailable", async () => {
    const fixture = originFixture();
    fixture.providers = [];
    await renderOrigin(fixture);
    expect(container.textContent).toContain("Codex · Instance label unavailable");
    expect(container.textContent).toContain(quotaMessage);
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
    await renderOrigin(fixture);
    expect(container.textContent).toContain("custom-driver · Instance label unavailable");
    expect(container.textContent).not.toContain("opaque-a-123");
    expect(container.textContent).not.toContain("instance-b");
    expect(container.textContent).not.toContain("Current selection");
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
    await renderOrigin(fixture);
    expect(container.textContent).toContain("Claude · Instance: Child instance");
    expect(container.textContent).not.toContain("Original instance");
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
    await renderOrigin(fixture);
    expect(container.textContent).toContain("Codex · Instance: Original instance");
  });
  it("uses the exact run only when the item is its root", async () => {
    const fixture = originFixture();
    fixture.item = { ...fixture.item, providerThreadId: null };
    fixture.projection = { ...fixture.projection, turnItems: [fixture.item], providerThreads: [] };
    await renderOrigin(fixture);
    expect(container.textContent).toContain("Codex · Instance: Original instance");
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
      await renderOrigin(fixture, "inherited");
      expect(container.textContent).toContain("Provider origin unavailable");
      expect(container.textContent).not.toContain("Original instance");
      expect(container.textContent).not.toContain("Current selection");
    },
  );
});

it("preserves non-quota message, accessibility and workspace preparation retry", async () => {
  const fixture = originFixture();
  fixture.item = {
    ...fixture.item,
    failure: {
      class: "unknown",
      code: "workspace_preparation_failed",
      message: "Worktree setup failed.",
      retryable: true,
      resetAt: null,
    },
  };
  fixture.projection = {
    ...fixture.projection,
    turnItems: [fixture.item],
    runs: fixture.projection.runs.map((run) => ({
      ...run,
      workspacePreparation: { type: "worktree", baseRef: "main" },
    })),
  };
  renderOrigin(fixture);
  expect(container.textContent).toContain("Worktree setup failed.");
  expect(container.querySelector('[role="button"]')?.getAttribute("aria-label")).toBe(
    "Provider error: Worktree setup failed.",
  );
  expect(container.textContent).not.toContain("Instance:");
  const retry = container.querySelector<HTMLElement>('[aria-label="Retry workspace preparation"]');
  expect(retry?.textContent).toBe("Retry");
  await act(async () => retry?.click());
  expect(retryCommand.mock.calls).toEqual([
    [{ environmentId, input: { threadId: originThread, runId: originRun } }],
  ]);
});

it("renders quota markup literally", async () => {
  const fixture = originFixture();
  const message =
    '<script>throw "unsafe"</script><img src=x onerror="unsafe()"> try again at 3:33 PM';
  fixture.item = { ...fixture.item, failure: { ...fixture.item.failure, message } };
  fixture.projection = { ...fixture.projection, turnItems: [fixture.item] };
  await renderOrigin(fixture);
  expect(container.textContent).toContain(message);
  expect(container.querySelector("script, img, [onerror]")).toBeNull();
});

it("keeps an in-progress provider retry collapsed", () => {
  const row = failureRow(null, "The response stream disconnected.");
  const item = row.projectedItem.item;
  if (item.type !== "error") throw new Error("Expected error fixture");
  renderRow({
    ...row,
    summary: "Retrying provider (2/5)",
    prominent: false,
    status: "neutral",
    projectedItem: {
      ...row.projectedItem,
      item: {
        ...item,
        status: "running",
        failure: { ...item.failure, class: "transport_error" },
        retry: { attempt: 2, maxAttempts: 5, retryDelayMs: null },
      },
    },
    workEntry: { ...row.workEntry, label: "Retrying provider (2/5)" },
  });
  expect(container.textContent).toContain("Retrying provider (2/5)");
  expect(container.textContent).not.toContain("The response stream disconnected.");
  expect(container.textContent).not.toContain("Provider origin");
});

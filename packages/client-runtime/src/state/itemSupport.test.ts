import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
  ThreadId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import {
  EMPTY_V2_ITEM_SUPPORT,
  formatV2ProviderOriginLabel,
  resolveV2ItemSupport,
  resolveV2ItemProviderOrigin,
} from "./itemSupport.ts";

const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const runId = RunId.make("run-1");
const nodeId = NodeId.make("node-1");
const itemId = TurnItemId.make("item-1");
const requestId = RuntimeRequestId.make("request-1");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerThreadId = ProviderThreadId.make("provider-thread-1");
const providerTurnId = ProviderTurnId.make("provider-turn-1");

const commandItem: OrchestrationV2TurnItem = {
  id: itemId,
  threadId: v2ThreadId,
  runId,
  nodeId,
  providerThreadId,
  providerTurnId,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "running",
  title: null,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
  type: "command_execution",
  input: "vp check",
};

const run = {
  id: runId,
  threadId: v2ThreadId,
  ordinal: 1,
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
  providerThreadId,
  userMessageId: "message-1" as never,
  rootNodeId: nodeId,
  activeAttemptId: RunAttemptId.make("attempt-2"),
  status: "running" as const,
  requestedAt: now,
  startedAt: now,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};
const attempts = [
  {
    id: RunAttemptId.make("attempt-1"),
    runId,
    attemptOrdinal: 1,
    rootNodeId: nodeId,
    providerInstanceId,
    providerThreadId,
    providerTurnId,
    reason: "initial" as const,
    status: "superseded" as const,
    startedAt: now,
    completedAt: now,
  },
  {
    id: RunAttemptId.make("attempt-2"),
    runId,
    attemptOrdinal: 2,
    rootNodeId: nodeId,
    providerInstanceId,
    providerThreadId,
    providerTurnId,
    reason: "steering_restart" as const,
    status: "running" as const,
    startedAt: now,
    completedAt: null,
  },
];
const node = {
  id: nodeId,
  threadId: v2ThreadId,
  runId,
  parentNodeId: null,
  rootNodeId: nodeId,
  kind: "tool_call" as const,
  status: "running" as const,
  countsForRun: true,
  providerThreadId,
  providerTurnId,
  nativeItemRef: null,
  runtimeRequestId: requestId,
  checkpointScopeId: null,
  startedAt: now,
  completedAt: null,
};
const providerThread = {
  id: providerThreadId,
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId,
  providerSessionId: null,
  appThreadId: v2ThreadId,
  ownerNodeId: nodeId,
  nativeThreadRef: null,
  nativeConversationHeadRef: null,
  status: "active" as const,
  firstRunOrdinal: 1,
  lastRunOrdinal: 1,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
};
const providerTurn = {
  id: providerTurnId,
  providerThreadId,
  nodeId,
  runAttemptId: attempts[1]!.id,
  nativeTurnRef: null,
  ordinal: 1,
  status: "running" as const,
  startedAt: now,
  completedAt: null,
};
const runtimeRequest = {
  id: requestId,
  nodeId,
  providerTurnId,
  nativeRequestRef: null,
  kind: "dynamic_tool_call" as const,
  status: "pending" as const,
  responseCapability: {
    type: "live" as const,
    providerSessionId: ProviderSessionId.make("session-1"),
  },
  createdAt: now,
  resolvedAt: null,
};

describe("resolveV2ItemSupport", () => {
  it("retains identity while linking a turn item to its execution and provider entities", () => {
    const projection = {
      ...v2Projection,
      runs: [run],
      attempts,
      nodes: [node],
      providerThreads: [providerThread],
      providerTurns: [providerTurn],
      runtimeRequests: [runtimeRequest],
      turnItems: [commandItem],
    };

    const support = resolveV2ItemSupport(projection, itemId);
    expect(support.item).toBe(commandItem);
    expect(support.run).toBe(run);
    expect(support.attempts).toEqual(attempts);
    expect(support.attempts[0]).toBe(attempts[0]);
    expect(support.node).toBe(node);
    expect(support.providerThread).toBe(providerThread);
    expect(support.providerTurn).toBe(providerTurn);
    expect(support.runtimeRequest).toBe(runtimeRequest);
  });

  it("resolves synthetic items from the authoritative visible sequence", () => {
    const projection = {
      ...v2Projection,
      visibleTurnItems: [
        {
          position: 0,
          visibility: "synthetic" as const,
          sourceThreadId: v2ThreadId,
          sourceItemId: itemId,
          item: commandItem,
        },
      ],
    };
    expect(resolveV2ItemSupport(projection, itemId).item).toBe(commandItem);
  });
});

const originSupport = resolveV2ItemSupport(
  {
    ...v2Projection,
    runs: [run],
    attempts,
    nodes: [node],
    providerThreads: [providerThread],
    providerTurns: [providerTurn],
    turnItems: [commandItem],
  },
  itemId,
);

describe("resolveV2ItemProviderOrigin", () => {
  it("uses the named attempt after another attempt becomes active", () => {
    const changed = {
      ...originSupport,
      run: {
        ...run,
        providerInstanceId: ProviderInstanceId.make("other"),
        activeAttemptId: attempts[0]!.id,
      },
      attempts: [
        { ...attempts[0]!, providerInstanceId: ProviderInstanceId.make("other") },
        attempts[1]!,
      ],
    };
    expect(
      resolveV2ItemProviderOrigin(changed, { sourceThreadId: v2ThreadId, sourceItemId: itemId }),
    ).toEqual({ providerInstanceId, driver: "codex" });
  });
  it("uses a child's provider thread even when it shares its parent's run", () => {
    const child = {
      ...providerThread,
      providerInstanceId: ProviderInstanceId.make("child-instance"),
      driver: ProviderDriverKind.make("claudeAgent"),
    };
    expect(
      resolveV2ItemProviderOrigin(
        {
          ...originSupport,
          providerTurn: { ...providerTurn, runAttemptId: null },
          providerThread: child,
        },
        { sourceThreadId: v2ThreadId, sourceItemId: itemId },
      ),
    ).toEqual({ providerInstanceId: "child-instance", driver: "claudeAgent" });
  });
  it.each([
    { providerTurn: null },
    { providerTurn: { ...providerTurn, providerThreadId: ProviderThreadId.make("other") } },
    { providerTurn: { ...providerTurn, id: ProviderTurnId.make("other") } },
    { providerTurn: { ...providerTurn, runAttemptId: RunAttemptId.make("unloaded") } },
    { attempts: [{ ...attempts[1]!, providerThreadId: ProviderThreadId.make("other") }] },
    { attempts: [{ ...attempts[1]!, providerInstanceId: ProviderInstanceId.make("other") }] },
    { attempts: [{ ...attempts[1]!, providerTurnId: ProviderTurnId.make("other") }] },
    { attempts: [{ ...attempts[1]!, runId: RunId.make("other") }] },
    { providerThread: { ...providerThread, id: ProviderThreadId.make("other") } },
    { providerThread: { ...providerThread, appThreadId: ThreadId.make("other") } },
    { providerThread: null },
  ])("rejects contradictory or unloaded links %j", (changes) => {
    expect(
      resolveV2ItemProviderOrigin(
        { ...originSupport, ...changes },
        { sourceThreadId: v2ThreadId, sourceItemId: itemId },
      ),
    ).toBeNull();
  });
  it("allows absent optional attempt links on the exact provider thread", () => {
    expect(
      resolveV2ItemProviderOrigin(
        {
          ...originSupport,
          providerTurn: { ...providerTurn, runAttemptId: null },
        },
        { sourceThreadId: v2ThreadId, sourceItemId: itemId },
      ),
    ).toEqual({ providerInstanceId, driver: "codex" });
    expect(
      resolveV2ItemProviderOrigin(
        {
          ...originSupport,
          attempts: [{ ...attempts[1]!, providerTurnId: null }],
        },
        { sourceThreadId: v2ThreadId, sourceItemId: itemId },
      ),
    ).toEqual({ providerInstanceId, driver: "codex" });
  });
  it("falls back only for a positively matched root in the source thread", () => {
    const root = {
      ...EMPTY_V2_ITEM_SUPPORT,
      run,
      item: { ...commandItem, providerThreadId: null, providerTurnId: null },
    };
    expect(
      resolveV2ItemProviderOrigin(root, { sourceThreadId: v2ThreadId, sourceItemId: itemId }),
    ).toEqual({ providerInstanceId, driver: null });
    expect(
      resolveV2ItemProviderOrigin(
        {
          ...root,
          item: { ...root.item, nodeId: null },
          run: { ...run, rootNodeId: null },
        },
        { sourceThreadId: v2ThreadId, sourceItemId: itemId },
      ),
    ).toBeNull();
    expect(
      resolveV2ItemProviderOrigin(
        {
          ...root,
          item: { ...root.item, nodeId: NodeId.make("child") },
        },
        { sourceThreadId: v2ThreadId, sourceItemId: itemId },
      ),
    ).toBeNull();
    expect(
      resolveV2ItemProviderOrigin(
        { ...root, run: { ...run, threadId: ThreadId.make("other") } },
        { sourceThreadId: v2ThreadId, sourceItemId: itemId },
      ),
    ).toBeNull();
    expect(
      resolveV2ItemProviderOrigin(EMPTY_V2_ITEM_SUPPORT, {
        sourceThreadId: v2ThreadId,
        sourceItemId: itemId,
      }),
    ).toBeNull();
  });
});

it("rejects support from a different projected source", () => {
  expect(
    resolveV2ItemProviderOrigin(originSupport, {
      sourceThreadId: ThreadId.make("other"),
      sourceItemId: itemId,
    }),
  ).toBeNull();
  expect(
    resolveV2ItemProviderOrigin(originSupport, {
      sourceThreadId: v2ThreadId,
      sourceItemId: TurnItemId.make("other"),
    }),
  ).toBeNull();
});

describe("formatV2ProviderOriginLabel", () => {
  const codex = ProviderDriverKind.make("codex");
  const custom = ProviderDriverKind.make("custom-driver");
  const catalog = (driver: ProviderDriverKind, displayName?: string) => [
    { instanceId: providerInstanceId, driver, displayName },
    { instanceId: ProviderInstanceId.make("selection-b"), driver, displayName: "Selection B" },
  ];
  it.each([
    [{ providerInstanceId, driver: codex }, catalog(codex, " Mine "), "Codex · Instance: Mine"],
    [
      { providerInstanceId, driver: custom },
      catalog(custom),
      "custom-driver · Instance label unavailable",
    ],
    [{ providerInstanceId, driver: custom }, null, "custom-driver · Instance label unavailable"],
    [
      { providerInstanceId, driver: custom },
      catalog(custom, "Mine"),
      "custom-driver · Instance: Mine",
    ],
    [
      { providerInstanceId, driver: codex },
      catalog(custom, "Mine"),
      "Codex · Instance label unavailable",
    ],
    [
      { providerInstanceId, driver: codex },
      catalog(codex, "   "),
      "Codex · Instance label unavailable",
    ],
    [{ providerInstanceId, driver: null }, catalog(codex, "Mine"), "Codex · Instance: Mine"],
    [
      { providerInstanceId, driver: null },
      catalog(custom),
      "custom-driver · Instance label unavailable",
    ],
    [{ providerInstanceId, driver: null }, [], "Provider origin unavailable"],
    [null, catalog(codex, "Mine"), "Provider origin unavailable"],
  ] as const)("formats %j with %j", (origin, providers, expected) => {
    const label = formatV2ProviderOriginLabel(origin, providers);
    expect(label).toBe(expected);
    expect(label).not.toContain("selection-b");
    expect(label).not.toContain("Selection B");
  });
});

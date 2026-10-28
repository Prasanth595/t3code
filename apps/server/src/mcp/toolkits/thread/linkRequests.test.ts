import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";

const threadId = ThreadId.make("thread:delegated-here");
const runId = RunId.make("run:delegated-here");
const approvalId = RuntimeRequestId.make("request:approval");
const questionId = RuntimeRequestId.make("request:question");
const linkSession = "session:laptop-link";

const shell = (
  linkOrigin?: OrchestrationV2ThreadShell["linkOrigin"],
): OrchestrationV2ThreadShell => ({
  ...liveThreadShell(threadId, { runtimeMode: "approval-required" }),
  ...(linkOrigin === undefined ? {} : { linkOrigin }),
});

const request = (
  id: RuntimeRequestId,
  kind: OrchestrationV2RuntimeRequest["kind"],
  status: OrchestrationV2RuntimeRequest["status"] = "pending",
): OrchestrationV2RuntimeRequest => ({
  id,
  nodeId: NodeId.make("node:root"),
  providerTurnId: null,
  nativeRequestRef: null,
  kind,
  status,
  responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("session") },
  createdAt: liveThreadShell(threadId).createdAt,
  resolvedAt: null,
});

const itemBase = {
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "waiting" as const,
  title: null,
  startedAt: liveThreadShell(threadId).createdAt,
  completedAt: null,
  updatedAt: liveThreadShell(threadId).createdAt,
};
const approvalItem: OrchestrationV2TurnItem = {
  ...itemBase,
  id: TurnItemId.make("item:approval"),
  type: "approval_request",
  requestId: approvalId,
  requestKind: "command",
  prompt: "rm -rf build",
  reason: "Clean the build",
};
const questionItem: OrchestrationV2TurnItem = {
  ...itemBase,
  id: TurnItemId.make("item:question"),
  type: "user_input_request",
  requestId: questionId,
  questions: [{ id: "size", header: "Size", question: "Which size?", options: [] }],
};

const scopeOf = (
  client: McpInvocationContext.McpClientCaller | undefined,
  thread?: McpInvocationContext.McpThreadCaller,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:box"),
  requestNamespace: client?.sessionId ?? "agent",
  thread,
  client,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});
const link = (access: McpInvocationContext.McpClientCaller["access"]) =>
  scopeOf({ sessionId: linkSession, label: "Laptop", access, linked: true });
const outsideClient = scopeOf({ sessionId: "session:claude", label: "Claude", access: "auto" });
const agent = scopeOf(undefined, {
  threadId: ThreadId.make("thread:agent"),
  providerSessionId: "provider:agent",
  providerInstanceId: ProviderInstanceId.make("codex"),
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "link-requests", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "link-requests", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const call = (scope: McpInvocationContext.McpInvocationScope, args: Record<string, unknown>) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: "t3_link_requests", arguments: args })),
    Effect.map((result) => {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      return { failed: result.isError === true, body: JSON.parse(text) };
    }),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const layerBox = (input: {
  readonly shell: OrchestrationV2ThreadShell;
  readonly requests: Ref.Ref<ReadonlyArray<OrchestrationV2RuntimeRequest>>;
  readonly dispatched: Ref.Ref<ReadonlyArray<OrchestrationV2ServerCommand>>;
  readonly requestRecorded: Stream.Stream<unknown>;
}) =>
  McpHttpServer.layerThreadToolkit.pipe(
    Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
    Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
    Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
    Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
    Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(id === threadId ? input.shell : liveThreadShell(id)),
        getThreadEventSequence: () => Effect.succeed(0),
        getProjectThreadRecords: () =>
          Ref.get(input.requests).pipe(
            Effect.map((runtimeRequests) => ({
              ...idleThreadProjection(input.shell),
              runtimeRequests,
              turnItems: [approvalItem, questionItem],
            })),
          ),
        streamStoredEventsFrom: () =>
          input.requestRecorded as ReturnType<
            ThreadManagement.ThreadManagementService["Service"]["streamStoredEventsFrom"]
          >,
        dispatch: (command) =>
          Ref.update(input.dispatched, (seen) => [...seen, command]).pipe(
            Effect.as({ sequence: 7, storedEvents: [] } as never),
          ),
      }),
    ),
  );

const box = Effect.fn("box")(function* (
  options: {
    readonly linkOrigin?: OrchestrationV2ThreadShell["linkOrigin"];
    readonly requests?: ReadonlyArray<OrchestrationV2RuntimeRequest>;
    readonly requestRecorded?: (
      requests: Ref.Ref<ReadonlyArray<OrchestrationV2RuntimeRequest>>,
    ) => Stream.Stream<unknown>;
  } = {},
) {
  const requests = yield* Ref.make(options.requests ?? []);
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const layer = layerBox({
    shell: shell(options.linkOrigin ?? { sessionId: linkSession, label: "Laptop", access: "auto" }),
    requests,
    dispatched,
    requestRecorded: options.requestRecorded?.(requests) ?? Stream.never,
  });
  return { requests, dispatched, layer };
});

it.effect(
  "a link watching a thread reads its live questions and approvals with their details",
  () =>
    Effect.gen(function* () {
      const { layer } = yield* box({
        requests: [
          request(approvalId, "command"),
          request(questionId, "user_input"),
          request(RuntimeRequestId.make("request:answered"), "command", "resolved"),
          request(RuntimeRequestId.make("request:auth"), "auth_refresh"),
        ],
      });
      const { failed, body } = yield* call(link("auto"), { action: "watch", threadId }).pipe(
        Effect.provide(layer),
      );
      expect(failed).toBe(false);
      expect(body.requests).toEqual([
        {
          requestId: approvalId,
          kind: "command",
          createdAt: "2026-01-01T00:00:00.000Z",
          runId,
          detail: "rm -rf build",
          reason: "Clean the build",
        },
        {
          requestId: questionId,
          kind: "user_input",
          createdAt: "2026-01-01T00:00:00.000Z",
          runId,
          questions: questionItem.type === "user_input_request" ? questionItem.questions : [],
        },
      ]);
    }),
);

it.effect("a watch reports a request recorded while it waits", () =>
  Effect.gen(function* () {
    const { layer } = yield* box({
      requests: [request(approvalId, "command")],
      requestRecorded: (requests) =>
        Stream.fromEffect(
          Ref.set(requests, [request(approvalId, "command"), request(questionId, "user_input")]),
        ),
    });
    const { body } = yield* call(link("auto"), {
      action: "watch",
      threadId,
      knownRequestIds: [approvalId],
    }).pipe(Effect.provide(layer));
    expect(body.requests.map((entry: { requestId: string }) => entry.requestId)).toEqual([
      approvalId,
      questionId,
    ]);
  }),
);

it.effect("a watch with nothing new answers with what the link knows once it times out", () =>
  Effect.gen(function* () {
    const { layer } = yield* box({ requests: [request(approvalId, "command")] });
    const watching = yield* call(link("auto"), {
      action: "watch",
      threadId,
      knownRequestIds: [approvalId],
      timeoutMs: 1_000,
    }).pipe(Effect.provide(layer), Effect.forkChild);
    yield* TestClock.adjust(1_000);
    const { body } = yield* Fiber.join(watching);
    expect(body.requests.map((entry: { requestId: string }) => entry.requestId)).toEqual([
      approvalId,
    ]);
  }),
);

it.effect.each([
  ["an agent here", agent],
  ["an outside MCP client", outsideClient],
] as const)("%s does not find the link tool", ([, scope]) =>
  Effect.gen(function* () {
    const { layer } = yield* box({ requests: [request(approvalId, "command")] });
    const refused = yield* call(scope, { action: "watch", threadId }).pipe(
      Effect.provide(layer),
      Effect.flip,
    );
    expect(refused._tag).toBe("InvalidParams");
  }),
);

it.effect("a read-only link cannot answer", () =>
  Effect.gen(function* () {
    const { dispatched, layer } = yield* box({ requests: [request(approvalId, "command")] });
    const { failed, body } = yield* call(link("read-only"), {
      action: "respond",
      threadId,
      requestId: approvalId,
      decision: "accept",
      clientRequestId: "answer-1",
    }).pipe(Effect.provide(layer));
    expect(failed).toBe(true);
    expect(body.code).toBe("capability_denied");
    expect(yield* Ref.get(dispatched)).toEqual([]);
  }),
);

it.effect("a link paired below full access answers only threads it started", () =>
  Effect.gen(function* () {
    const { dispatched, layer } = yield* box({
      linkOrigin: { sessionId: "session:other-link", label: "Other", access: "auto" },
      requests: [request(approvalId, "command")],
    });
    const { failed, body } = yield* call(link("auto"), {
      action: "respond",
      threadId,
      requestId: approvalId,
      decision: "accept",
      clientRequestId: "answer-1",
    }).pipe(Effect.provide(layer));
    expect(failed).toBe(true);
    expect(body.code).toBe("capability_denied");
    expect(yield* Ref.get(dispatched)).toEqual([]);
  }),
);

it.effect("a link paired below full access cannot accept a request for every later session", () =>
  Effect.gen(function* () {
    const { dispatched, layer } = yield* box({ requests: [request(approvalId, "command")] });
    const { failed, body } = yield* call(link("auto"), {
      action: "respond",
      threadId,
      requestId: approvalId,
      decision: "acceptAlways",
      clientRequestId: "answer-1",
    }).pipe(Effect.provide(layer));
    expect(failed).toBe(true);
    expect(body.code).toBe("capability_denied");
    expect(yield* Ref.get(dispatched)).toEqual([]);
  }),
);

it.effect("a link answers an approval on a thread it started, once per answer", () =>
  Effect.gen(function* () {
    const { dispatched, layer } = yield* box({ requests: [request(approvalId, "command")] });
    const answer = call(link("approval-required"), {
      action: "respond",
      threadId,
      requestId: approvalId,
      decision: "accept",
      clientRequestId: "answer-1",
    }).pipe(Effect.provide(layer));
    expect((yield* answer).failed).toBe(false);
    expect((yield* answer).failed).toBe(false);
    const commands = yield* Ref.get(dispatched);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      type: "runtime-request.respond",
      threadId,
      requestId: approvalId,
      decision: "accept",
    });
    // The same answer resent is the same command, which the box records once.
    expect(commands[1]?.commandId).toBe(commands[0]?.commandId);
  }),
);

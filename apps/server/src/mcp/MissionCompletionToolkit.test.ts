import { assert, it } from "@effect/vitest";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool } from "effect/ai";

import type {
  CompletionRouteCandidate,
  CompletionRouteDecision,
} from "../orchestration-v2/MissionCompletionRouting.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as MissionMcpAuthority from "./MissionMcpAuthority.ts";
import * as MissionMcp from "./MissionMcpService.ts";
import * as CompletionMcp from "./MissionCompletionMcpService.ts";
import * as CompletionToolkit from "./MissionCompletionToolkit.ts";

/**
 * Transport-contract coverage for the optional completion toolkit seam. Every
 * call goes through the real in-memory Effect MCP dispatcher (McpServer.layer
 * SDK catalog plus tools-call) with a fresh per-request McpInvocationContext
 * scope, into the real handler over an explicitly controlled injected
 * CompletionMcpService. No SQL, no registry, no policy publisher, no live
 * authority: the injected service returns typed full candidates, holds, and
 * finite failures, and records each invocation scope. The genuine
 * service-backed SDK case belongs to the root integration.
 */

const TOOL = "mission_completion_route_read";
const missionId = "completion-mission";
const env = EnvironmentId.make("completion-toolkit-env");
const instance = ProviderInstanceId.make("completion-toolkit-account");
const threadA = ThreadId.make("completion-toolkit-thread-a");
const threadB = ThreadId.make("completion-toolkit-thread-b");

const scopeFor = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: env,
  capabilities: new Set<McpInvocationContext.McpCapability>(["orchestration"]),
  issuedAt: 1_000,
  requestNamespace: "completion-toolkit-test",
  thread: { threadId, providerSessionId: "completion-toolkit-session", providerInstanceId: instance },
  client: undefined,
});
const scopeA = scopeFor(threadA);
const scopeB = scopeFor(threadB);

const taskSelector = {
  kind: "task-result",
  missionId,
  taskId: "completion-task",
  attemptNumber: 2,
  resultRevision: 3,
} as const;
const retroSelector = {
  kind: "retro-report",
  missionId,
  checkpointId: "completion-checkpoint",
  reportRevision: 1,
} as const;
const longId = "m".repeat(129);

const notificationId = "ab".repeat(32);
const deliveryThread = "thread:delivery-manager%3Aepoch-3";
const retroThread = "thread:retro-manager%3Aepoch-5";

const taskCandidate: CompletionRouteCandidate = {
  missionId,
  scope: { teamId: "private-scope-team", environmentId: "private-scope-env", missionId },
  role: "delivery",
  targetThreadId: deliveryThread,
  targetEpoch: 3,
  canonicalRevision: 7,
  notificationId,
  observedRevision: 6,
  observedThreadId: "thread:private-observed%3Aold",
  observedEpoch: 2,
  source: {
    kind: "task-result",
    taskId: "completion-task",
    attemptNumber: 2,
    resultRevision: 3,
    childTaskId: "private-child-task",
    childThreadId: "thread:private-child%3Aid",
    childRunId: "run:private-child%3Aid",
  },
};
const retroCandidate: CompletionRouteCandidate = {
  missionId,
  scope: { teamId: "private-scope-team", environmentId: "private-scope-env", missionId },
  role: "retro",
  targetThreadId: retroThread,
  targetEpoch: 5,
  canonicalRevision: 9,
  notificationId,
  observedRevision: 8,
  observedThreadId: "thread:private-observed%3Aold",
  observedEpoch: 4,
  source: {
    kind: "retro-report",
    checkpointId: "completion-checkpoint",
    teamId: "private-scope-team",
    environmentId: "private-scope-env",
    missionId,
    sourceThreadId: "thread:private-source%3Aid",
    sourceRoot: "thread://private-source",
    snapshotFingerprint: "private-snapshot",
    coveredFromInclusive: 0,
    coveredToExclusive: 1,
    normalizedReportHash: "cd".repeat(32),
    sourceReportHash: "ef".repeat(32),
    reportRevision: 1,
    reporterChildThreadId: "thread:private-reporter%3Aid",
    reporterRunId: "run:private-reporter%3Aid",
  },
};
const taskCandidateWithPrivate = {
  ...taskCandidate,
  account: "private-account-7",
  provider: "private-provider-7",
  body: "private-body-7",
  detail: "private-detail-7",
  paths: ["/private/paths/route"],
} as unknown as CompletionRouteCandidate;

type Resolve = (
  actualScope: McpInvocationContext.McpInvocationScope,
  unknownSelector: unknown,
) => Effect.Effect<CompletionRouteDecision, MissionMcp.MissionMcpFailure>;

interface Call {
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly selector: unknown;
}

interface InjectedCompletionService {
  readonly resolve: Resolve;
}

const stubService = (calls: Array<Call>, resolve: Resolve): InjectedCompletionService => ({
  resolve: (actualScope, unknownSelector) => {
    calls.push({ scope: actualScope, selector: unknownSelector });
    return resolve(actualScope, unknownSelector);
  },
});

const policyLayer = Layer.succeed(MissionMcpAuthority.MissionMcpTrustedPolicy, {
  read: Effect.succeed({}),
});

interface Gate {
  readonly service: boolean;
  readonly policy: boolean;
}

const toolkitLayerFor = (service: InjectedCompletionService, gate: Gate) => {
  const optional = CompletionToolkit.layerOptionalMissionCompletionToolkit;
  if (gate.service && gate.policy) {
    return optional.pipe(
      Layer.provide(Layer.succeed(CompletionMcp.MissionCompletionMcpService, service)),
      Layer.provide(policyLayer),
    );
  }
  if (gate.service) {
    return optional.pipe(
      Layer.provide(Layer.succeed(CompletionMcp.MissionCompletionMcpService, service)),
    );
  }
  if (gate.policy) return optional.pipe(Layer.provide(policyLayer));
  return optional;
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "completion-toolkit-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "completion-toolkit-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const callVia = (
  service: InjectedCompletionService,
  gate: Gate,
  scope: McpInvocationContext.McpInvocationScope,
  args: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server.callTool({ name: TOOL, arguments: args });
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provide(toolkitLayerFor(service, gate).pipe(Layer.provideMerge(McpServer.McpServer.layer))),
  );

const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeResult = Schema.decodeUnknownSync(CompletionToolkit.MissionCompletionRouteReadResult);

const sdkRejectionOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.match(effect, {
    onFailure: (error) => error as { readonly _tag: string },
    onSuccess: () => undefined,
  });

const declaredFailure = (result: McpSchema.CallToolResult) => {
  assert.strictEqual(result.isError, true);
  assert.strictEqual(result.structuredContent, undefined);
  const text = result.content[0];
  const body =
    result.isError === true && text?.type === "text" ? decodeJsonText(text.text) : undefined;
  assert.isDefined(body);
  assert.deepStrictEqual(Object.keys(body as Record<string, unknown>).sort(), [
    "_tag",
    "code",
    "message",
  ]);
  return body as { readonly _tag: "MissionMcpFailure"; readonly code: string; readonly message: string };
};

const successBody = (result: McpSchema.CallToolResult) => {
  assert.strictEqual(result.isError, false);
  assert.deepStrictEqual(
    Object.keys(result.structuredContent as Record<string, unknown>).sort(),
    ["holdReason", "missionId", "route", "status"],
  );
  return decodeResult(result.structuredContent);
};

it.effect("exposes a read-only idempotent descriptor over the object-root selector", () => {
  const calls: Array<Call> = [];
  const service = stubService(calls, () =>
    Effect.succeed({ kind: "candidate", candidate: taskCandidate }),
  );
  const live = toolkitLayerFor(service, { service: true, policy: true }).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
  );
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const entry = server.tools.find((candidate) => candidate.tool.name === TOOL);
    assert.isDefined(entry);
    if (entry === undefined) return yield* Effect.die("completion tool missing from the SDK catalog");
    assert.strictEqual(Context.get(entry.annotations, Tool.Readonly), true);
    assert.strictEqual(Context.get(entry.annotations, Tool.Destructive), false);
    assert.strictEqual(Context.get(entry.annotations, Tool.Idempotent), true);
    assert.deepStrictEqual(
      Object.keys(CompletionToolkit.MissionCompletionRouteReadInput.fields),
      ["selector"],
    );
    const rejection = yield* sdkRejectionOf(
      callVia(service, { service: true, policy: true }, scopeA, {}),
    );
    assert.isDefined(rejection);
    assert.strictEqual(rejection._tag, "InvalidParams");
    assert.strictEqual(calls.length, 0);
  }).pipe(Effect.provide(live));
});

it.effect.each([
  { service: false, policy: false },
  { service: true, policy: false },
  { service: false, policy: true },
])("keeps the tool absent without both dependencies (%o)", (gate) => {
  const calls: Array<Call> = [];
  const service = stubService(calls, () =>
    Effect.succeed({ kind: "hold", missionId, reason: "unknown_completion", detail: "unreached" }),
  );
  return Effect.gen(function* () {
    const rejection = yield* sdkRejectionOf(
      callVia(service, gate, scopeA, { selector: { ...taskSelector } }),
    );
    assert.isDefined(rejection);
    assert.strictEqual(rejection._tag, "InvalidParams");
    assert.strictEqual(calls.length, 0);
  });
});

it.effect("delivers a delivery candidate with bounded public fields only", () => {
  const calls: Array<Call> = [];
  const service = stubService(calls, () =>
    Effect.succeed({ kind: "candidate", candidate: taskCandidateWithPrivate }),
  );
  const gate = { service: true, policy: true };
  return Effect.gen(function* () {
    const body = successBody(
      yield* callVia(service, gate, scopeA, { selector: { ...taskSelector } }),
    );
    assert.strictEqual(body.status, "candidate");
    assert.strictEqual(body.missionId, missionId);
    assert.strictEqual(body.holdReason, null);
    assert.deepStrictEqual(body.route, {
      role: "delivery",
      targetThreadId: deliveryThread,
      targetEpoch: 3,
      canonicalRevision: 7,
      notificationId,
    });
    const text = stableStringify(body);
    for (const marker of [
      "private-scope-team",
      "private-child-task",
      "private-observed",
      "private-account-7",
      "private-provider-7",
      "private-body-7",
      "private-detail-7",
      "/private/paths/route",
    ]) {
      assert.notInclude(text, marker);
    }
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]?.scope.thread?.threadId, threadA);
    assert.deepStrictEqual(calls[0]?.selector, { ...taskSelector });
  });
});

it.effect("returns a finite hold without candidate detail", () => {
  const calls: Array<Call> = [];
  const service = stubService(calls, () =>
    Effect.succeed({
      kind: "hold",
      missionId,
      reason: "scope_mismatch",
      detail: "private-hold-detail-9",
    }),
  );
  const gate = { service: true, policy: true };
  return Effect.gen(function* () {
    const body = successBody(
      yield* callVia(service, gate, scopeA, { selector: { ...retroSelector } }),
    );
    assert.strictEqual(body.status, "hold");
    assert.strictEqual(body.missionId, missionId);
    assert.strictEqual(body.route, null);
    assert.strictEqual(body.holdReason, "scope_mismatch");
    assert.notInclude(stableStringify(body), "private-hold-detail-9");
    assert.strictEqual(calls.length, 1);
  });
});

it.effect("isolates successive distinct invocation scopes on one persistent server", () => {
  const calls: Array<Call> = [];
  const service = stubService(calls, (_scope, unknownSelector) => {
    const kind = (unknownSelector as { readonly kind: string }).kind;
    return Effect.succeed(
      kind === "retro-report"
        ? { kind: "candidate", candidate: retroCandidate }
        : { kind: "candidate", candidate: taskCandidate },
    );
  });
  const persistent = toolkitLayerFor(service, { service: true, policy: true }).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
  );
  const run = (scope: McpInvocationContext.McpInvocationScope, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      return yield* server.callTool({ name: TOOL, arguments: args });
    }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
  return Effect.gen(function* () {
    const first = successBody(yield* run(scopeA, { selector: { ...taskSelector } }));
    assert.strictEqual(first.status, "candidate");
    assert.isNotNull(first.route);
    assert.strictEqual(first.route.role, "delivery");
    const second = successBody(yield* run(scopeB, { selector: { ...retroSelector } }));
    assert.strictEqual(second.status, "candidate");
    assert.isNotNull(second.route);
    assert.strictEqual(second.route.role, "retro");
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0]?.scope.thread?.threadId, threadA);
    assert.strictEqual(calls[1]?.scope.thread?.threadId, threadB);
    assert.deepStrictEqual(calls[0]?.selector, { ...taskSelector });
    assert.deepStrictEqual(calls[1]?.selector, { ...retroSelector });
  }).pipe(Effect.provide(persistent));
});

const strictCases: Array<readonly [string, Record<string, unknown>]> = [
  ["top-level scope", { selector: { ...taskSelector }, scope: { teamId: "other" } }],
  ["top-level team", { selector: { ...taskSelector }, teamId: "other" }],
  ["top-level role", { selector: { ...taskSelector }, role: "delivery" }],
  ["top-level proof", { selector: { ...taskSelector }, proof: "proof-bytes" }],
  ["nested selector scope", { selector: { ...taskSelector, scope: "other" } }],
  ["nested selector proof", { selector: { ...retroSelector, proof: "proof-bytes" } }],
  ["bad kind", { selector: { ...taskSelector, kind: "bogus" } }],
  ["negative counter", { selector: { ...taskSelector, attemptNumber: -1 } }],
  ["fractional counter", { selector: { ...taskSelector, resultRevision: 1.5 } }],
  ["unsafe counter", { selector: { ...taskSelector, attemptNumber: Number.MAX_SAFE_INTEGER + 1 } }],
  ["zero retro revision", { selector: { ...retroSelector, reportRevision: 0 } }],
  ["missing selector fields", { selector: { kind: "task-result" } }],
  ["missing selector", {}],
  ["129-char mission id", { selector: { ...taskSelector, missionId: longId } }],
  ["129-char checkpoint id", { selector: { ...retroSelector, checkpointId: longId } }],
];

it.effect.each(strictCases)("rejects %s at the SDK before any service call", (row) => {
  const calls: Array<Call> = [];
  const service = stubService(calls, () =>
    Effect.succeed({ kind: "hold", missionId, reason: "unknown_completion", detail: "unreached" }),
  );
  return Effect.gen(function* () {
    const rejection = yield* sdkRejectionOf(
      callVia(service, { service: true, policy: true }, scopeA, row[1]),
    );
    assert.isDefined(rejection);
    assert.strictEqual(rejection._tag, "InvalidParams");
    assert.strictEqual(calls.length, 0);
  });
});

it.effect("serializes a finite service failure without causes", () => {
  const calls: Array<Call> = [];
  const service = stubService(calls, () =>
    Effect.fail(
      new MissionMcp.MissionMcpFailure({
        code: "unavailable",
        message: "Completion route storage is unavailable.",
      }),
    ),
  );
  const gate = { service: true, policy: true };
  return Effect.gen(function* () {
    const body = declaredFailure(
      yield* callVia(service, gate, scopeA, { selector: { ...taskSelector } }),
    );
    assert.strictEqual(body.code, "unavailable");
    assert.notInclude(stableStringify(body), "cause");
    assert.strictEqual(calls.length, 1);
  });
});

it.effect("registers under an injected denial and returns it", () => {
  // Controlled denial only: the injected service unconditionally denies while
  // both dependencies are present, so the tool registers and the denial
  // arrives as a bounded failure. This proves nothing about live policy,
  // authority, or credentials.
  const calls: Array<Call> = [];
  const service = stubService(calls, () =>
    Effect.fail(
      new MissionMcp.MissionMcpFailure({
        code: "scope_denied",
        message: "The current completion manager is not authorized to read this route.",
      }),
    ),
  );
  const gate = { service: true, policy: true };
  return Effect.gen(function* () {
    const body = declaredFailure(
      yield* callVia(service, gate, scopeA, { selector: { ...taskSelector } }),
    );
    assert.strictEqual(body.code, "scope_denied");
    assert.strictEqual(calls.length, 1);
  });
});

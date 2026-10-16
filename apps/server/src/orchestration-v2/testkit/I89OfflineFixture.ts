/** Offline acceptance only. No listener, installed runtime, provider CLI, or credential store. */
import * as NodeAssert from "node:assert";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  Mission,
  MissionId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  TeamId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as MissionMcpRuntime from "../../mcp/MissionMcpRuntime.ts";
import * as ApplicationEvents from "../../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as MissionAdmissionStore from "../MissionAdmissionStore.ts";
import type { MissionAdmissionRequest } from "../MissionAdmission.ts";
import * as MissionResultStore from "../MissionResultStore.ts";
import * as MissionService from "../MissionService.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProjectStore from "../ProjectStore.ts";
import type { ProviderAdapterV2Event, ProviderAdapterV2Shape } from "../ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderRuntimeRecoveryService from "../ProviderRuntimeRecoveryService.ts";
import * as RuntimePolicy from "../RuntimePolicy.ts";
import * as ThreadManagementService from "../ThreadManagementService.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";

export const I89_BYTES = "No Fun I89 offline fixture v1\n";
export const I89_SHA256 = "6109fd2957d82793fa1f5b610049509a5df8c8c7da8f7f9abe101fee8a84d829";
const hash = (bytes: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const baseCommit = "8850dc58c78ce38f5e9cce7526e4b2d9f3581ddf";
const missionId = MissionId.make("combined-i89-offline-v1");
const projectId = ProjectId.make("i89-project");
const teamId = TeamId.make("i89-offline-team");
const environmentId = EnvironmentId.make("i89-offline-environment");
const manager = ThreadId.make("i89-delivery");
const outsider = ThreadId.make("i89-outsider");
const instanceId = ProviderInstanceId.make("i89-deterministic-executable");
const selection = { instanceId, model: "i89-node-v1" };
const driver = ProviderDriverKind.make("codex");
const authority = { teamId, environmentId, controllerThreadId: manager };
const authorityRef = { source: "mission-council", ref: "i89-offline-fixture-v1" } as const;
const decodeMission = Schema.decodeUnknownSync(Mission);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "i89-offline", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "i89-offline", version: "1" },
  },
  getClient: Effect.die("No network client in offline fixture"),
});
const call = (
  scope: McpInvocationContext.McpThreadInvocationScope,
  name: string,
  args: Record<string, unknown>,
) =>
  McpServer.McpServer.use((server) => server.callTool({ name, arguments: args })).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, client),
  );
const issue = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const issued = yield* registry.issue({ threadId, providerInstanceId: instanceId });
    const scope = yield* registry.resolve(issued.config.authorizationHeader.slice(7));
    NodeAssert.strict(scope);
    return scope;
  });
const body = <A>(result: McpSchema.CallToolResult): A => {
  NodeAssert.strict.equal(result.isError, false, JSON.stringify(result));
  return result.structuredContent as A;
};
const failureCode = (result: McpSchema.CallToolResult) => {
  NodeAssert.strict.equal(result.isError, true);
  const item = result.content[0];
  NodeAssert.strict(item?.type === "text");
  return (JSON.parse(item.text) as { code: string }).code;
};

/** Requires an existing owner-selected evidence directory; refuses symlinks and runtime homes. */
export async function runI89OfflineFixture(laneDirectory: string) {
  const lane = NodePath.resolve(laneDirectory);
  NodeAssert.strict.equal(
    await NodeFSP.realpath(lane),
    lane,
    "Lane must be a real directory, not a symlink",
  );
  NodeAssert.strict(!/(^|\/)\.(?:t3|nofun-t3)(\/|$)/.test(lane), "Runtime homes are forbidden");
  const directory = await NodeFSP.mkdtemp(NodePath.join(lane, "run-"));
  const workspace = NodePath.join(directory, "scratch");
  await NodeFSP.mkdir(workspace);
  const output = NodePath.join(workspace, "result.txt");
  const executor = NodePath.join(directory, "executor.cjs");
  const executorBytes = `const fs = require("node:fs");\nfs.writeFileSync(process.argv[2], ${JSON.stringify(I89_BYTES)}, { flag: "wx", mode: 0o600 });\n`;
  await NodeFSP.writeFile(executor, executorBytes, { mode: 0o600 });
  const executable = await NodeFSP.realpath(process.execPath);
  const config = {
    kind: "deterministic_executable",
    executable,
    executableSha256: hash(await NodeFSP.readFile(executable)),
    args: [executor, output],
    scriptSha256: hash(executorBytes),
    timeoutMs: 10000,
    maxOutputBytes: 65536,
    environment: {},
    expectedSha256: I89_SHA256,
  };
  await NodeFSP.writeFile(
    NodePath.join(directory, "executor.json"),
    JSON.stringify(config, null, 2),
    {
      mode: 0o600,
    },
  );
  const policyFile = NodePath.join(directory, "mission-mcp-policy.json");
  await NodeFSP.writeFile(
    policyFile,
    encodeJson({
      company: "nofun",
      companyVerified: true,
      bindingVerified: true,
      policyRef: "i89-offline-only",
      teamId,
      environmentId,
      allowedProjectIds: [projectId],
      bootstrapControllerThreadIds: [manager],
    }),
    { mode: 0o600 },
  );
  const databasePath = NodePath.join(directory, "statev2.sqlite");
  let workerStarts = 0;
  let association: MissionResultStore.MissionResultTrustedAssociation | undefined;
  let childThreadId: ThreadId | undefined;
  let savedResultCommand: MissionResultStore.MissionResultCommand | undefined;
  let admissionRequest: MissionAdmissionRequest | undefined;
  let delegatedCommand:
    | Extract<
        import("@t3tools/contracts").OrchestrationV2Command,
        { type: "delegated_task.request" }
      >
    | undefined;
  const receipts: Array<{ step: string; value: unknown }> = [];
  const record = (step: string, value: unknown) => {
    receipts.push({ step, value });
  };
  const now = Date.now();
  const facts = (): MissionAdmissionStore.MissionAdmissionTrustedFacts => ({
    taskNecessary: true,
    nowMs: now,
    teamId,
    environmentId,
    deliveryThreadId: manager,
    deliveryEpoch: 1,
    account: {
      accountId: "offline-fixture-account",
      providerInstanceId: instanceId,
      billingMode: "subscription",
      company: "No Fun",
      verifiedAtMs: now,
    },
    route: {
      accountId: "offline-fixture-account",
      providerInstanceId: instanceId,
      billingMode: "subscription",
      modelId: selection.model,
      profile: "default",
      capability: "writer",
      supportedModelIds: [selection.model],
    },
    usageLimits: {
      checkedAt: new Date(now).toISOString(),
      windows: [{ id: "five_hour", kind: "session", label: "fixture", usedPercent: 0 }],
    },
    usageMaxObservationAgeMs: 30000,
    host: {
      hostId: "i89-offline-host",
      bootId: "i89-offline-boot",
      ready: true,
      buildObserved: true,
      buildOk: true,
      toolchainObserved: true,
      toolchainOk: true,
      pressureObserved: true,
      pressureAcceptable: true,
      observedAtMs: now,
    },
    repository: {
      projectId,
      workspaceRootRealpath: workspace,
      observedAncestry: [baseCommit],
      observedAtMs: now,
    },
    writerScope: workspace,
    sharedManifestScopes: [],
    guiScopes: [],
    dependencyReceipts: [],
  });
  const makeLayer = () => {
    const database = Sqlite.layerFromPath(databasePath).pipe(Layer.provide(NodeServices.layer));
    const stores = Layer.mergeAll(ApplicationEvents.layer, Receipts.layer).pipe(
      Layer.provide(database),
    );
    const admission = MissionAdmissionStore.layer.pipe(
      Layer.provide(stores),
      Layer.provide(Layer.succeed(MissionService.MissionAuthority, authority)),
      Layer.provide(
        Layer.succeed(MissionAdmissionStore.MissionAdmissionFactsPort, {
          readFacts: () => Effect.succeed(facts()),
        }),
      ),
      Layer.provide(database),
    );
    const resultStore = MissionResultStore.layer.pipe(
      Layer.provide(stores),
      Layer.provide(Layer.succeed(MissionService.MissionAuthority, authority)),
      Layer.provide(
        Layer.succeed(MissionResultStore.MissionResultFactsPort, {
          readFacts: () =>
            Effect.sync(() => {
              NodeAssert.strict(association);
              return {
                ...authority,
                deliveryThreadId: manager,
                deliveryEpoch: 1,
                nowMs: now,
                association,
                observation: {
                  childTaskId: association.childTaskId,
                  childThreadId: association.childThreadId,
                  childRunId: association.childRunId,
                  resultRevision: 1,
                  pendingChildRuns: false,
                  stage: "observed" as const,
                },
              };
            }),
        }),
      ),
      Layer.provide(database),
    );
    const adapter: ProviderAdapterV2Shape = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (input) =>
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
          const date = yield* DateTime.now;
          return {
            instanceId,
            driver,
            providerSessionId: input.providerSessionId,
            providerSession: {
              id: input.providerSessionId,
              driver,
              providerInstanceId: instanceId,
              status: "ready",
              cwd: workspace,
              model: selection.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: date,
              updatedAt: date,
              lastError: null,
            },
            events: Stream.fromQueue(events),
            ensureThread: ({ threadId }) =>
              Effect.succeed({
                id: ProviderThreadId.make(`i89-provider:${threadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: `i89:${threadId}`, strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: date,
                updatedAt: date,
              }),
            resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
            startTurn: (turn) =>
              Effect.gen(function* () {
                if (turn.threadId === manager) return; // synthetic parent stays open; no executor or model
                NodeAssert.strict.equal(turn.threadId, childThreadId);
                NodeAssert.strict.equal(++workerStarts, 1, "Worker must execute once");
                NodeAssert.strict.equal(hash(NodeFS.readFileSync(executor)), config.scriptSha256);
                NodeAssert.strict.equal(
                  hash(NodeFS.readFileSync(executable)),
                  config.executableSha256,
                );
                NodeChildProcess.execFileSync(executable, config.args, {
                  cwd: workspace,
                  env: {},
                  timeout: config.timeoutMs,
                  maxBuffer: config.maxOutputBytes,
                  stdio: "pipe",
                });
                NodeAssert.strict.equal(hash(NodeFS.readFileSync(output)), I89_SHA256);
                const providerTurnId = ProviderTurnId.make(`i89-turn:${turn.attemptId}`);
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turn.providerThread.id,
                    nodeId: turn.rootNodeId,
                    runAttemptId: turn.attemptId,
                    nativeTurnRef: {
                      driver,
                      nativeId: `i89:${turn.attemptId}`,
                      strength: "strong",
                    },
                    ordinal: turn.providerTurnOrdinal,
                    status: "completed",
                    startedAt: date,
                    completedAt: date,
                  },
                });
                yield* Queue.offer(events, {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId,
                  runOrdinal: turn.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                });
              }),
            steerTurn: () => Effect.void,
            interruptTurn: () => Effect.void,
            respondToRuntimeRequest: () => Effect.void,
            readThreadSnapshot: () => Effect.die("No native snapshot"),
            rollbackThread: () => Effect.die("No rollback"),
            forkThread: () => Effect.die("No native fork"),
          };
        }),
    };
    const replay = ProviderReplayHarness.layerWithRegistry(
      { name: "i89-offline" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      {
        databaseLayer: database,
        baseDirectory: NodePath.join(directory, "server"),
        runEffectWorker: false,
      },
    ).pipe(Layer.provideMerge(admission));
    const configLayer = ServerConfig.layerTest(workspace, NodePath.join(directory, "server")).pipe(
      Layer.provide(NodeServices.layer),
    );
    const infrastructure = Layer.mergeAll(
      database,
      stores,
      ProjectionStore.layer.pipe(Layer.provide(database)),
      ProjectStore.layer.pipe(Layer.provide(database)),
      configLayer,
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(environmentId),
        getDescriptor: Effect.die("Offline fixture"),
      }),
      Layer.succeed(HttpServer.HttpServer, {
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 1),
        serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
      }),
      NodeServices.layer,
    );
    const registry = McpSessionRegistry.layer.pipe(Layer.provide(infrastructure));
    const missionRuntime = MissionMcpRuntime.layer.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { T3CODE_NOFUN_MISSION_POLICY_FILE: policyFile } }),
        ),
      ),
      Layer.provideMerge(registry),
      Layer.provideMerge(infrastructure),
    );
    const toolkit = MissionMcpRuntime.layerOptionalToolkits.pipe(
      Layer.provideMerge(missionRuntime),
      Layer.provideMerge(McpServer.McpServer.layer),
    );
    const threadService = ThreadManagementService.layer.pipe(
      Layer.provideMerge(replay),
      Layer.provideMerge(RuntimePolicy.layer),
    );
    const recovery = ProviderRuntimeRecoveryService.layer.pipe(
      Layer.provide(EffectOutbox.layer.pipe(Layer.provide(database))),
      Layer.provide(IdAllocator.layer),
      Layer.provide(ProjectionStore.layer.pipe(Layer.provide(database))),
      Layer.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false })),
      Layer.provide(replay),
    );
    return Layer.mergeAll(toolkit, threadService, resultStore, recovery).pipe(
      Layer.provideMerge(infrastructure),
    );
  };
  const readMission = (scope: McpInvocationContext.McpThreadInvocationScope) =>
    call(scope, "mission_get", { id: missionId }).pipe(
      Effect.map((result) => {
        const value = body<{ status: string; mission: unknown }>(result);
        NodeAssert.strict.equal(value.status, "found");
        return decodeMission(value.mission);
      }),
    );
  const counts = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ events: number; receipts: number }>`SELECT
      (SELECT COUNT(*) FROM orchestration_events) AS events,
      (SELECT COUNT(*) FROM orchestration_command_receipts) AS receipts`;
  });
  let originalCreate: Record<string, unknown> | undefined;
  let acceptedRevision = 0;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make("i89-project-created"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: new Date(now).toISOString(),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "I89 offline only",
            workspaceRoot: workspace,
            defaultModelSelection: null,
            scripts: [],
            createdAt: new Date(now).toISOString(),
            updatedAt: new Date(now).toISOString(),
          },
        });
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        for (const threadId of [manager, outsider])
          yield* threads.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create:${threadId}`),
            threadId,
            projectId,
            title: threadId,
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: workspace,
            createdBy: "user",
            creationSource: "web",
          });
        const scope = yield* issue(manager);
        record("mission_get:missing", body(yield* call(scope, "mission_get", { id: missionId })));
        const mission = decodeMission({
          schemaVersion: 1,
          id: missionId,
          revision: 0,
          teamId,
          authorityEnvironmentId: environmentId,
          bindings: [{ projectId, workspaceRoot: workspace, baseCommit, ancestry: [baseCommit] }],
          intent: {
            outcome: "Produce one exact scratch file offline",
            scope: [workspace],
            exclusions: ["installed runtime", "network", "models", "credentials"],
            authorityRefs: [authorityRef],
            acceptanceCriteria: [{ id: "exact-hash", text: `result.txt SHA-256 ${I89_SHA256}` }],
            decisions: [],
          },
          integrationTarget: { summary: "Scratch output only; no integration or install" },
          managers: { delivery: { threadId: manager, epoch: 1 } },
          status: "active",
          tasks: [
            {
              id: "one",
              projectId,
              title: "Write exact fixture bytes",
              specHash: hash(I89_BYTES),
              dependencyHashes: [],
              dependencies: [],
              acceptanceIds: ["exact-hash"],
              updatedAt: new Date(now).toISOString(),
            },
          ],
          updatedAt: new Date(now).toISOString(),
        });
        originalCreate = { type: "mission.create", commandId: "i89:create", mission };
        record(
          "mission_execute:create",
          body(yield* call(scope, "mission_execute", originalCreate)),
        );
        const beforeReplay = yield* counts;
        const replay = body<{ committed: boolean }>(
          yield* call(scope, "mission_execute", originalCreate),
        );
        NodeAssert.strict.equal(replay.committed, false);
        NodeAssert.strict.deepEqual(yield* counts, beforeReplay);
        record("mission_execute:exact-replay", replay);
        const beforeDenial = yield* counts;
        const outsiderScope = yield* issue(outsider);
        const denial = failureCode(yield* call(outsiderScope, "mission_get", { id: missionId }));
        NodeAssert.strict.equal(denial, "scope_denied");
        NodeAssert.strict.deepEqual(yield* counts, beforeDenial);
        record("unrelated-thread:denied", { code: denial });
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("i89:parent"),
          threadId: manager,
          messageId: MessageId.make("i89:parent-message"),
          text: "Offline synthetic parent; admit exactly one child",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const parent = yield* threads.getThreadProjection(manager);
        const parentRun = parent.runs[0]!;
        delegatedCommand = {
          type: "delegated_task.request",
          commandId: CommandId.make("i89:delegate"),
          parentThreadId: manager,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "Write the pinned I89 fixture bytes to result.txt only",
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "agent",
          creationSource: "mcp",
          workspaceBinding: { branch: "i89-offline", worktreePath: workspace },
        };
        admissionRequest = {
          mission,
          taskId: "one",
          specHash: hash(I89_BYTES),
          dependencyHashes: [],
          attempt: { attemptNumber: 1, operation: "write" },
          proposedAccountId: "offline-fixture-account",
          proposedProviderInstanceId: instanceId,
          proposedBillingMode: "subscription",
          modelId: selection.model,
          profile: "default",
          promptHash: "bound-by-dispatch",
          optionsHash: "bound-by-dispatch",
          workspaceRoot: workspace,
          privilege: "full-access",
          rejectedRoutes: [],
        };
        const dispatched = yield* threads.dispatch(delegatedCommand, {
          missionAdmissionRequest: admissionRequest,
        });
        const after = yield* threads.getThreadProjection(manager);
        const childTask = after.subagents[0]!;
        childThreadId = childTask.childThreadId!;
        NodeAssert.strict(childThreadId);
        let canonical = yield* readMission(scope);
        NodeAssert.strict.equal(canonical.execution?.admissions.length, 1);
        record("worker:admitted", {
          dispatch: dispatched,
          admission: canonical.execution!.admissions[0],
          childTaskId: childTask.id,
          childThreadId,
        });
        const terminal = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run-attempt.updated" &&
              event.threadId === childThreadId &&
              event.payload.status === "completed",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* worker.drain();
        yield* Fiber.join(terminal);
        yield* worker.drain();
        const child = yield* threads.getThreadProjection(childThreadId);
        const run = child.runs[0]!;
        NodeAssert.strict.equal(run.status, "completed");
        NodeAssert.strict.equal(workerStarts, 1);
        const admission = canonical.execution!.admissions[0]!;
        association = {
          childTaskId: childTask.id,
          childThreadId,
          childRunId: run.id,
          requiredAncestry: [baseCommit],
          initialCommitSet: [baseCommit],
          initialAncestry: [baseCommit],
          source: "i89-deterministic-executor",
          sourceRef: `sha256:${I89_SHA256}`,
          initialResultRevision: 1,
          digests: MissionResultStore.canonicalResultDigests(canonical, "one")!,
          admissionDispatchKey: admission.dispatchKey,
          admissionRequestDigest: admission.requestDigest,
          attemptNumber: 1,
          pendingChildRuns: false,
        };
        record("worker:completed", {
          run,
          output,
          sha256: hash(NodeFS.readFileSync(output)),
          workerStarts,
        });
        const resultStore = yield* MissionResultStore.MissionResultStore;
        for (const action of [
          "initialize",
          "observe",
          "mailbox_ack",
          "review",
          "accept",
        ] as const) {
          canonical = yield* readMission(scope);
          const command: MissionResultStore.MissionResultCommand = {
            commandId: CommandId.make(`i89:result:${action}`),
            missionId,
            expectedRevision: canonical.revision,
            deliveryEpoch: 1,
            taskId: "one",
            dispatchKey: admission.dispatchKey,
            action,
            ...(action === "initialize"
              ? { summaryText: `result.txt sha256:${I89_SHA256}`, outcome: "completed" as const }
              : {}),
            ...(action === "review" || action === "accept"
              ? {
                  receipt: {
                    kind: action === "review" ? ("review" as const) : ("acceptance" as const),
                    revision: 1,
                    commitSet: [baseCommit],
                    evidenceKind: "check_pass",
                    evidenceRef: `sha256:${I89_SHA256}`,
                    decidedBy: manager,
                    decidedAt: new Date(now).toISOString(),
                  },
                }
              : {}),
          };
          const result = yield* resultStore.execute(command);
          NodeAssert.strict(Result.isSuccess(result), JSON.stringify(result));
          record(`result:${action}`, result.success);
          if (action === "initialize") savedResultCommand = command;
        }
        const accepted = yield* readMission(scope);
        NodeAssert.strict.equal(accepted.execution!.results![0]!.state, "accepted");
        acceptedRevision = accepted.revision;
        record("before-restart", { revision: acceptedRevision, counts: yield* counts });
      }).pipe(Effect.provide(makeLayer())),
    ),
  );

  // A new scope, registry, SQL connection, orchestrator and provider manager over the same file.
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
        record("restart:runtime-recovery", yield* recovery.recover);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.recoverDelegatedTasks;
        const scope = yield* issue(manager);
        const before = yield* readMission(scope);
        NodeAssert.strict.equal(before.revision, acceptedRevision);
        const beforeReplay = yield* counts;
        NodeAssert.strict(
          originalCreate &&
            admissionRequest &&
            delegatedCommand &&
            savedResultCommand &&
            childThreadId,
        );
        const createReplay = body<{ committed: boolean }>(
          yield* call(scope, "mission_execute", originalCreate),
        );
        NodeAssert.strict.equal(createReplay.committed, false);
        record("restart:mission-create-replay", createReplay);
        const threads = yield* ThreadManagementService.ThreadManagementService;
        yield* threads.dispatch(delegatedCommand, { missionAdmissionRequest: admissionRequest });
        const results = yield* MissionResultStore.MissionResultStore;
        const replayed = yield* results.execute(savedResultCommand);
        NodeAssert.strict(Result.isSuccess(replayed));
        NodeAssert.strict.equal(replayed.success.recovered, true);
        NodeAssert.strict.equal(replayed.success.committed, false);
        NodeAssert.strict.deepEqual(yield* counts, beforeReplay);
        NodeAssert.strict.deepEqual(yield* readMission(scope), before);
        NodeAssert.strict.equal(workerStarts, 1);
        record("restart:lost-reply-replays", {
          result: replayed.success,
          counts: yield* counts,
          workerStarts,
          revision: before.revision,
        });
        const drift = yield* threads
          .dispatch(
            { ...delegatedCommand, task: "Changed task must not execute" },
            { missionAdmissionRequest: admissionRequest },
          )
          .pipe(Effect.result);
        NodeAssert.strict(Result.isFailure(drift));
        NodeAssert.strict.deepEqual(yield* counts, beforeReplay);
        record("restart:changed-command-denied", { denied: true });
        const childScope = yield* issue(childThreadId);
        const childDenial = failureCode(yield* call(childScope, "mission_get", { id: missionId }));
        NodeAssert.strict.equal(childDenial, "scope_denied");
        record("worker:bootstrap-not-inherited", { childThreadId, code: childDenial });
        const selector = {
          kind: "task-result",
          missionId,
          taskId: "one",
          attemptNumber: 1,
          resultRevision: 1,
        };
        const route = body<{ status: string; holdReason: string }>(
          yield* call(scope, "mission_completion_route_read", { selector }),
        );
        // Diagnostic only: a held P3 pointer never counts as delivery or acceptance.
        // Keep the response in evidence without making a known routing defect a gate.
        NodeAssert.strict.ok(route.status === "candidate" || route.status === "hold");
        record("delivery-manager:completion-route", route);
        record("final-mission", before);
        const sql = yield* SqlClient.SqlClient;
        record(
          "durable-receipts",
          yield* sql`SELECT command_id, aggregate_kind, aggregate_id, command_type, result_sequence, status, request_hash FROM orchestration_command_receipts ORDER BY command_id`,
        );
        NodeAssert.strict.equal(workerStarts, 1);
      }).pipe(Effect.provide(makeLayer())),
    ),
  );
  await NodeFSP.writeFile(
    NodePath.join(directory, "fixture-inputs.json"),
    JSON.stringify(
      {
        originalCreate,
        delegatedCommand,
        admissionRequest,
        savedResultCommand,
        syntheticFacts: facts(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  const receipt = {
    schemaVersion: 1,
    status: "PASS",
    boundary: "offline-in-process-services-with-deterministic-adapter",
    directory,
    databasePath,
    baseCommit,
    fixtureSourceSha256: hash(await NodeFSP.readFile(import.meta.filename)),
    limits: [
      "Synthetic admission facts and deterministic adapter; no subscription identity or quota proof",
      "Result mailbox_ack is an explicit store command, not an app mailbox consumer ACK",
      "Completion routing holds malformed_input for the real mission-bound child IDs",
      "No role transfer, installed build, live provider, two-host, or crash-during-execution proof",
    ],
    executable: config,
    workerStarts,
    receipts,
  };
  await NodeFSP.writeFile(
    NodePath.join(directory, "receipts.json"),
    JSON.stringify(receipt, null, 2),
    {
      mode: 0o600,
    },
  );
  return receipt;
}

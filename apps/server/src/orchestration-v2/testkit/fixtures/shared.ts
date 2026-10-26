import { assert } from "@effect/vitest";
import {
  type ChatAttachment,
  CommandId,
  isOrchestrationV2WorkActive,
  MessageId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RunStatus,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserMessageInputIntent,
  ProviderInstanceId,
  type ProviderInteractionMode,
  type ProviderDriverKind,
  type ProviderReplayTranscript,
  type ProviderUserInputAnswers,
  type RuntimeMode,
} from "@t3tools/contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type {
  OrchestratorV2ScenarioResult,
  OrchestratorV2ScenarioStep,
} from "../OrchestratorScenario.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { RuntimePolicyV2Override } from "../../RuntimePolicy.ts";

export const SIMPLE_PROMPT = "Respond with the following text: fixture simple ok";
export const MULTI_TURN_FIRST_PROMPT = "Respond with exactly: first fixture turn complete";
export const MULTI_TURN_SECOND_PROMPT = "Respond with exactly: second fixture turn complete";
export const PROVIDER_THREAD_RESUME_FIRST_PROMPT =
  "Respond with exactly: provider thread resume fixture first turn complete";
export const PROVIDER_THREAD_RESUME_SECOND_PROMPT =
  "Using the conversation history available in this resumed thread, first repeat the exact final answer you gave in the previous turn. Then on a new line write exactly: provider thread resume fixture second turn complete";
export const MESSAGE_STEERING_INITIAL_PROMPT =
  "Respond with exactly: steering fixture initial response";
export const TURN_INTERRUPT_MID_TOOL_PROMPT =
  "Run this exact local command: `node -e \"console.log('interrupt fixture tool started'); setTimeout(() => {}, 30000)\"`. Do not answer until it completes, then respond exactly: interrupt fixture should not finish naturally.";
export const MESSAGE_STEERING_STEER_PROMPT =
  "Actually, respond with exactly: steering fixture observed";
export const THREAD_ROLLBACK_FIRST_PROMPT =
  "Respond with exactly: rollback fixture first turn complete";
export const THREAD_ROLLBACK_SECOND_PROMPT =
  "Respond with exactly: rollback fixture second turn complete";
export const THREAD_ROLLBACK_AFTER_PROMPT = "Repeat the conversation verbatim.";

export type OrchestratorFixtureInputStep =
  | {
      readonly type: "message";
      readonly text: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
    }
  | {
      readonly type: "queue_message";
      readonly text: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly createdBy?: Extract<
        OrchestrationV2Command,
        { readonly type: "message.dispatch" }
      >["createdBy"];
      readonly creationSource?: Extract<
        OrchestrationV2Command,
        { readonly type: "message.dispatch" }
      >["creationSource"];
    }
  | {
      readonly type: "cancel_queued_run";
      readonly targetRunIndex: number;
    }
  | {
      readonly type: "await_run_status";
      readonly targetRunIndex: number;
      readonly status: OrchestrationV2RunStatus;
      readonly waitForTurnItemType?: OrchestrationV2TurnItem["type"];
    }
  | {
      /** Replay finishes background-held runs through the adapter's debounce receipt. */
      readonly type: "finish_held_run";
      readonly targetRunIndex: number;
      readonly status: OrchestrationV2RunStatus;
    }
  | {
      readonly type: "capture_shell_snapshot";
      readonly key: string;
    }
  | {
      readonly type: "release_replay_gate";
      readonly label: string;
    }
  | {
      readonly type: "steer";
      readonly text: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly targetRunIndex: number;
    }
  | {
      readonly type: "restart";
      readonly text: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly targetRunIndex: number;
    }
  | {
      readonly type: "interrupt";
      readonly targetRunIndex: number;
      readonly waitForTurnItemType?: OrchestrationV2TurnItem["type"];
    }
  | {
      readonly type: "stop_background_work";
      readonly targetRunIndex: number;
    }
  | {
      readonly type: "release_replay_gate_after_waiting";
      readonly label: string;
      readonly targetRunIndex: number;
    }
  | {
      readonly type: "approve_next_runtime_request";
      readonly decision?: Extract<
        OrchestrationV2Command,
        { readonly type: "runtime-request.respond" }
      >["decision"];
      readonly shellSnapshotKeyWhilePending?: string;
    }
  | {
      readonly type: "answer_next_user_input_request";
      readonly answers: ProviderUserInputAnswers;
    }
  | {
      readonly type: "rollback";
      readonly checkpointScopeSuffix: string;
      readonly checkpointSuffix: string;
    }
  | {
      readonly type: "advance_clock";
      readonly duration: Duration.Input;
    };

export interface OrchestratorFixtureInput {
  readonly interactionMode?: ProviderInteractionMode;
  readonly runtimeMode?: RuntimeMode;
  /** Files committed before replay, keyed by relative path; seed the same files when recording so workspace reads match. */
  readonly workspaceFiles?: Readonly<Record<string, string>>;
  readonly steps: ReadonlyArray<OrchestratorFixtureInputStep>;
}

export interface ProviderOrchestratorReplayVariant {
  readonly driver: ProviderDriverKind;
  readonly transcriptFile: URL;
  readonly recordedScenario?: string;
  readonly transcriptEntriesThroughLabel?: string;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicyOverride?: RuntimePolicyV2Override;
  readonly runContinuationWorker?: boolean;
  readonly expectedAbsentWorkspacePaths?: ReadonlyArray<string>;
  readonly assertOutput: (
    result: OrchestratorV2ScenarioResult,
    transcript: ProviderReplayTranscript,
  ) => void;
}

export interface OrchestratorReplayFixture {
  readonly name: string;
  readonly buildInput: () => OrchestratorFixtureInput;
  readonly providers: ReadonlyArray<ProviderOrchestratorReplayVariant>;
}

export interface MaterializedOrchestratorFixtureInput {
  readonly commands: ReadonlyArray<OrchestrationV2Command>;
  readonly steps: ReadonlyArray<OrchestratorV2ScenarioStep>;
  readonly projectionThreadIds: ReadonlyArray<ThreadId>;
}

export interface FixtureIds {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}

export const PI_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("pi"),
  model: "openrouter/deepseek/deepseek-v4-flash",
} satisfies ModelSelection;

function createThreadCommand(input: {
  readonly commandId: CommandId;
  readonly ids: FixtureIds;
  readonly scenario: string;
  readonly modelSelection: ModelSelection;
  readonly interactionMode?: ProviderInteractionMode;
  readonly runtimeMode?: RuntimeMode;
}): OrchestrationV2Command {
  return {
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: input.commandId,
    threadId: input.ids.threadId,
    projectId: input.ids.projectId,
    title: `Replay fixture: ${input.scenario}`,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: input.interactionMode ?? "default",
    branch: null,
    worktreePath: null,
  };
}

function dispatchMessageCommand(input: {
  readonly commandId: CommandId;
  readonly ids: FixtureIds;
  readonly modelSelection: ModelSelection;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly createdBy?: Extract<
    OrchestrationV2Command,
    { readonly type: "message.dispatch" }
  >["createdBy"];
  readonly creationSource?: Extract<
    OrchestrationV2Command,
    { readonly type: "message.dispatch" }
  >["creationSource"];
  readonly dispatchMode?: Extract<
    OrchestrationV2Command,
    { readonly type: "message.dispatch" }
  >["dispatchMode"];
}): OrchestrationV2Command {
  return {
    type: "message.dispatch",
    createdBy: input.createdBy ?? "user",
    creationSource: input.creationSource ?? "web",
    commandId: input.commandId,
    threadId: input.ids.threadId,
    messageId: input.messageId,
    text: input.text,
    attachments: [...(input.attachments ?? [])],
    modelSelection: input.modelSelection,
    dispatchMode: input.dispatchMode ?? { type: "start_immediately" },
  };
}

export function materializeFixtureInput(input: {
  readonly scenario: string;
  readonly fixtureInput: OrchestratorFixtureInput;
  readonly driver: ProviderDriverKind;
  readonly modelSelection: ModelSelection;
}): Effect.Effect<
  MaterializedOrchestratorFixtureInput,
  IdAllocator.IdAllocatorV2Error,
  IdAllocator.IdAllocatorV2
> {
  return Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const projectId = yield* idAllocator.allocate.project({ fixtureName: input.scenario });
    const threadId = yield* idAllocator.allocate.thread({
      fixtureName: input.scenario,
      projectId,
    });
    const ids = { threadId, projectId } satisfies FixtureIds;
    const commands: Array<OrchestrationV2Command> = [];
    const steps: Array<OrchestratorV2ScenarioStep> = [];
    let messageIndex = 0;
    let runIndex = 0;
    const activeRunDispatchKeys = new Set<string>();

    const runIdFor = (runOrdinal: number) =>
      idAllocator.derive.run({ threadId: ids.threadId, ordinal: runOrdinal });

    const pushDispatch = (
      command: OrchestrationV2Command,
      options: {
        readonly await?: boolean;
        readonly key?: string;
        readonly advanceClockAfter?: boolean;
      } = {},
    ) => {
      commands.push(command);
      steps.push({
        type: "dispatch",
        command,
        await: options.await ?? true,
        ...(options.key === undefined ? {} : { key: options.key }),
      });
      if (options.advanceClockAfter ?? true) {
        steps.push({ type: "advance_clock", duration: "1 millis" });
      }
    };

    pushDispatch(
      createThreadCommand({
        commandId: yield* idAllocator.allocate.command({
          fixtureName: input.scenario,
          commandName: "thread-create",
        }),
        ids,
        scenario: input.scenario,
        modelSelection: input.modelSelection,
        ...(input.fixtureInput.interactionMode === undefined
          ? {}
          : { interactionMode: input.fixtureInput.interactionMode }),
        ...(input.fixtureInput.runtimeMode === undefined
          ? {}
          : { runtimeMode: input.fixtureInput.runtimeMode }),
      }),
    );

    // Multiple requests keep runs busy between answers; wait for each request, not thread idle.
    const answersNext = (stepIndex: number) => {
      const next = input.fixtureInput.steps[stepIndex + 1]?.type;
      return next === "approve_next_runtime_request" || next === "answer_next_user_input_request";
    };
    for (const [stepIndex, step] of input.fixtureInput.steps.entries()) {
      switch (step.type) {
        case "message":
          messageIndex += 1;
          runIndex += 1;
          {
            const nextStep = input.fixtureInput.steps[stepIndex + 1];
            const shouldRunInBackground =
              (nextStep !== undefined &&
                ((nextStep.type === "interrupt" && nextStep.targetRunIndex === runIndex) ||
                  nextStep.type === "queue_message" ||
                  (nextStep.type === "restart" && nextStep.targetRunIndex === runIndex) ||
                  (nextStep.type === "release_replay_gate_after_waiting" &&
                    nextStep.targetRunIndex === runIndex) ||
                  // Continuations start while busy; waiting for idle would deadlock.
                  (nextStep.type === "await_run_status" && nextStep.targetRunIndex > runIndex) ||
                  // Held open until the test clock moves, so it cannot go idle first.
                  nextStep.type === "finish_held_run")) ||
              nextStep?.type === "approve_next_runtime_request" ||
              nextStep?.type === "answer_next_user_input_request";
            const key = `run:${runIndex}`;
            pushDispatch(
              dispatchMessageCommand({
                commandId: yield* idAllocator.allocate.command({
                  fixtureName: input.scenario,
                  commandName: `message-${messageIndex}`,
                }),
                ids,
                modelSelection: input.modelSelection,
                messageId: yield* idAllocator.allocate.message({
                  threadId: ids.threadId,
                  ordinal: messageIndex,
                }),
                text: step.text,
                ...(step.attachments === undefined ? {} : { attachments: step.attachments }),
              }),
              shouldRunInBackground ? { await: false, key } : undefined,
            );
            if (shouldRunInBackground) {
              activeRunDispatchKeys.add(key);
            } else if (
              !(
                nextStep !== undefined &&
                (nextStep.type === "steer" || nextStep.type === "restart") &&
                nextStep.targetRunIndex === runIndex
              )
            ) {
              steps.push({ type: "await_thread_idle", threadId: ids.threadId });
            }
          }
          break;
        case "queue_message": {
          messageIndex += 1;
          runIndex += 1;
          const nextStep = input.fixtureInput.steps[stepIndex + 1];
          pushDispatch(
            dispatchMessageCommand({
              commandId: yield* idAllocator.allocate.command({
                fixtureName: input.scenario,
                commandName: `queue-message-${messageIndex}`,
              }),
              ids,
              modelSelection: input.modelSelection,
              messageId: yield* idAllocator.allocate.message({
                threadId: ids.threadId,
                ordinal: messageIndex,
              }),
              text: step.text,
              ...(step.createdBy === undefined ? {} : { createdBy: step.createdBy }),
              ...(step.creationSource === undefined ? {} : { creationSource: step.creationSource }),
              ...(step.attachments === undefined ? {} : { attachments: step.attachments }),
              dispatchMode: { type: "queue_after_active" },
            }),
          );
          const shouldSkipQueueBarrier =
            nextStep?.type === "queue_message" ||
            (nextStep?.type === "cancel_queued_run" && nextStep.targetRunIndex === runIndex);
          if (!shouldSkipQueueBarrier) {
            const queueBarrierKey =
              Array.from(activeRunDispatchKeys).at(-1) ?? `run:${runIndex - 1}`;
            activeRunDispatchKeys.delete(queueBarrierKey);
            steps.push({ type: "await", key: queueBarrierKey });
            steps.push({ type: "await_thread_idle", threadId: ids.threadId });
          }
          break;
        }
        case "cancel_queued_run":
          pushDispatch({
            type: "queued-run.cancel",
            commandId: yield* idAllocator.allocate.command({
              fixtureName: input.scenario,
              commandName: `cancel-queued-run-${step.targetRunIndex}`,
            }),
            threadId: ids.threadId,
            runId: runIdFor(step.targetRunIndex),
          });
          break;
        case "await_run_status":
          steps.push({
            type: "await_run_status",
            threadId: ids.threadId,
            runId: runIdFor(step.targetRunIndex),
            status: step.status,
          });
          if (step.waitForTurnItemType !== undefined) {
            steps.push({
              type: "await_run_turn_item",
              threadId: ids.threadId,
              runId: runIdFor(step.targetRunIndex),
              itemType: step.waitForTurnItemType,
            });
          }
          break;
        case "finish_held_run":
          steps.push({
            type: "finish_held_run",
            threadId: ids.threadId,
            runId: runIdFor(step.targetRunIndex),
            status: step.status,
          });
          break;
        case "capture_shell_snapshot":
          steps.push({ type: "capture_shell_snapshot", key: step.key });
          break;
        case "release_replay_gate":
          steps.push({ type: "release_replay_gate", label: step.label });
          break;
        case "answer_next_user_input_request":
          pushDispatch(
            {
              type: "runtime-request.respond",
              commandId: yield* idAllocator.allocate.command({
                fixtureName: input.scenario,
                commandName: `answer-user-input-request-${messageIndex}`,
              }),
              threadId: ids.threadId,
              requestId: yield* idAllocator.allocate.runtimeRequest({
                driver: input.driver,
                nativeRequestId: `fixture-placeholder-${messageIndex}`,
              }),
              answers: step.answers,
            },
            { advanceClockAfter: false },
          );
          steps[steps.length - 1] = {
            type: "respond_to_next_runtime_request",
            threadId: ids.threadId,
            commandId: commands.at(-1)!.commandId,
            answers: step.answers,
          };
          steps.push({ type: "advance_clock", duration: "1 millis" });
          if (!answersNext(stepIndex)) {
            steps.push({ type: "await_thread_idle", threadId: ids.threadId });
          }
          break;
        case "approve_next_runtime_request":
          pushDispatch(
            {
              type: "runtime-request.respond",
              commandId: yield* idAllocator.allocate.command({
                fixtureName: input.scenario,
                commandName: `approve-runtime-request-${messageIndex}`,
              }),
              threadId: ids.threadId,
              requestId: yield* idAllocator.allocate.runtimeRequest({
                driver: input.driver,
                nativeRequestId: `fixture-placeholder-${messageIndex}`,
              }),
              decision: step.decision ?? "accept",
            },
            { advanceClockAfter: false },
          );
          steps[steps.length - 1] = {
            type: "respond_to_next_runtime_request",
            threadId: ids.threadId,
            commandId: commands.at(-1)!.commandId,
            decision: step.decision ?? "accept",
            ...(step.shellSnapshotKeyWhilePending === undefined
              ? {}
              : { shellSnapshotKeyWhilePending: step.shellSnapshotKeyWhilePending }),
          };
          steps.push({ type: "advance_clock", duration: "1 millis" });
          if (!answersNext(stepIndex)) {
            steps.push({ type: "await_thread_idle", threadId: ids.threadId });
          }
          break;
        case "steer":
          messageIndex += 1;
          steps.push({
            type: "await_run_steerable",
            threadId: ids.threadId,
            runId: runIdFor(step.targetRunIndex),
          });
          pushDispatch(
            dispatchMessageCommand({
              commandId: yield* idAllocator.allocate.command({
                fixtureName: input.scenario,
                commandName: `steer-${messageIndex}`,
              }),
              ids,
              modelSelection: input.modelSelection,
              messageId: yield* idAllocator.allocate.message({
                threadId: ids.threadId,
                ordinal: messageIndex,
              }),
              text: step.text,
              ...(step.attachments === undefined ? {} : { attachments: step.attachments }),
              dispatchMode: {
                type: "steer_active",
                targetRunId: runIdFor(step.targetRunIndex),
              },
            }),
          );
          {
            const nextStepType = input.fixtureInput.steps[stepIndex + 1]?.type;
            if (
              nextStepType !== "approve_next_runtime_request" &&
              nextStepType !== "answer_next_user_input_request"
            ) {
              if (activeRunDispatchKeys.delete(`run:${step.targetRunIndex}`)) {
                steps.push({ type: "await", key: `run:${step.targetRunIndex}` });
              }
              steps.push({ type: "await_thread_idle", threadId: ids.threadId });
            }
          }
          break;
        case "restart":
          messageIndex += 1;
          steps.push({
            type: "await_run_steerable",
            threadId: ids.threadId,
            runId: runIdFor(step.targetRunIndex),
          });
          pushDispatch(
            dispatchMessageCommand({
              commandId: yield* idAllocator.allocate.command({
                fixtureName: input.scenario,
                commandName: `restart-${messageIndex}`,
              }),
              ids,
              modelSelection: input.modelSelection,
              messageId: yield* idAllocator.allocate.message({
                threadId: ids.threadId,
                ordinal: messageIndex,
              }),
              text: step.text,
              ...(step.attachments === undefined ? {} : { attachments: step.attachments }),
              dispatchMode: {
                type: "restart_active",
                targetRunId: runIdFor(step.targetRunIndex),
              },
            }),
          );
          {
            const nextStepType = input.fixtureInput.steps[stepIndex + 1]?.type;
            if (
              nextStepType !== "approve_next_runtime_request" &&
              nextStepType !== "answer_next_user_input_request"
            ) {
              if (activeRunDispatchKeys.delete(`run:${step.targetRunIndex}`)) {
                steps.push({ type: "await", key: `run:${step.targetRunIndex}` });
              }
              steps.push({ type: "await_thread_idle", threadId: ids.threadId });
            }
          }
          break;
        case "interrupt":
          steps.push({
            type: "await_run_steerable",
            threadId: ids.threadId,
            runId: runIdFor(step.targetRunIndex),
          });
          if (step.waitForTurnItemType !== undefined) {
            steps.push({
              type: "await_run_turn_item",
              threadId: ids.threadId,
              runId: runIdFor(step.targetRunIndex),
              itemType: step.waitForTurnItemType,
            });
          }
          pushDispatch(
            {
              type: "run.interrupt",
              commandId: yield* idAllocator.allocate.command({
                fixtureName: input.scenario,
                commandName: `interrupt-${step.targetRunIndex}`,
              }),
              threadId: ids.threadId,
              runId: runIdFor(step.targetRunIndex),
            },
            { advanceClockAfter: false },
          );
          if (activeRunDispatchKeys.delete(`run:${step.targetRunIndex}`)) {
            steps.push({ type: "await", key: `run:${step.targetRunIndex}` });
          }
          steps.push({ type: "advance_clock", duration: "1 millis" });
          steps.push({ type: "await_thread_idle", threadId: ids.threadId });
          break;
        case "stop_background_work":
          steps.push({ type: "await_thread_idle", threadId: ids.threadId });
          steps.push({ type: "capture_shell_snapshot", key: "before-stop" });
          pushDispatch(
            {
              type: "run.interrupt",
              commandId: yield* idAllocator.allocate.command({
                fixtureName: input.scenario,
                commandName: `stop-background-work-${step.targetRunIndex}`,
              }),
              threadId: ids.threadId,
              runId: runIdFor(step.targetRunIndex),
              holdQueue: true,
            },
            { advanceClockAfter: false },
          );
          steps.push({ type: "await_no_background_work", threadId: ids.threadId });
          break;
        case "release_replay_gate_after_waiting":
          steps.push({
            type: "release_replay_gate_after_waiting",
            label: step.label,
            threadId: ids.threadId,
            runId: runIdFor(step.targetRunIndex),
          });
          break;
        case "advance_clock":
          steps.push({ type: "advance_clock", duration: step.duration });
          break;
        case "rollback":
          {
            const scopeId = yield* idAllocator.allocate.checkpointScope({
              threadId: ids.threadId,
              name: step.checkpointScopeSuffix,
            });
            pushDispatch({
              type: "checkpoint.rollback",
              restoreFiles: false,
              commandId: yield* idAllocator.allocate.command({
                fixtureName: input.scenario,
                commandName: `rollback-${step.checkpointSuffix}`,
              }),
              threadId: ids.threadId,
              scopeId,
              checkpointId: yield* idAllocator.allocate.checkpoint({
                checkpointScopeId: scopeId,
                name: step.checkpointSuffix,
              }),
            });
          }
          break;
      }
    }

    if (activeRunDispatchKeys.size > 0) {
      steps.push({ type: "await_all" });
      steps.push({ type: "await_thread_idle", threadId: ids.threadId });
    }

    return {
      commands,
      steps,
      projectionThreadIds: [ids.threadId],
    };
  });
}

export function projectionFor(
  result: OrchestratorV2ScenarioResult,
  scenario: string,
): OrchestrationV2ThreadProjection {
  const projections = [...result.projections.values()].filter(
    (projection) => projection.thread.lineage.parentThreadId === null,
  );

  assert.equal(projections.length, 1, `expected one root projection for ${scenario}`);
  const projection = projections[0];
  assert.isDefined(projection, `missing projection for ${scenario}`);
  return projection;
}

export function assertBaseProjection(input: {
  readonly result: OrchestratorV2ScenarioResult;
  readonly transcript: ProviderReplayTranscript;
  readonly runCount: number;
  readonly providerTurnCountAtLeast?: number;
  readonly runStatuses?: ReadonlyArray<OrchestrationV2RunStatus>;
}) {
  const projection = projectionFor(input.result, input.transcript.scenario);

  assert.equal(
    projection.thread.providerInstanceId,
    ProviderInstanceId.make(input.transcript.provider),
  );
  assert.lengthOf(projection.runs, input.runCount);
  assert.isAtLeast(projection.providerThreads.length, 1);
  assert.isAtLeast(
    projection.providerTurns.length,
    input.providerTurnCountAtLeast ?? input.runCount,
    `expected provider turns; runs=${projection.runs.map((run) => `${run.id}:${run.status}`).join(",")}; sessions=${projection.providerSessions.map((session) => `${session.id}:${session.status}`).join(",")}; items=${projection.turnItems.map((item) => (item.type === "error" ? `${item.type}:${item.failure.message}` : item.type)).join(",")}`,
  );
  assert.isAtLeast(input.result.domainEvents.length, 1);
  assert.deepEqual(
    input.result.storedEvents.map((stored) => stored.sequence),
    input.result.storedEvents.map((_, index) => index + 1),
  );
  assert.deepEqual(
    input.result.storedEvents.map((stored) => stored.event.id),
    input.result.domainEvents.map((event) => event.id),
  );

  if (input.runStatuses) {
    assert.deepEqual(
      projection.runs.map((run) => run.status),
      input.runStatuses,
    );
  }
}

export function assertRunOrdinals(
  projection: OrchestrationV2ThreadProjection,
  expectedOrdinals: ReadonlyArray<number>,
) {
  assert.deepEqual(
    projection.runs.map((run) => run.ordinal),
    expectedOrdinals,
  );
}

function assertRunsHaveRootNodes(projection: OrchestrationV2ThreadProjection) {
  for (const run of projection.runs) {
    assert.isNotNull(run.rootNodeId, `run ${run.id} must have a root node`);
    assert.isTrue(
      projection.nodes.some((node) => node.id === run.rootNodeId && node.kind === "root_turn"),
      `run ${run.id} root node must exist`,
    );
  }
}

function assertRootNodesCountForRuns(projection: OrchestrationV2ThreadProjection) {
  const rootNodes = projection.nodes.filter((node) => node.kind === "root_turn");
  assert.isAtLeast(rootNodes.length, projection.runs.length);
  for (const node of rootNodes) {
    assert.equal(node.countsForRun, true, `root node ${node.id} must count for its app run`);
  }
}

function assertProviderTurnsReferenceNodes(projection: OrchestrationV2ThreadProjection) {
  for (const providerTurn of projection.providerTurns) {
    assert.isTrue(
      projection.nodes.some((node) => node.id === providerTurn.nodeId),
      `provider turn ${providerTurn.id} must reference an execution node`,
    );
    assert.isTrue(
      projection.providerThreads.some((thread) => thread.id === providerTurn.providerThreadId),
      `provider turn ${providerTurn.id} must reference a provider thread`,
    );
  }
}

function assertTurnItemsAreOrdered(projection: OrchestrationV2ThreadProjection) {
  const ordinals = projection.turnItems.map((item) => item.ordinal);
  assert.deepEqual(
    ordinals,
    [...ordinals].toSorted((left, right) => left - right),
  );
}

function assertTurnItemsReferenceProjection(projection: OrchestrationV2ThreadProjection) {
  for (const item of projection.turnItems) {
    if (item.runId !== null) {
      assert.isTrue(
        projection.runs.some((run) => run.id === item.runId),
        `turn item ${item.id} must reference an existing run`,
      );
    }
    if (item.nodeId !== null) {
      assert.isTrue(
        projection.nodes.some((node) => node.id === item.nodeId),
        `turn item ${item.id} must reference an existing node`,
      );
    }
    if (item.providerTurnId !== null) {
      assert.isTrue(
        projection.providerTurns.some((turn) => turn.id === item.providerTurnId),
        `turn item ${item.id} must reference an existing provider turn`,
      );
    }
  }
}

export function assertVisibleTurnItemsMirrorLocalTurnItems(
  projection: OrchestrationV2ThreadProjection,
) {
  assert.lengthOf(
    projection.visibleTurnItems,
    projection.turnItems.length,
    "non-fork visible turn items must mirror local canonical turn items",
  );

  for (const [index, item] of projection.turnItems.entries()) {
    const visibleItem = projection.visibleTurnItems[index];
    assert.isDefined(visibleItem, `missing visible turn item at position ${index}`);
    assert.equal(visibleItem.position, index);
    assert.equal(visibleItem.visibility, "local");
    assert.equal(visibleItem.sourceThreadId, item.threadId);
    assert.equal(visibleItem.sourceItemId, item.id);
    assert.deepEqual(visibleItem.item, item);
  }
}

function assertMessagesReferenceProjection(projection: OrchestrationV2ThreadProjection) {
  for (const message of projection.messages) {
    if (message.runId !== null) {
      assert.isTrue(
        projection.runs.some((run) => run.id === message.runId),
        `message ${message.id} must reference an existing run`,
      );
    }
    if (message.nodeId !== null) {
      assert.isTrue(
        projection.nodes.some((node) => node.id === message.nodeId),
        `message ${message.id} must reference an existing node`,
      );
    }
  }
}

function assertRuntimeRequestsReferenceProjection(projection: OrchestrationV2ThreadProjection) {
  for (const request of projection.runtimeRequests) {
    const requestNode = projection.nodes.find((node) => node.id === request.nodeId);
    assert.isTrue(
      requestNode !== undefined,
      `runtime request ${request.id} must reference an existing node`,
    );
    if (
      requestNode !== undefined &&
      (request.kind === "command" || request.kind === "file-read" || request.kind === "file-change")
    ) {
      assert.equal(
        requestNode.kind,
        "approval_request",
        `runtime request ${request.id} must reference an approval request node`,
      );
    }
    if (request.providerTurnId !== null) {
      assert.isTrue(
        projection.providerTurns.some((turn) => turn.id === request.providerTurnId),
        `runtime request ${request.id} must reference an existing provider turn`,
      );
    }
  }
}

export function assertSemanticProjectionIntegrity(projection: OrchestrationV2ThreadProjection) {
  assertRunsHaveRootNodes(projection);
  assertRootNodesCountForRuns(projection);
  assertProviderTurnsReferenceNodes(projection);
  assertTurnItemsAreOrdered(projection);
  assertTurnItemsReferenceProjection(projection);
  assertMessagesReferenceProjection(projection);
  assertRuntimeRequestsReferenceProjection(projection);
}

export function assertProviderNativeSubagentRootTurns(result: OrchestratorV2ScenarioResult) {
  const activity = (statuses: ReadonlyArray<OrchestrationV2ExecutionNode["status"]>) =>
    statuses
      .map((status) => (isOrchestrationV2WorkActive(status) ? "active" : status))
      .filter((status, index, all) => status !== all[index - 1]);
  for (const projection of result.projections.values()) {
    for (const subagent of projection.subagents) {
      if (subagent.origin !== "provider_native" || subagent.childThreadId === null) continue;
      const childThreadId = subagent.childThreadId;
      const child = result.projections.get(childThreadId);
      assert.isDefined(child, `missing child thread for subagent ${subagent.id}`);
      assert.equal(child.thread.creationSource, "provider");
      assert.deepEqual(child.thread.forkedFrom, { type: "node", nodeId: subagent.id });
      assert.lengthOf(child.runs, 0);
      const roots = child.nodes.filter((node) => node.kind === "root_turn");
      assert.isNotEmpty(roots, `child ${childThreadId} must have a root turn`);
      for (const root of roots) assert.isNull(root.runId);

      const runByChildUpdate = new Map<string, string | undefined>();
      for (const event of result.domainEvents) {
        if (event.threadId !== childThreadId) continue;
        const update = `${event.type}:${JSON.stringify(event.payload)}`;
        const storedBy = runByChildUpdate.get(update);
        if (runByChildUpdate.has(update) && storedBy !== event.runId) {
          assert.fail(
            `child ${childThreadId} stored ${event.type} in ${storedBy} and ${event.runId}`,
          );
        }
        runByChildUpdate.set(update, event.runId);
      }

      const rootEvents = result.domainEvents.flatMap((event, index) =>
        event.type === "node.updated" &&
        event.payload.threadId === childThreadId &&
        event.payload.kind === "root_turn"
          ? [{ index, status: event.payload.status }]
          : [],
      );
      const firstItemIndex = result.domainEvents.findIndex(
        (event) =>
          event.type === "turn-item.updated" &&
          event.payload.threadId === childThreadId &&
          event.payload.type !== "user_message",
      );
      assert.equal(rootEvents[0]?.status, "running");
      if (firstItemIndex !== -1) {
        assert.isBelow(
          rootEvents[0]?.index ?? Infinity,
          firstItemIndex,
          `child ${childThreadId} must be working before its first item`,
        );
      }
      const subagentStatuses = result.domainEvents.flatMap((event) =>
        event.type === "subagent.updated" && event.payload.id === subagent.id
          ? [event.payload.status]
          : [],
      );
      const rootActivity = activity(rootEvents.map((event) => event.status));
      const subagentActivity = activity(subagentStatuses);
      const wokenAfterEnd =
        child.subagents.length > 0 && rootActivity.length > subagentActivity.length;
      assert.deepEqual(
        wokenAfterEnd ? rootActivity.slice(0, subagentActivity.length) : rootActivity,
        subagentActivity,
        `child ${childThreadId} root turn must follow subagent ${subagent.id}`,
      );
      if (wokenAfterEnd) {
        assert.notEqual(rootActivity.at(-1), "active", `child ${childThreadId} must end its turns`);
        const childSubagentIds = new Set(child.subagents.map((nested) => nested.id));
        const nestedEndIndexes = result.domainEvents.flatMap((event, index) =>
          event.type === "subagent.updated" &&
          childSubagentIds.has(event.payload.id) &&
          !isOrchestrationV2WorkActive(event.payload.status)
            ? [index]
            : [],
        );
        const subagentEndIndex = result.domainEvents.findLastIndex(
          (event) =>
            event.type === "subagent.updated" &&
            event.payload.id === subagent.id &&
            !isOrchestrationV2WorkActive(event.payload.status),
        );
        const wakeStarts = rootEvents.filter(
          (event, position) =>
            event.index > subagentEndIndex &&
            isOrchestrationV2WorkActive(event.status) &&
            !isOrchestrationV2WorkActive(rootEvents[position - 1]?.status ?? "completed"),
        );
        assert.isNotEmpty(wakeStarts, `child ${childThreadId} woke without a new turn`);
        assert.isAtMost(
          wakeStarts.length,
          nestedEndIndexes.length,
          `child ${childThreadId} woke more often than its subagents ended`,
        );
        for (const wake of wakeStarts) {
          assert.isTrue(
            nestedEndIndexes.some((endIndex) => endIndex < wake.index),
            `child ${childThreadId} woke before any of its subagents ended`,
          );
        }
      }
    }
  }
}

export function assertExecutionNodeKinds(
  projection: OrchestrationV2ThreadProjection,
  expectedKinds: ReadonlyArray<OrchestrationV2ExecutionNode["kind"]>,
) {
  const kinds = projection.nodes.map((node) => node.kind);
  for (const expectedKind of expectedKinds) {
    assert.include(kinds, expectedKind);
  }
}

export function assertTurnItemTypes(
  projection: OrchestrationV2ThreadProjection,
  expectedTypes: ReadonlyArray<OrchestrationV2TurnItem["type"]>,
) {
  const actualTypes = projection.turnItems.map((item) => item.type);
  for (const expectedType of expectedTypes) {
    assert.include(actualTypes, expectedType);
  }
}

export function assertTurnItemTypeSequence(
  projection: OrchestrationV2ThreadProjection,
  expectedTypes: ReadonlyArray<OrchestrationV2TurnItem["type"]>,
) {
  assert.deepEqual(
    projection.turnItems.map((item) => item.type),
    expectedTypes,
  );
}

export function assertVisibleTurnItemTypeSequence(
  projection: OrchestrationV2ThreadProjection,
  expectedTypes: ReadonlyArray<OrchestrationV2TurnItem["type"]>,
) {
  assert.deepEqual(
    projection.visibleTurnItems.map((row) => row.item.type),
    expectedTypes,
  );
}

export function assertAssistantTextIncludes(
  projection: OrchestrationV2ThreadProjection,
  expectedText: string,
) {
  assert.isTrue(
    projection.turnItems.some(
      (item) => item.type === "assistant_message" && item.text.includes(expectedText),
    ),
    `expected assistant output to include ${JSON.stringify(expectedText)}`,
  );
}

export function assertRuntimeRequestCounts(
  projection: OrchestrationV2ThreadProjection,
  expected: { readonly total: number; readonly resolved?: number },
) {
  assert.lengthOf(projection.runtimeRequests, expected.total);
  if (expected.resolved !== undefined) {
    assert.equal(
      projection.runtimeRequests.filter((request) => request.status === "resolved").length,
      expected.resolved,
    );
  }
}

export function assertConversationMessageRoles(
  projection: OrchestrationV2ThreadProjection,
  expectedRoles: ReadonlyArray<string>,
) {
  assert.deepEqual(
    projection.messages.map((message) => message.role),
    expectedRoles,
  );
}

export function assertUserMessagesInclude(
  projection: OrchestrationV2ThreadProjection,
  expectedTexts: ReadonlyArray<string>,
) {
  for (const expectedText of expectedTexts) {
    assert.isTrue(
      projection.turnItems.some(
        (item) => item.type === "user_message" && item.text.includes(expectedText),
      ),
      `expected user input to include ${JSON.stringify(expectedText)}`,
    );
  }
}

export function assertVisibleUserMessagesInclude(
  projection: OrchestrationV2ThreadProjection,
  expectedTexts: ReadonlyArray<string>,
) {
  for (const expectedText of expectedTexts) {
    assert.isTrue(
      projection.visibleTurnItems.some(
        (row) => row.item.type === "user_message" && row.item.text.includes(expectedText),
      ),
      `expected visible user input to include ${JSON.stringify(expectedText)}`,
    );
  }
}

export function assertVisibleUserMessagesExclude(
  projection: OrchestrationV2ThreadProjection,
  rejectedTexts: ReadonlyArray<string>,
) {
  for (const rejectedText of rejectedTexts) {
    assert.isFalse(
      projection.visibleTurnItems.some(
        (row) => row.item.type === "user_message" && row.item.text.includes(rejectedText),
      ),
      `expected visible user input to exclude ${JSON.stringify(rejectedText)}`,
    );
  }
}

export function assertUserMessageInputIntents(
  projection: OrchestrationV2ThreadProjection,
  expectedIntents: ReadonlyArray<OrchestrationV2UserMessageInputIntent>,
) {
  assert.deepEqual(
    projection.turnItems
      .filter((item) => item.type === "user_message")
      .map((item) => item.inputIntent),
    expectedIntents,
  );
}

import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import { settledRunWithOpenBackgroundWork } from "./RecoverInterruptedTurns.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread:recover");
const runId = RunId.make("run:recover");
const instanceId = ProviderInstanceId.make("claudeAgent");
const settings = {
  recoverInterruptedTurns: true,
  recoverInterruptedTurnsMessage: "Top message",
  recoverInterruptedTurnsSubagentMessage: "Child message",
};

/** A thread whose latest run a restart cancelled mid-turn. */
function makeProjection(input: {
  readonly userMessageId: string;
  readonly answered: boolean;
  readonly relationshipToParent: "subagent" | null;
}) {
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project:recover"),
      providerInstanceId: instanceId,
      archivedAt: null,
      deletedAt: null,
      lineage: {
        parentThreadId: input.relationshipToParent === null ? null : ThreadId.make("thread:parent"),
        relationshipToParent: input.relationshipToParent,
        rootThreadId: threadId,
      },
    },
    runs: [
      {
        id: runId,
        ordinal: 2,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "claude-opus-5-5" },
        providerThreadId: null,
        userMessageId: MessageId.make(input.userMessageId),
        activeAttemptId: RunAttemptId.make("attempt:recover"),
        status: "cancelled",
        completedAt: null,
      },
    ],
    providerTurns: [],
    attempts: [],
    runtimeRequests: [],
    turnItems: [],
    messages: input.answered
      ? [{ id: MessageId.make("message:answer"), runId, role: "assistant", text: "Working." }]
      : [],
  } as unknown as OrchestrationV2ThreadProjection;
}

const dispatchedTexts = (
  projection: OrchestrationV2ThreadProjection,
  options: { readonly instanceDisabled?: boolean; readonly recovered?: Array<RunId> } = {},
) =>
  Effect.gen(function* () {
    const texts: Array<string> = [];
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (_threadId, _fields, filter) =>
              Effect.succeed({
                ...projection,
                messages: projection.messages.filter(
                  (message) =>
                    (filter?.messageRoles === undefined ||
                      filter.messageRoles.includes(message.role)) &&
                    (filter?.messageRunIds === undefined ||
                      (message.runId !== null && filter.messageRunIds.includes(message.runId))),
                ),
              }) as never,
            recoverDelegatedTask: (_threadId, sourceRunId) =>
              Effect.sync(() => options.recovered?.push(sourceRunId)),
            dispatch: (command) =>
              options.instanceDisabled
                ? Effect.fail(
                    new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                      projectId: projection.thread.projectId,
                      instanceId,
                    }),
                  )
                : Effect.sync(() => {
                    if (command.type === "message.dispatch") texts.push(command.text);
                    return {} as never;
                  }),
          }),
          ServerSettings.layerTest(settings),
        ),
      ),
    );
    return texts;
  });

it.effect("never sends a second message after a recovery turn cut before any answer", () =>
  Effect.gen(function* () {
    const recoveryMessageId = "message:recover-interrupted:run:earlier";
    const cutBeforeAnswer = makeProjection({
      userMessageId: recoveryMessageId,
      answered: false,
      relationshipToParent: null,
    });
    assert.deepEqual(yield* dispatchedTexts(cutBeforeAnswer), []);
    // A recovery turn that already worked and then got cut is recovered again.
    const cutAfterAnswer = makeProjection({
      userMessageId: recoveryMessageId,
      answered: true,
      relationshipToParent: null,
    });
    assert.deepEqual(yield* dispatchedTexts(cutAfterAnswer), ["Top message"]);
  }),
);

it.effect("sends the subagent message to a delegated child thread", () =>
  Effect.gen(function* () {
    const child = makeProjection({
      userMessageId: "message:user",
      answered: false,
      relationshipToParent: "subagent",
    });
    assert.deepEqual(yield* dispatchedTexts(child), ["Child message"]);
  }),
);

it.effect("leaves a snoozed or settled thread asleep, as upstream does", () =>
  Effect.gen(function* () {
    const cut = makeProjection({
      userMessageId: "message:user",
      answered: false,
      relationshipToParent: null,
    });
    const now = yield* DateTime.now;
    for (const held of [
      { snoozedUntil: DateTime.add(now, { days: 1 }) },
      { settledOverride: "settled" },
    ]) {
      const thread = { ...cut.thread, ...held } as typeof cut.thread;
      assert.deepEqual(yield* dispatchedTexts({ ...cut, thread }), []);
    }
    const elapsed = { ...cut.thread, snoozedUntil: DateTime.subtract(now, { minutes: 1 }) };
    assert.deepEqual(yield* dispatchedTexts({ ...cut, thread: elapsed }), ["Top message"]);
  }),
);

it.effect("still recovers a delegated child when its provider is off for the project", () =>
  Effect.gen(function* () {
    const child = makeProjection({
      userMessageId: "message:user",
      answered: false,
      relationshipToParent: "subagent",
    });
    const recovered: Array<RunId> = [];
    assert.deepEqual(yield* dispatchedTexts(child, { instanceDisabled: true, recovered }), []);
    assert.deepEqual(recovered, [runId]);
  }),
);

it.effect("does not wake a snoozed thread for its killed background work", () =>
  Effect.gen(function* () {
    const providerThreadId = "provider-thread:recover";
    const finished = {
      thread: {
        providerInstanceId: instanceId,
        archivedAt: null,
        deletedAt: null,
        settledOverride: null,
      },
      runs: [
        {
          id: runId,
          ordinal: 1,
          status: "completed",
          providerThreadId,
          providerInstanceId: instanceId,
        },
      ],
      providerThreads: [
        {
          id: providerThreadId,
          nativeThreadRef: { strength: "strong" },
          ownerNodeId: null,
          pendingBackgroundTasks: [{ id: "task:monitor" }],
        },
      ],
      turnItems: [],
    } as unknown as OrchestrationV2ThreadProjection;
    const now = yield* DateTime.now;
    assert.equal(settledRunWithOpenBackgroundWork(finished, now)?.id, runId);
    const snoozed = { ...finished.thread, snoozedUntil: DateTime.add(now, { days: 1 }) };
    assert.isUndefined(settledRunWithOpenBackgroundWork({ ...finished, thread: snoozed }, now));
  }),
);

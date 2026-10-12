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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
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
    turnItems: [],
    messages: input.answered
      ? [{ id: MessageId.make("message:answer"), runId, role: "assistant", text: "Working." }]
      : [],
  } as unknown as OrchestrationV2ThreadProjection;
}

const dispatchedTexts = (projection: OrchestrationV2ThreadProjection) =>
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
            recoverDelegatedTask: () => Effect.void,
            dispatch: (command) =>
              Effect.sync(() => {
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

import {
  CommandId,
  type OrchestrationV2LinkedRequest,
  type OrchestrationV2ThreadProjection,
  OrchestratorMcpFailure,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Hash from "effect/Hash";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { assertNotLinked, callerIsFenced } from "../../linkOrigin.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { dispatchFailure, loadCaller, threadNotFound, unavailable } from "../../threadAccess.ts";
import { FORWARDED_WAIT_CHUNK_MS } from "./tools.ts";

const requireLinkSession = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    McpInvocationContext.isLinkSession(scope)
      ? Effect.void
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Only a linked T3 Code environment answers here for its user.",
          }),
        ),
  ),
);

/**
 * The questions and approvals `projection` waits on that an answer can still reach, without
 * the choices a fenced link may not make.
 */
const linkedRequestsOf = (
  projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems">,
  fenced: boolean,
): ReadonlyArray<OrchestrationV2LinkedRequest> =>
  projection.runtimeRequests.flatMap((request): ReadonlyArray<OrchestrationV2LinkedRequest> => {
    if (request.status !== "pending" || request.responseCapability.type !== "live") return [];
    const common = { requestId: request.id, createdAt: request.createdAt };
    if (request.kind === "user_input") {
      const item = projection.turnItems.findLast(
        (candidate) =>
          candidate.type === "user_input_request" && candidate.requestId === request.id,
      );
      if (item?.type !== "user_input_request") return [];
      return [
        {
          ...common,
          kind: "user_input",
          ...(item.runId === null ? {} : { runId: item.runId }),
          questions: item.questions,
        },
      ];
    }
    if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") return [];
    const item = projection.turnItems.findLast(
      (candidate) => candidate.type === "approval_request" && candidate.requestId === request.id,
    );
    const approval = item?.type === "approval_request" ? item : undefined;
    const options = fenced
      ? approval?.options?.filter((option) => option.decision !== "acceptAlways")
      : approval?.options;
    return [
      {
        ...common,
        kind: request.kind,
        ...(approval?.runId == null ? {} : { runId: approval.runId }),
        ...(approval?.prompt === undefined ? {} : { detail: approval.prompt }),
        ...(approval?.reason === undefined ? {} : { reason: approval.reason }),
        ...(options === undefined ? {} : { options }),
      },
    ];
  });

const linkedThread = Effect.fn("mcp.linkedThread")(function* (threadId: ThreadId) {
  yield* requireLinkSession;
  const caller = yield* loadCaller();
  const shell = yield* caller.threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
  if (shell === null || shell.deletedAt !== null) {
    return yield* threadNotFound(caller.threads, threadId, "The thread was not found.");
  }
  const readRequests = caller.threads
    .getProjectThreadRecords(
      { projectId: shell.projectId, threadId },
      ["runtimeRequests", "turnItems"],
      {
        turnItemTypes: ["user_input_request", "approval_request"],
      },
    )
    .pipe(
      Effect.map((projection) => {
        const requests = linkedRequestsOf(projection, callerIsFenced(caller));
        return { requests, version: String(Hash.string(JSON.stringify(requests))) };
      }),
      Effect.mapError(unavailable),
    );
  return { caller, readRequests };
});

/**
 * The thread's live requests once their `version` differs from `knownVersion`, or as they are
 * when `timeoutMs` passes. One wait answers within a forwarded call's idle limit.
 */
export const watchLinkedRequests = Effect.fn("mcp.watchLinkedRequests")(function* (input: {
  readonly threadId: ThreadId;
  readonly knownVersion?: string | undefined;
  readonly timeoutMs?: number | undefined;
}) {
  const { caller, readRequests } = yield* linkedThread(input.threadId);
  const differs = (read: { readonly version: string }) => read.version !== input.knownVersion;
  // Taken before the read, so a request recorded between the two still wakes the wait.
  const afterSequence = yield* caller.threads
    .getThreadEventSequence(input.threadId)
    .pipe(Effect.mapError(unavailable));
  const current = yield* readRequests;
  if (differs(current)) return current;
  const updates = (eventType: "runtime-request.updated" | "turn-item.updated") =>
    caller.threads.streamStoredEventsFrom({ threadId: input.threadId, afterSequence, eventType });
  const changed = yield* Stream.merge(
    updates("runtime-request.updated"),
    // A request's question or approval details can land after the request itself.
    updates("turn-item.updated").pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "turn-item.updated" &&
          (event.payload.type === "approval_request" ||
            event.payload.type === "user_input_request"),
      ),
    ),
  ).pipe(
    Stream.mapError(unavailable),
    Stream.mapEffect(() => readRequests),
    Stream.filter(differs),
    Stream.runHead,
    Effect.timeoutOption(input.timeoutMs ?? FORWARDED_WAIT_CHUNK_MS),
    Effect.map(Option.flatten),
  );
  return Option.getOrElse(changed, () => current);
});

/**
 * Answers a request for the user of the environment the link belongs to. The caller's
 * declaration has already held the link to its access and fence for this thread; a link
 * paired below full access may not also accept the request for every later session here.
 */
export const respondToLinkedRequest = Effect.fn("mcp.respondToLinkedRequest")(function* (input: {
  readonly threadId: ThreadId;
  readonly requestId: RuntimeRequestId;
  readonly decision?: ProviderApprovalDecision | undefined;
  readonly answers?: ProviderUserInputAnswers | undefined;
  readonly clientRequestId: string;
}) {
  const { caller } = yield* linkedThread(input.threadId);
  if (input.decision === "acceptAlways") {
    yield* assertNotLinked(caller, "accept a request for every later session here");
  }
  const answer =
    input.decision !== undefined && input.answers === undefined
      ? { decision: input.decision }
      : input.answers !== undefined && input.decision === undefined
        ? { answers: input.answers }
        : undefined;
  if (answer === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Answer an approval with `decision` or a question with `answers`.",
    });
  }
  const result = yield* caller.threads
    .dispatch({
      type: "runtime-request.respond",
      // A repeat replays the first answer's receipt, so a resent answer is answered once.
      commandId: CommandId.make(
        `mcp:link-respond:${encodeURIComponent(caller.scope.requestNamespace)}:${encodeURIComponent(input.clientRequestId)}`,
      ),
      threadId: input.threadId,
      requestId: input.requestId,
      ...answer,
    })
    .pipe(Effect.mapError(dispatchFailure));
  return { sequence: result.sequence };
});

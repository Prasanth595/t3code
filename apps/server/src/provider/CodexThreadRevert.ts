import type * as CodexSchema from "effect-codex-app-server/schema";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Effect from "effect/Effect";

export const revertCodexThread = Effect.fn("revertCodexThread")(function* (
  client: Pick<CodexClient.CodexAppServerClient["Service"], "request">,
  threadId: string,
  target:
    | number
    | { readonly type: "after_turn"; readonly nativeTurnId: string }
    | { readonly type: "thread_start" },
) {
  let remaining = typeof target === "number" ? target : undefined;
  let boundaryFound = false;
  let beforeTurnId: string | undefined;
  let cursor: string | null = null;
  const visited = new Set<string | null>();
  while (remaining === undefined || remaining > 0) {
    if (visited.has(cursor)) {
      return yield* CodexErrors.CodexAppServerRequestError.internalError(
        "Thread history pagination repeated a cursor.",
        undefined,
        { method: "thread/turns/list", operation: "decode-payload" },
      );
    }
    visited.add(cursor);
    const page: CodexSchema.V2ThreadTurnsListResponse = yield* client.request("thread/turns/list", {
      threadId,
      cursor,
      limit: Math.min(remaining ?? 100, 100),
      sortDirection: "desc",
      itemsView: "summary",
    });
    for (const turn of page.data) {
      if (
        typeof target !== "number" &&
        target.type === "after_turn" &&
        turn.id === target.nativeTurnId
      ) {
        boundaryFound = true;
        remaining = 0;
        break;
      }
      beforeTurnId = turn.id;
      if (remaining !== undefined && --remaining === 0) break;
    }
    cursor = page.nextCursor ?? null;
    if (cursor === null) break;
  }
  // The retained turn must be found before any destructive request. Newer native
  // turns may have no durable provider turn.
  if (typeof target !== "number" && target.type === "after_turn" && !boundaryFound) {
    return yield* CodexErrors.CodexAppServerRequestError.internalError(
      "Cannot revert thread: retained native turn was not found.",
      undefined,
      { method: "thread/turns/list", operation: "decode-payload" },
    );
  }
  return beforeTurnId === undefined
    ? yield* client.request("thread/read", { threadId, includeTurns: false })
    : yield* client.request("thread/revert", { threadId, beforeTurnId });
});

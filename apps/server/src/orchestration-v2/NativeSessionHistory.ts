import {
  NativeSessionError,
  ThreadId,
  type NativeSessionBinding,
  type NativeSessionBlocker,
  type NativeSessionObservation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { nativePayloadHash } from "./NativeSessionStore.ts";

const Item = Schema.Struct({
  id: Schema.NonEmptyString,
  type: Schema.NonEmptyString,
  status: Schema.optionalKey(Schema.String),
});
const Turn = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.String,
  items: Schema.Array(Schema.Unknown),
  itemsView: Schema.optionalKey(Schema.String),
});
const Envelope = Schema.Struct({
  thread: Schema.Struct({
    id: Schema.String,
    cwd: Schema.String,
    cliVersion: Schema.String,
    historyMode: Schema.optionalKey(Schema.Literals(["legacy", "paginated"])),
    status: Schema.Struct({ type: Schema.String }),
    turns: Schema.Array(Turn),
  }),
});
const Page = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
  nextCursor: Schema.NullOr(Schema.String),
});
const Entry = Schema.Struct({ turnId: Schema.String, item: Schema.Unknown });
const Goal = Schema.Struct({ goal: Schema.NullOr(Schema.Struct({ status: Schema.String })) });
const Work = Schema.Struct({
  receiverThreadIds: Schema.Array(Schema.String),
  agentsStates: Schema.Record(Schema.String, Schema.Struct({ status: Schema.String })),
});
const encodeNativeItem = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const terminal = new Set([
  "completed",
  "failed",
  "declined",
  "interrupted",
  "errored",
  "shutdown",
  "notFound",
]);
const knownItems = new Set([
  "userMessage",
  "agentMessage",
  "reasoning",
  "plan",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction",
  "subAgentActivity",
]);

export const readNativeHistory = Effect.fn("NativeSessionHistory.read")(function* <E>(
  request: (method: string, params?: unknown) => Effect.Effect<unknown, E>,
  binding: Pick<NativeSessionBinding, "nativeId" | "cwd" | "protocolVersion">,
): Effect.fn.Return<NativeSessionObservation, E | NativeSessionError> {
  const threadId = ThreadId.make(`native:${binding.nativeId}`);
  const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
    schema: S,
    value: unknown,
  ) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(
        (cause) => new NativeSessionError({ code: "native-history-incomplete", threadId, cause }),
      ),
    );
  const snapshot = Effect.fn("NativeSessionHistory.snapshot")(function* () {
    const response = yield* decode(
      Envelope,
      yield* request("thread/read", { threadId: binding.nativeId, includeTurns: true }),
    );
    const thread = response.thread;
    if (thread.id !== binding.nativeId || thread.cwd !== binding.cwd)
      return yield* new NativeSessionError({ code: "native-identity-changed", threadId });
    const blockers: Array<NativeSessionBlocker> = [];
    const block = (
      code: string,
      ids: ReadonlyArray<string>,
      nextAction: NativeSessionBlocker["nextAction"] = "stop-selected-work",
    ) => blockers.push({ code, ids, nextAction });
    if (thread.status.type !== "idle") block("native-thread-active", [thread.id]);
    const pages = Effect.fn("NativeSessionHistory.pages")(function* (
      method: string,
      extra: Readonly<Record<string, string>> = {},
    ) {
      let cursor: string | null = null;
      const seen = new Set<string>();
      const rows: Array<unknown> = [];
      for (let page = 0; page < 128; page++) {
        const result: typeof Page.Type = yield* decode(
          Page,
          yield* request(method, {
            threadId: binding.nativeId,
            ...extra,
            cursor,
            limit: 100,
            sortDirection: "asc",
          }),
        );
        rows.push(...result.data);
        if (rows.length > 10000)
          return yield* new NativeSessionError({ code: "native-history-limit", threadId });
        if (result.nextCursor === null) return rows;
        if (seen.has(result.nextCursor))
          return yield* new NativeSessionError({
            code: "native-history-pagination-cycle",
            threadId,
          });
        seen.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      return yield* new NativeSessionError({ code: "native-history-limit", threadId });
    });
    const turns =
      thread.historyMode === "paginated"
        ? yield* Effect.forEach(yield* pages("thread/turns/list"), (value) => decode(Turn, value))
        : thread.turns;
    if (thread.historyMode === undefined)
      return yield* new NativeSessionError({ code: "native-history-mode-unknown", threadId });
    const result: Array<NativeSessionObservation["turns"][number]> = [];
    let totalItems = 0;
    let totalBytes = 0;
    const seenTurns = new Set<string>();
    for (const turn of turns) {
      if (seenTurns.has(turn.id))
        return yield* new NativeSessionError({ code: "native-history-overlap", threadId });
      seenTurns.add(turn.id);
      if (!terminal.has(turn.status)) block("native-turn-active", [turn.id]);
      if (thread.historyMode !== "paginated" && turn.itemsView === "summary")
        return yield* new NativeSessionError({ code: "native-items-incomplete", threadId });
      const rawItems =
        thread.historyMode === "paginated"
          ? yield* Effect.forEach(yield* pages("thread/items/list", { turnId: turn.id }), (value) =>
              decode(Entry, value).pipe(
                Effect.flatMap((entry) =>
                  entry.turnId === turn.id
                    ? Effect.succeed(entry.item)
                    : new NativeSessionError({ code: "native-history-foreign-turn", threadId }),
                ),
              ),
            )
          : turn.items;
      const items: Array<NativeSessionObservation["turns"][number]["items"][number]> = [];
      const seenItems = new Map<string, string>();
      for (const payload of rawItems) {
        totalItems++;
        totalBytes += Buffer.byteLength(
          yield* encodeNativeItem(payload).pipe(
            Effect.mapError(
              (cause) =>
                new NativeSessionError({ code: "native-history-incomplete", threadId, cause }),
            ),
          ),
        );
        if (totalItems > 10000 || totalBytes > 64 * 1024 * 1024)
          return yield* new NativeSessionError({ code: "native-history-limit", threadId });
        const item = yield* decode(Item, payload);
        const hash = nativePayloadHash(payload);
        if (seenItems.has(item.id)) {
          if (seenItems.get(item.id) !== hash)
            return yield* new NativeSessionError({
              code: "native-history-overlap-changed",
              threadId,
            });
          continue;
        }
        seenItems.set(item.id, hash);
        items.push({ id: item.id, type: item.type, payload });
        if (!knownItems.has(item.type)) block("unsupported-native-item", [item.id], "unsupported");
        if (item.status !== undefined && !terminal.has(item.status))
          block("native-item-active", [item.id]);
        if (item.type === "subAgentActivity")
          block("unsupported-native-job-state", [item.id], "unsupported");
        if (item.type === "collabAgentToolCall") {
          const work = yield* decode(Work, payload);
          for (const id of work.receiverThreadIds)
            if (!terminal.has(work.agentsStates[id]?.status ?? "unknown"))
              block("native-child-active", [id]);
        }
      }
      result.push({ id: turn.id, status: turn.status, items });
    }
    const goal = yield* decode(
      Goal,
      yield* request("thread/goal/get", { threadId: binding.nativeId }),
    );
    if (goal.goal !== null && goal.goal.status !== "complete") block("native-goal", [thread.id]);
    return {
      turns: result,
      createdWithCliVersion: thread.cliVersion,
      blockers,
      digest: nativePayloadHash({
        status: thread.status,
        turns: result,
        goal: goal.goal,
        createdWithCliVersion: thread.cliVersion,
      }),
    };
  });
  const first = yield* snapshot();
  const second = yield* snapshot();
  const complete = first.digest === second.digest;
  return {
    ...second,
    complete,
    blockers: complete
      ? second.blockers
      : [
          ...second.blockers,
          { code: "history-changing", ids: [binding.nativeId], nextAction: "retry-same-operation" },
        ],
  };
});

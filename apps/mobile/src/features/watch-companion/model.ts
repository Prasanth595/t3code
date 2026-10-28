import * as Schema from "effect/Schema";

export const WatchRecording = Schema.Struct({
  id: Schema.NonEmptyString,
  uri: Schema.NonEmptyString,
  createdAt: Schema.String,
  kind: Schema.Literals(["new-thread", "reply"]),
  environmentId: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
});
export type WatchRecording = typeof WatchRecording.Type;

export const WatchAction = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.Literals(["settle", "reopen", "answer", "approval"]),
  environmentId: Schema.NonEmptyString,
  threadId: Schema.NonEmptyString,
  requestId: Schema.optional(Schema.NonEmptyString),
  questionId: Schema.optional(Schema.NonEmptyString),
  answer: Schema.optional(Schema.String),
  decision: Schema.optional(Schema.String),
  expectedUpdatedAt: Schema.optional(Schema.NonEmptyString),
}).check(
  Schema.makeFilter((action) => {
    if (action.kind === "settle" || action.kind === "reopen") {
      return (
        action.requestId === undefined &&
        action.questionId === undefined &&
        action.answer === undefined &&
        action.decision === undefined
      );
    }
    if (action.requestId === undefined) return false;
    if (action.kind === "approval" || action.decision === "review-on-phone") {
      return (
        action.decision === "review-on-phone" &&
        action.answer === undefined &&
        action.questionId === undefined
      );
    }
    return action.decision === undefined && action.answer !== undefined && action.answer.length > 0;
  }),
);
export type WatchAction = typeof WatchAction.Type;

export const InboxEntry = Schema.Struct({
  id: Schema.String,
  owner: Schema.NullOr(Schema.String),
  recording: Schema.optional(WatchRecording),
  action: Schema.optional(WatchAction),
  transcript: Schema.optional(Schema.String),
  commandId: Schema.String,
  sourceDigest: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.String),
  state: Schema.Literals(["review", "prepared", "handed-off", "completed", "dismissed"]),
});
export type InboxEntry = typeof InboxEntry.Type;

export const InboxState = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Array(InboxEntry),
  owners: Schema.Record(Schema.String, Schema.String),
  enabledOwner: Schema.optional(Schema.String),
});
export type InboxState = typeof InboxState.Type;
export const EMPTY_INBOX: InboxState = { version: 1, entries: [], owners: {} };

export interface WatchThread {
  readonly id: string;
  readonly environmentId: string;
  readonly title: string;
  readonly projectTitle: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly latestMessage: string;
  readonly pendingRequest?: {
    readonly id: string;
    readonly kind: "question" | "approval";
    readonly title: string;
    readonly detail: string;
    readonly questionId?: string;
    readonly options?: ReadonlyArray<{ readonly label: string; readonly value: string }>;
    readonly allowCustomAnswer?: boolean;
  };
}

export function validateWatchTarget(
  entry: InboxEntry,
  owner: string | null,
  threads: ReadonlyArray<WatchThread>,
  validateRequest = true,
): WatchThread {
  if (owner === null || entry.owner !== owner)
    throw new Error("This item belongs to another account or has not been claimed.");
  const target = entry.action ?? entry.recording;
  const thread = threads.find(
    (candidate) =>
      candidate.environmentId === target?.environmentId && candidate.id === target?.threadId,
  );
  if (!thread)
    throw new Error(
      "The original thread is unavailable. Connect its environment; replies are never redirected.",
    );
  const action = entry.action;
  if (validateRequest && (action?.kind === "answer" || action?.kind === "approval")) {
    const request = thread.pendingRequest;
    if (
      !request ||
      request.id !== action.requestId ||
      request.kind !== (action.kind === "answer" ? "question" : "approval")
    ) {
      throw new Error("This request is stale. Open the thread and review its current request.");
    }
  }
  return thread;
}

export function boundWatchText(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let result = "";
  let remaining = maxBytes;
  for (const character of text) {
    const bytes = encoder.encode(character).byteLength;
    if (bytes > remaining) break;
    result += character;
    remaining -= bytes;
  }
  return result;
}

export function buildWatchSnapshot(
  owner: string | null,
  inbox: InboxState,
  candidates: ReadonlyArray<WatchThread>,
): string {
  const threads =
    owner !== null && inbox.enabledOwner === owner
      ? candidates
          .filter((thread) => inbox.owners[thread.environmentId] === owner)
          .slice(0, 20)
          .map((thread) => ({
            id: thread.id,
            environmentId: thread.environmentId,
            title: boundWatchText(thread.title, 256),
            projectTitle: boundWatchText(thread.projectTitle, 256),
            status: boundWatchText(thread.status, 64),
            updatedAt: thread.updatedAt,
            latestMessage: boundWatchText(thread.latestMessage, 2048),
            ...(thread.pendingRequest
              ? {
                  pendingRequest: {
                    id: thread.pendingRequest.id,
                    kind: thread.pendingRequest.kind,
                    title: boundWatchText(thread.pendingRequest.title, 256),
                    detail: boundWatchText(thread.pendingRequest.detail, 2048),
                  },
                }
              : {}),
          }))
      : [];
  let json = JSON.stringify({ version: 1, threads });
  while (new TextEncoder().encode(json).byteLength > 48 * 1024) {
    threads.pop();
    json = JSON.stringify({ version: 1, threads });
  }
  return json;
}

export function prepareWatchHandoff(entry: InboxEntry): string {
  if (!entry.recording || !entry.transcript?.trim())
    throw new Error("Transcribe this recording first.");
  if (entry.transcript.length > 8_000)
    throw new Error(
      "This transcript exceeds the composer link limit. Copy it in smaller parts; audio is retained.",
    );
  const prompt = new URLSearchParams({ prompt: entry.transcript });
  if (entry.recording.kind === "new-thread") return `/new?${prompt}`;
  const { environmentId, threadId } = entry.recording;
  if (!environmentId || !threadId)
    throw new Error("The recording has no original reply destination.");
  return `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}?${prompt}`;
}

export function validateWatchMutation(entry: InboxEntry, thread: WatchThread): void {
  if (entry.action?.kind !== "settle" && entry.action?.kind !== "reopen")
    throw new Error("Review questions and permissions in the thread on iPhone.");
  if (entry.action.expectedUpdatedAt !== thread.updatedAt)
    throw new Error("The thread changed since the Watch action. Review it on iPhone instead.");
  if (
    thread.pendingRequest ||
    ["queued", "preparing", "starting", "running", "waiting"].includes(thread.status)
  ) {
    throw new Error("The thread has running or pending work. Review it on iPhone instead.");
  }
}

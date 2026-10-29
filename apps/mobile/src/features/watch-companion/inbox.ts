import * as Schema from "effect/Schema";

import { SerializedAsyncQueue } from "../../lib/serialized-async-queue";
import { EMPTY_INBOX, InboxState, WatchAction, type InboxEntry } from "./model";

const decodeInbox = Schema.decodeUnknownSync(InboxState);
const decodeAction = Schema.decodeUnknownSync(WatchAction);
const RECORDING_FIELDS = ["id", "createdAt", "kind", "environmentId", "threadId"] as const;
const ACTION_FIELDS = [
  "id",
  "kind",
  "environmentId",
  "threadId",
  "requestId",
  "questionId",
  "answer",
  "decision",
  "expectedUpdatedAt",
] as const;

function sourceIdentity(entry: InboxEntry): string {
  return JSON.stringify(
    entry.recording
      ? ["recording", ...RECORDING_FIELDS.map((field) => entry.recording?.[field] ?? null)]
      : ["action", ...ACTION_FIELDS.map((field) => entry.action?.[field] ?? null)],
  );
}

function sameSource(left: InboxEntry, right: InboxEntry): boolean {
  if (left.recording || right.recording) {
    return (
      left.recording !== undefined &&
      right.recording !== undefined &&
      RECORDING_FIELDS.every((field) => left.recording?.[field] === right.recording?.[field])
    );
  }
  return (
    left.action !== undefined &&
    right.action !== undefined &&
    ACTION_FIELDS.every((field) => left.action?.[field] === right.action?.[field])
  );
}

export function createWatchInbox(storage: {
  readonly read: () => Promise<string | null>;
  readonly write: (json: string) => Promise<void>;
  readonly changed: (state: InboxState) => void;
  readonly digest: (source: string) => Promise<string>;
}) {
  const queue = new SerializedAsyncQueue();
  let state: InboxState | null = null;
  const tombstone = async (entry: InboxEntry): Promise<InboxEntry> => ({
    id: entry.id,
    owner: entry.owner,
    commandId: entry.commandId,
    state: "dismissed",
    sourceDigest: entry.sourceDigest ?? (await storage.digest(sourceIdentity(entry))),
  });
  const load = async () => {
    if (state !== null) return state;
    const json = await storage.read();
    let loaded = json === null ? EMPTY_INBOX : decodeInbox(JSON.parse(json));
    if (loaded.entries.some((entry) => entry.state === "dismissed" && !entry.sourceDigest)) {
      loaded = {
        ...loaded,
        entries: await Promise.all(
          loaded.entries.map((entry) => (entry.state === "dismissed" ? tombstone(entry) : entry)),
        ),
      };
      await storage.write(JSON.stringify(loaded));
    }
    state = loaded;
    storage.changed(state);
    return state;
  };
  const update = (change: (current: InboxState) => InboxState) =>
    queue.run(async () => {
      const next = change(await load());
      await storage.write(JSON.stringify(next));
      state = next;
      storage.changed(next);
      return next;
    });
  const ingest = (entry: InboxEntry) =>
    queue.run(async () => {
      const current = await load();
      const existing = current.entries.find((item) => item.id === entry.id);
      if (existing) {
        const matches = existing.sourceDigest
          ? existing.sourceDigest === (await storage.digest(sourceIdentity(entry)))
          : sameSource(existing, entry);
        if (!matches) throw new Error("A Watch item reused an ID with different content.");
        if (
          existing.recording &&
          entry.recording &&
          existing.recording.uri !== entry.recording.uri
        ) {
          const recording = { ...existing.recording, uri: entry.recording.uri };
          const next = {
            ...current,
            entries: current.entries.map((item) =>
              item.id === entry.id ? { ...existing, recording } : item,
            ),
          };
          await storage.write(JSON.stringify(next));
          state = next;
          storage.changed(next);
          return next;
        }
        return current;
      }
      const next = { ...current, entries: [...current.entries, entry] };
      await storage.write(JSON.stringify(next));
      state = next;
      storage.changed(next);
      return next;
    });
  return {
    load: () => queue.run(load),
    update,
    ingest,
    dismiss: (id: string) =>
      queue.run(async () => {
        const current = await load();
        const next = {
          ...current,
          entries: await Promise.all(
            current.entries.map((entry) => (entry.id === id ? tombstone(entry) : entry)),
          ),
        };
        await storage.write(JSON.stringify(next));
        state = next;
        storage.changed(next);
      }),
    ingestAndAcknowledge: async (entry: InboxEntry, acknowledge: () => Promise<void>) => {
      await ingest(entry);
      await acknowledge();
    },
    importActions: async (
      raw: unknown,
      options: {
        readonly commandId: () => string;
        readonly acknowledge: (id: string) => Promise<void>;
        readonly report: (error: unknown) => void;
      },
    ) => {
      if (!Array.isArray(raw)) throw new Error("Invalid pending Watch action list.");
      for (const candidate of raw) {
        try {
          const action = decodeAction(candidate);
          const current = await queue.run(load);
          await ingest({
            id: `action:${action.id}`,
            action,
            owner: current.owners[action.environmentId] ?? null,
            commandId: options.commandId(),
            state: "review",
          });
          await options.acknowledge(action.id);
        } catch (error) {
          options.report(error);
        }
      }
    },
    edit: (id: string, change: (entry: InboxEntry) => InboxEntry) =>
      update((current) => ({
        ...current,
        entries: current.entries.map((entry) => (entry.id === id ? change(entry) : entry)),
      })),
    dispatch: (
      id: string,
      owner: () => string | null,
      send: (entry: InboxEntry) => Promise<void>,
    ) =>
      queue.run(async () => {
        const current = await load();
        const entry = current.entries.find((item) => item.id === id);
        if (!entry || owner() === null || entry.owner !== owner())
          throw new Error("Watch account changed.");
        if (entry.state === "completed") return;
        if (entry.state !== "prepared" || !entry.payload)
          throw new Error("Review and persist this action before dispatch.");
        await send(entry);
        const next: InboxState = {
          ...current,
          entries: current.entries.map((item) =>
            item.id === id ? { ...item, state: "completed" } : item,
          ),
        };
        await storage.write(JSON.stringify(next));
        state = next;
        storage.changed(next);
      }),
  };
}

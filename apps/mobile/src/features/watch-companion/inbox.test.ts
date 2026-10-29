import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { createWatchInbox } from "./inbox";
import {
  EMPTY_INBOX,
  WatchAction,
  WatchRecording,
  buildWatchSnapshot,
  prepareWatchHandoff,
  prepareWatchMutation,
  validateWatchMutation,
  validateWatchTarget,
  type InboxEntry,
  type WatchThread,
} from "./model";

const decodeRecording = Schema.decodeUnknownSync(WatchRecording);
const decodeAction = Schema.decodeUnknownSync(WatchAction);

const thread: WatchThread = {
  environmentId: "env-a",
  id: "thread-a",
  title: "Fix tests",
  projectTitle: "App",
  status: "idle",
  updatedAt: "2026-10-28T10:00:00Z",
  latestMessage: "Assistant message available on iPhone",
};
const actionEntry: InboxEntry = {
  id: "action:one",
  owner: "account-a",
  commandId: "command-one",
  state: "review",
  action: {
    id: "one",
    environmentId: "env-a",
    threadId: "thread-a",
    kind: "settle",
    expectedUpdatedAt: thread.updatedAt,
  },
};

function fixture() {
  let json: string | null = null;
  let failWrite = false;
  const storage = {
    read: () => Promise.resolve(json),
    write: (next: string) => {
      if (failWrite) return Promise.reject(new Error("disk full"));
      json = next;
      return Promise.resolve();
    },
    changed: () => {},
    digest: async (source: string) => NodeCrypto.createHash("sha256").update(source).digest("hex"),
  };
  return {
    storage,
    inbox: createWatchInbox(storage),
    failWrites: (fail: boolean) => {
      failWrite = fail;
    },
  };
}

describe("durable Watch inbox", () => {
  it("refreshes a native audio URI after a container move without losing review state", async () => {
    const { inbox, storage } = fixture();
    const entry: InboxEntry = {
      id: "recording:moved",
      owner: "account-a",
      commandId: "original-command",
      state: "handed-off",
      transcript: "keep this transcript",
      recording: {
        id: "moved",
        uri: "file:///old-container/audio.m4a",
        createdAt: "2026-10-28T10:00:00Z",
        kind: "new-thread",
      },
    };
    await inbox.ingest(entry);
    await inbox.ingest({
      ...entry,
      owner: null,
      commandId: "unused-reimport",
      state: "review",
      recording: { ...entry.recording!, uri: "file:///new-container/audio.m4a" },
    });
    expect((await inbox.load()).entries[0]).toEqual({
      ...entry,
      recording: { ...entry.recording!, uri: "file:///new-container/audio.m4a" },
    });
    await inbox.dismiss(entry.id);
    const restarted = createWatchInbox(storage);
    await restarted.ingest({
      ...entry,
      recording: { ...entry.recording!, uri: "file:///third-container/audio.m4a" },
    });
    expect((await restarted.load()).entries[0]?.state).toBe("dismissed");
  });

  it("deletes private content while retaining replay protection across restart", async () => {
    const { inbox, storage } = fixture();
    const entry: InboxEntry = {
      ...actionEntry,
      action: {
        id: "private-action",
        kind: "answer",
        environmentId: "env-a",
        threadId: "thread-a",
        requestId: "request-a",
        answer: "private suggested answer",
      },
      transcript: "private transcript",
      payload: "private prepared payload",
    };
    await inbox.ingest(entry);
    await inbox.dismiss(entry.id);
    const json = (await storage.read())!;
    expect(json).not.toContain("private suggested answer");
    expect(json).not.toContain("private transcript");
    expect(json).not.toContain("private prepared payload");
    expect(json).not.toContain("request-a");
    const restarted = createWatchInbox(storage);
    await restarted.ingestAndAcknowledge(entry, async () => {});
    expect((await restarted.load()).entries[0]?.state).toBe("dismissed");
    await expect(
      restarted.ingest({ ...entry, action: { ...entry.action!, answer: "changed" } }),
    ).rejects.toThrow("reused an ID");
    expect(await storage.read()).toBe(json);
  });

  it("imports the Watch version before shell hydration and never substitutes a newer iPhone snapshot", async () => {
    const { inbox, storage } = fixture();
    const action = decodeAction({ ...actionEntry.action, expectedUpdatedAt: thread.updatedAt });
    await inbox.ingestAndAcknowledge({ ...actionEntry, action }, () => Promise.resolve());
    const restored = (await createWatchInbox(storage).load()).entries[0]!;
    expect(() => validateWatchMutation(restored, thread)).not.toThrow();
    const advanced = { ...thread, updatedAt: "2026-10-28T10:01:00Z" };
    expect(() => validateWatchMutation(restored, advanced)).toThrow("thread changed");
    const legacy = {
      ...restored,
      expectedUpdatedAt: thread.updatedAt,
      action: { ...restored.action!, expectedUpdatedAt: undefined },
    };
    expect(() => validateWatchMutation(legacy, thread)).toThrow("thread changed");
    await expect(
      inbox.ingest({
        ...restored,
        action: decodeAction({ ...action, expectedUpdatedAt: advanced.updatedAt }),
      }),
    ).rejects.toThrow("reused an ID");
  });

  it("removes a native action only after its phone inbox write succeeds, including native replay after a failed remove", async () => {
    const { inbox, storage, failWrites } = fixture();
    let nativeRemoved = false;
    let removes = 0;
    const removeNative = async () => {
      removes++;
      const persisted = JSON.parse((await storage.read())!);
      expect(persisted.entries[0].action).toEqual(actionEntry.action);
      expect(persisted.entries[0].commandId).toBe("command-one");
      if (removes === 1) throw new Error("native remove acknowledgement lost");
      nativeRemoved = true;
    };
    failWrites(true);
    await expect(inbox.ingestAndAcknowledge(actionEntry, removeNative)).rejects.toThrow(
      "disk full",
    );
    expect(removes).toBe(0);
    expect(nativeRemoved).toBe(false);
    failWrites(false);
    await expect(inbox.ingestAndAcknowledge(actionEntry, removeNative)).rejects.toThrow(
      "acknowledgement lost",
    );
    expect((await inbox.load()).entries).toEqual([actionEntry]);
    const restarted = createWatchInbox(storage);
    await restarted.ingestAndAcknowledge(
      { ...actionEntry, commandId: "unused-replay-id" },
      removeNative,
    );
    expect(nativeRemoved).toBe(true);
    expect((await restarted.load()).entries).toEqual([actionEntry]);
  });

  it("acknowledges durable tombstones without resurrecting them and leaves conflicting native IDs pending", async () => {
    const { inbox, storage } = fixture();
    await inbox.ingest(actionEntry);
    await inbox.edit(actionEntry.id, (entry) => ({ ...entry, state: "dismissed" }));
    const restarted = createWatchInbox(storage);
    let removes = 0;
    const removeNative = async () => {
      removes++;
    };
    await restarted.ingestAndAcknowledge(actionEntry, removeNative);
    expect((await restarted.load()).entries[0]?.state).toBe("dismissed");
    await expect(
      restarted.ingestAndAcknowledge(
        { ...actionEntry, action: { ...actionEntry.action!, kind: "reopen" } },
        removeNative,
      ),
    ).rejects.toThrow("reused an ID");
    expect(removes).toBe(1);
    await restarted.update((current) => ({ ...current, owners: { "env-a": "account-a" } }));
    const errors: unknown[] = [];
    const removed: string[] = [];
    const valid = { ...actionEntry.action!, id: "later" };
    const importOptions = {
      commandId: () => "new-import-command",
      acknowledge: async (id: string) => {
        expect(
          JSON.parse((await storage.read())!).entries.some(
            (entry: InboxEntry) => entry.id === `action:${id}`,
          ),
        ).toBe(true);
        if (id === "ack-lost") throw new Error("acknowledgement lost");
        removed.push(id);
      },
      report: (error: unknown) => {
        errors.push(error);
      },
    };
    await restarted.importActions(
      [
        { ...actionEntry.action!, kind: "reopen" },
        valid,
        { ...valid, id: "invalid", kind: "approval", decision: "allow" },
        { ...valid, id: "ack-lost" },
        { ...valid, id: "last" },
      ],
      importOptions,
    );
    expect(removed).toEqual(["later", "last"]);
    expect(errors).toHaveLength(3);
    expect((await restarted.load()).entries[0]?.state).toBe("dismissed");
    expect((await restarted.load()).entries.map((entry) => entry.id)).toEqual([
      actionEntry.id,
      "action:later",
      "action:ack-lost",
      "action:last",
    ]);
    await expect(restarted.importActions(null, importOptions)).rejects.toThrow();
  });

  it("serializes duplicate arrivals and rejects reused IDs without replacing the original payload", async () => {
    const { inbox } = fixture();
    await Promise.all([
      inbox.ingest(actionEntry),
      inbox.ingest({ ...actionEntry, commandId: "unused-duplicate-id" }),
    ]);
    expect((await inbox.load()).entries).toEqual([actionEntry]);
    await expect(
      inbox.ingest({ ...actionEntry, action: { ...actionEntry.action!, threadId: "other" } }),
    ).rejects.toThrow("reused an ID");
    expect((await inbox.load()).entries).toEqual([actionEntry]);
  });

  it("persists immutable IDs and payload before sending, retries a lost ack with the same ID, and never replays completed actions", async () => {
    for (const kind of ["settle", "reopen"] as const) {
      const { inbox, storage } = fixture();
      const review: InboxEntry = { ...actionEntry, action: { ...actionEntry.action!, kind } };
      const prepared: InboxEntry = {
        ...review,
        state: "prepared",
        payload: JSON.stringify(prepareWatchMutation(review, thread)),
      };
      await inbox.ingest(prepared);
      const receipts = new Set<string>();
      const attempts: string[] = [];
      let applications = 0;
      let currentThread = thread;
      const send = async (entry: InboxEntry) => {
        const command = prepareWatchMutation(
          entry,
          validateWatchTarget(entry, "account-a", [currentThread]),
        );
        expect(JSON.stringify(command)).toBe(prepared.payload);
        expect((await storage.read())!).toContain(entry.payload!.replaceAll('"', '\\"'));
        attempts.push(command.commandId);
        if (!receipts.has(command.commandId)) {
          receipts.add(command.commandId);
          applications++;
          currentThread = { ...thread, updatedAt: "2026-10-28T11:00:00Z", status: "running" };
          throw new Error("ack lost");
        }
      };
      await expect(inbox.dispatch(prepared.id, () => "account-a", send)).rejects.toThrow(
        "ack lost",
      );
      const restarted = createWatchInbox(storage);
      await restarted.dispatch(prepared.id, () => "account-a", send);
      await restarted.dispatch(prepared.id, () => "account-a", send);
      expect(attempts).toEqual(["command-one", "command-one"]);
      expect(applications).toBe(1);
      expect((await restarted.load()).entries[0]?.state).toBe("completed");
      expect(() =>
        prepareWatchMutation({ ...review, commandId: "fresh-command" }, currentThread),
      ).toThrow("changed");
    }
  });

  it("retains the prepared payload after a local acknowledgement write fails", async () => {
    const { inbox, storage, failWrites } = fixture();
    await inbox.ingest({ ...actionEntry, state: "prepared", payload: "original payload" });
    await expect(
      inbox.dispatch(
        actionEntry.id,
        () => "account-a",
        async () => {
          failWrites(true);
        },
      ),
    ).rejects.toThrow("disk full");
    failWrites(false);
    expect((await createWatchInbox(storage).load()).entries[0]).toMatchObject({
      commandId: "command-one",
      payload: "original payload",
      state: "prepared",
    });
  });

  it("never sends unprepared or cross-account entries, including after restart", async () => {
    const { inbox, storage } = fixture();
    await inbox.ingest(actionEntry);
    let calls = 0;
    const send = async () => {
      calls++;
    };
    await expect(inbox.dispatch(actionEntry.id, () => "account-a", send)).rejects.toThrow(
      "persist",
    );
    await inbox.edit(actionEntry.id, (entry) => ({
      ...entry,
      state: "prepared",
      payload: "payload",
    }));
    for (const owner of [null, "account-b"]) {
      await expect(
        createWatchInbox(storage).dispatch(actionEntry.id, () => owner, send),
      ).rejects.toThrow("account changed");
    }
    expect(calls).toBe(0);
  });

  it("fails closed on damaged storage instead of resetting deduplication history", async () => {
    const inbox = createWatchInbox({
      read: () => Promise.resolve('{"version":2}'),
      write: async () => {
        throw new Error("must not write");
      },
      changed: () => {},
      digest: async (source: string) =>
        NodeCrypto.createHash("sha256").update(source).digest("hex"),
    });
    await expect(inbox.ingest(actionEntry)).rejects.toThrow();
  });
});

describe("Watch validation and routing", () => {
  it("accepts explicit question review without fabricating an answer, distinct from choices and permission review", () => {
    const identity = {
      id: "action-one",
      environmentId: "env-a",
      threadId: "thread-a",
      requestId: "request-a",
    };
    const review = decodeAction({ ...identity, kind: "answer", decision: "review-on-phone" });
    expect(review.answer).toBeUndefined();
    expect(review.questionId).toBeUndefined();
    const entry: InboxEntry = { ...actionEntry, action: review };
    const question: WatchThread = {
      ...thread,
      pendingRequest: {
        id: "request-a",
        kind: "question",
        title: "Question",
        detail: "Review on iPhone",
      },
    };
    expect(validateWatchTarget(entry, "account-a", [question])).toBe(question);
    expect(() => validateWatchMutation(entry, question)).toThrow(
      "Review questions and permissions",
    );
    expect(
      decodeAction({ ...identity, kind: "answer", questionId: "question-a", answer: "Yes" }).answer,
    ).toBe("Yes");
    expect(decodeAction({ ...identity, kind: "approval", decision: "review-on-phone" }).kind).toBe(
      "approval",
    );
    for (const invalid of [
      { ...identity, kind: "answer" },
      { ...identity, kind: "answer", decision: "review-on-phone", answer: "fabricated" },
      { ...identity, kind: "answer", decision: "review-on-phone", questionId: "old-question" },
      { ...identity, kind: "approval", decision: "allow" },
    ])
      expect(() => decodeAction(invalid)).toThrow();
  });

  it("keeps exact reply identities and persists an ISO recording plus transcript across reload", async () => {
    const { inbox, storage } = fixture();
    const recording = decodeRecording({
      id: "recording-one",
      uri: "file:///watch/one.m4a",
      createdAt: "2026-10-28T10:00:00Z",
      kind: "reply",
      environmentId: "env-a",
      threadId: "thread-a",
    });
    const entry: InboxEntry = {
      ...actionEntry,
      id: "recording:one",
      action: undefined,
      recording,
      transcript: "Keep & review? Yes.",
    };
    await inbox.ingest(entry);
    const restored = (await createWatchInbox(storage).load()).entries[0]!;
    expect(prepareWatchHandoff(restored)).toBe(
      "/threads/env-a/thread-a?prompt=Keep+%26+review%3F+Yes.",
    );
    expect(() =>
      validateWatchTarget(restored, "account-a", [{ ...thread, environmentId: "env-b" }]),
    ).toThrow("never redirected");
    expect(() => validateWatchTarget(restored, "account-b", [thread])).toThrow("another account");
    expect(() => validateWatchTarget({ ...restored, owner: null }, "account-a", [thread])).toThrow(
      "not been claimed",
    );
    expect(
      prepareWatchHandoff({
        ...restored,
        recording: {
          ...recording,
          kind: "new-thread",
          environmentId: undefined,
          threadId: undefined,
        },
      }),
    ).toBe("/new?prompt=Keep+%26+review%3F+Yes.");
    expect(() => prepareWatchHandoff({ ...restored, transcript: "x".repeat(8001) })).toThrow(
      "retained",
    );
  });

  it("distinguishes questions from permissions, rejects stale choices, but allows safe current-thread review", () => {
    const answer: InboxEntry = {
      ...actionEntry,
      action: {
        ...actionEntry.action!,
        kind: "answer",
        requestId: "request-a",
        questionId: "question-a",
        answer: "Yes",
      },
    };
    const question: WatchThread = {
      ...thread,
      pendingRequest: {
        id: "request-a",
        kind: "question",
        title: "Choose",
        detail: "Full review on phone",
      },
    };
    expect(validateWatchTarget(answer, "account-a", [question])).toBe(question);
    for (const pendingRequest of [
      undefined,
      { ...question.pendingRequest!, id: "request-b" },
      { ...question.pendingRequest!, kind: "approval" as const },
    ]) {
      expect(() =>
        validateWatchTarget(answer, "account-a", [{ ...thread, pendingRequest }]),
      ).toThrow("stale");
    }
    expect(validateWatchTarget(answer, "account-a", [thread], false)).toBe(thread);
    expect(() => validateWatchMutation(answer, question)).toThrow(
      "Review questions and permissions",
    );
  });

  it("requires unchanged idle state for phone-confirmed mutations and never settles running or pending work", () => {
    expect(() => validateWatchMutation(actionEntry, thread)).not.toThrow();
    expect(() =>
      validateWatchMutation(actionEntry, { ...thread, updatedAt: "2026-10-28T11:00:00Z" }),
    ).toThrow("changed");
    for (const status of ["queued", "preparing", "starting", "running", "waiting"]) {
      expect(() => validateWatchMutation(actionEntry, { ...thread, status })).toThrow(
        "pending work",
      );
    }
    expect(() =>
      validateWatchMutation(actionEntry, {
        ...thread,
        pendingRequest: { id: "request", kind: "approval", title: "Permission", detail: "Review" },
      }),
    ).toThrow("pending work");
    const original = prepareWatchMutation(actionEntry, thread);
    const prepared: InboxEntry = {
      ...actionEntry,
      state: "prepared",
      payload: JSON.stringify(original),
    };
    for (const payload of [
      "not-json",
      JSON.stringify({ ...original, type: "thread.delete" }),
      JSON.stringify({ ...original, type: "thread.unsettle", reason: "user" }),
      JSON.stringify({ ...original, commandId: "different-command" }),
      JSON.stringify({ ...original, threadId: "different-thread" }),
      JSON.stringify({ ...original, expectedUpdatedAt: undefined }),
      JSON.stringify({ ...original, expectedUpdatedAt: "2026-10-28T11:00:00Z" }),
      JSON.stringify({ ...original, settledAt: thread.updatedAt }),
    ])
      expect(() => prepareWatchMutation({ ...prepared, payload }, thread)).toThrow();
    expect(() => prepareWatchMutation({ ...prepared, payload: undefined }, thread)).toThrow();
    expect(() =>
      prepareWatchMutation(prepared, { ...thread, environmentId: "different-env" }),
    ).toThrow();
    expect(() => prepareWatchMutation(prepared, { ...thread, id: "different-thread" })).toThrow();
    expect(() => validateWatchTarget(prepared, "account-b", [thread])).toThrow("another account");
  });

  it("clears snapshots on sign-out or switch and bounds UTF8, count and whole JSON without leaking extra fields", () => {
    const inbox = { ...EMPTY_INBOX, enabledOwner: "account-a", owners: { "env-a": "account-a" } };
    const oversized = {
      ...thread,
      title: "🦊".repeat(200),
      projectTitle: "日本語".repeat(200),
      latestMessage: "界".repeat(1000),
      credential: "must-not-leak",
    };
    const candidates = Array.from({ length: 40 }, (_, index) => ({
      ...oversized,
      id: String(index),
      pendingRequest: {
        id: String(index),
        kind: "question" as const,
        title: "a",
        detail: "界".repeat(1000),
      },
    }));
    const json = buildWatchSnapshot("account-a", inbox, candidates);
    const snapshot = JSON.parse(json);
    expect(snapshot.threads.length).toBeLessThanOrEqual(20);
    expect(snapshot.threads.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(json).byteLength).toBeLessThanOrEqual(48 * 1024);
    expect(new TextEncoder().encode(snapshot.threads[0].title).byteLength).toBeLessThanOrEqual(256);
    expect(
      new TextEncoder().encode(snapshot.threads[0].projectTitle).byteLength,
    ).toBeLessThanOrEqual(256);
    expect(
      new TextEncoder().encode(snapshot.threads[0].latestMessage).byteLength,
    ).toBeLessThanOrEqual(2048);
    expect(json).not.toContain("credential");
    for (const owner of [null, "account-b"])
      expect(JSON.parse(buildWatchSnapshot(owner, inbox, candidates)).threads).toEqual([]);
    expect(
      JSON.parse(
        buildWatchSnapshot("account-b", { ...inbox, enabledOwner: "account-b" }, candidates),
      ).threads,
    ).toEqual([]);
    expect(
      JSON.parse(buildWatchSnapshot("account-a", inbox, [{ ...thread, environmentId: "unbound" }]))
        .threads,
    ).toEqual([]);
  });
});

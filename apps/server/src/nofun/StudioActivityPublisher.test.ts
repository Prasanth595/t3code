import { describe, expect, it } from "@effect/vitest";

import {
  activityPayloadHash,
  decodeStudioActivityState,
  canonicalActivityJson,
  StudioActivityPublisher,
  type ActivityProducerInput,
  type ActivityAcknowledgement,
  type StudioActivityState,
  type ActivityThreadRead,
} from "./StudioActivityPublisher.ts";

function ack(input: ActivityProducerInput): ActivityAcknowledgement {
  return {
    eventId: `evt_${input.stamp!.sequence}`,
    verdict: "accept",
    stamp: input.stamp!,
    payloadHash: input.payloadHash!,
  };
}

const NOW = "2026-10-12T00:00:00.000Z";
const EPOCH = "epoch-f08-test";

const ALLOWED_PROJECT = "project:allowed";
const CATCHES_PROJECT = "project:catches-secret";
const UNKNOWN_PROJECT = "project:unknown-outsider";

function row(overrides: Partial<ActivityThreadRead> = {}): ActivityThreadRead {
  return {
    threadId: "thread:allowed-1",
    projectId: ALLOWED_PROJECT,
    projectKind: "standard",
    repo: "/work/allowed",
    runId: "run:allowed-1",
    title: "Allowed thread title",
    state: "running",
    revision: "rev-1",
    lastEventAt: NOW,
    ...overrides,
  };
}

function fixtureReads(): ActivityThreadRead[] {
  return [
    row(),
    row({
      threadId: "thread:allowed-2",
      runId: null,
      title: "Second allowed thread",
      state: "waiting",
      revision: "rev-2",
    }),
    // Excluded: catches project (id + title must never reach output bytes).
    row({
      threadId: "thread:catches-9",
      projectId: CATCHES_PROJECT,
      projectKind: "catches",
      repo: "/work/catches-vault",
      runId: "run:catches-9",
      title: "Secret Catches Plans DO-NOT-LEAK",
      state: "running",
      revision: "rev-9",
    }),
    // Excluded: unknown project, not on the allowlist.
    row({
      threadId: "thread:outsider-7",
      projectId: UNKNOWN_PROJECT,
      projectKind: "unknown",
      repo: "/work/outsider",
      title: "Outsider Mystery DO-NOT-LEAK",
      state: "running",
      revision: "rev-7",
    }),
    // Excluded: allowed project but outside the persona's allowed roots.
    row({
      threadId: "thread:elsewhere-3",
      title: "Elsewhere Work DO-NOT-LEAK",
      repo: "/elsewhere/private",
      revision: "rev-3",
    }),
  ];
}

function setup(
  options: {
    online?: boolean;
    send?: (
      input: ActivityProducerInput,
    ) => ActivityAcknowledgement | Promise<ActivityAcknowledgement> | void;
  } = {},
) {
  const { online = true, send } = options;
  const sent: ActivityProducerInput[] = [];
  const sink = {
    send:
      send ??
      ((input: ActivityProducerInput) => {
        sent.push(input);
        return ack(input);
      }),
  };
  const publisher = new StudioActivityPublisher({
    epoch: EPOCH,
    retryBaseMs: 0,
    allowedProjectIds: [ALLOWED_PROJECT],
    allowedRoots: ["/work"],
    reads: { listActivityThreads: () => fixtureReads() },
    sink,
    now: () => NOW,
    online,
  });
  return { publisher, sent };
}

describe("StudioActivityPublisher", () => {
  it("keeps sequences increasing across a restart when seeded from the clock", async () => {
    const make = (initialSequence: number, sent: ActivityProducerInput[]) =>
      new StudioActivityPublisher({
        epoch: EPOCH,
        initialSequence,
        allowedProjectIds: [ALLOWED_PROJECT],
        allowedRoots: ["/work"],
        reads: { listActivityThreads: () => fixtureReads() },
        sink: { send: (input) => void sent.push(input) },
        now: () => NOW,
      });
    const before: ActivityProducerInput[] = [];
    const first = make(1_760_000_000_000, before);
    await first.publishNow();
    await first.publishNow();
    const after: ActivityProducerInput[] = [];
    const restarted = make(1_760_000_060_000, after);
    await restarted.publishNow();
    const lastBefore = before.at(-1)!.stamp!.sequence;
    expect(before[0]!.stamp!.sequence).toBe(1_760_000_000_000);
    expect(after[0]!.stamp!.sequence).toBeGreaterThan(lastBefore);
    expect(after[0]!.stamp!.epoch).toBe(before[0]!.stamp!.epoch);
  });

  it("publishes an ExternalProducerInput-shaped envelope with only allowed references", async () => {
    const { publisher, sent } = setup();
    const result = await publisher.publishNow();
    expect(result.delivered).toBe(true);
    expect(sent).toHaveLength(1);
    const envelope = sent[0]!;
    expect(envelope.partition_id).toBe("t3.activity");
    expect(envelope.status).toBe("online");
    expect(envelope.stamp).toMatchObject({
      producer_id: "t3.activity-publisher",
      epoch: EPOCH,
      sequence: 1,
    });
    expect(envelope.stamp!.emitted_at).toBe(NOW);
    expect(envelope.observed_at).toBe(NOW);
    expect(envelope.partial).toBe(false);
    // Hash covers exactly the published record bytes.
    expect(envelope.payloadHash).toBe(activityPayloadHash(canonicalActivityJson(envelope.records)));
    // Only the two allowed rows; thin fields only.
    expect(envelope.records.map((r) => r.projection_id)).toEqual([
      "t3.activity:thread:allowed-1:run:allowed-1",
      "t3.activity:thread:allowed-2:no-run",
    ]);
    for (const record of envelope.records) {
      expect(record.origin_id).toBe(ALLOWED_PROJECT);
      expect(record.provenance).toBe("known");
      expect(record.restriction).toBe("none");
      expect(record.correlation).toBeNull();
    }
    // Excluded identities and titles never appear — not even as omission ids.
    const bytes = JSON.stringify(envelope);
    for (const banned of [
      CATCHES_PROJECT,
      UNKNOWN_PROJECT,
      "thread:catches-9",
      "thread:outsider-7",
      "thread:elsewhere-3",
      "DO-NOT-LEAK",
      "catches-vault",
    ]) {
      expect(bytes).not.toContain(banned);
    }
    // No transcript / message text marker passes through.
    expect(bytes).not.toContain("secret transcript body");
    expect(publisher.pendingCount).toBe(0);
  });

  it("retry resends the original update identity (same stamp, same bytes)", async () => {
    let calls = 0;
    const seen: string[] = [];
    const { publisher } = setup({
      send: (input) => {
        calls += 1;
        seen.push(canonicalActivityJson(input));
        if (calls === 1) throw new Error("network down");
        return ack(input);
      },
    });
    const first = await publisher.publishNow();
    expect(first.delivered).toBe(false);
    const queued = (first as { envelope: ActivityProducerInput }).envelope;
    const retry = await publisher.retryPending();
    expect(retry).toHaveLength(1);
    expect(retry[0]).toMatchObject({ verdict: "accept", sent: true });
    expect(retry[0]!.stamp).toEqual(queued.stamp);
    // Identical bytes on the wire: same canonical payload, same sequence.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(publisher.pendingCount).toBe(0);
  });

  it("a newer full snapshot supersedes older unsent updates instead of growing the queue", async () => {
    const { publisher } = setup({
      send: () => {
        throw new Error("network down");
      },
    });
    await publisher.publishNow();
    await publisher.publishNow();
    const third = await publisher.publishNow();
    expect(publisher.pendingCount).toBe(1);
    const retry = await publisher.retryPending();
    expect(retry.map((r) => r.stamp.sequence)).toEqual([
      (third as { envelope: ActivityProducerInput }).envelope.stamp!.sequence,
    ]);
  });

  it("offline resume cannot overwrite a newer watermark; older pending is dropped, duplicates replay", async () => {
    const { publisher } = setup({
      send: () => {
        throw new Error("lost");
      },
    });
    await publisher.publishNow();
    expect(publisher.pendingCount).toBe(1);
    // Bridge accepted a NEWER stamp (sequence 5): the queued seq-1 is stale.
    const accept = publisher.observeWatermark(
      { producer_id: "t3.activity-publisher", epoch: EPOCH, sequence: 5, emitted_at: NOW },
      "hash-of-newer-bridge-state",
    );
    expect(accept.verdict).toBe("accept");
    expect(accept.dropped).toBe(1);
    expect(publisher.pendingCount).toBe(0);
    expect(publisher.lastAckedStamp?.sequence).toBe(5);
    // An older stamp cannot move the watermark backwards.
    const stale = publisher.observeWatermark(
      { producer_id: "t3.activity-publisher", epoch: EPOCH, sequence: 3, emitted_at: NOW },
      "hash-older",
    );
    expect(stale.verdict).toBe("reject_stale");
    expect(publisher.lastAckedStamp?.sequence).toBe(5);
    // Next publish continues the monotonic sequence past the watermark.
    const next = await publisher.publishNow();
    expect(next.delivered).toBe(false);
    expect((next as { envelope: ActivityProducerInput }).envelope.stamp?.sequence).toBe(6);
    // Observing the same stamp with the same bytes replays as a duplicate.
    const accepted = (next as { envelope: ActivityProducerInput }).envelope;
    const firstSight = publisher.observeWatermark(accepted.stamp!, accepted.payloadHash!);
    expect(firstSight.verdict).toBe("accept");
    const dup = publisher.observeWatermark(accepted.stamp!, accepted.payloadHash!);
    expect(dup.verdict).toBe("replay_duplicate");
    expect(publisher.lastAckedStamp?.sequence).toBe(6);
  });

  it("producer offline: the sink is not called and nothing is fabricated", async () => {
    const { publisher, sent } = setup({ online: false });
    const result = await publisher.publishNow();
    expect(result.delivered).toBe(false);
    expect(sent).toHaveLength(0);
    const envelope = (result as { envelope: ActivityProducerInput }).envelope;
    expect(envelope.status).toBe("offline");
    expect(envelope.stamp).toBeNull();
    expect(envelope.payloadHash).toBeNull();
    expect(envelope.records).toEqual([]);
    expect(publisher.pendingCount).toBe(0);
  });

  it("a throwing read is treated as offline without calling the sink", async () => {
    const sent: ActivityProducerInput[] = [];
    const publisher = new StudioActivityPublisher({
      epoch: EPOCH,
      allowedProjectIds: [ALLOWED_PROJECT],
      reads: {
        listActivityThreads: () => {
          throw new Error("store gone");
        },
      },
      sink: { send: (input) => void sent.push(input) },
      now: () => NOW,
    });
    const result = await publisher.publishNow();
    expect(result.delivered).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("observed acceptance and recovery", () => {
  it("never calls a resolved void transport delivered", async () => {
    const { publisher } = setup({ send: () => {} });
    expect((await publisher.publishNow()).delivered).toBe(false);
    expect(publisher.lastAckedStamp).toBeNull();
    expect(publisher.pendingCount).toBe(1);
  });

  it("persists pending before send and resumes identical bytes after restart with backoff", async () => {
    let persisted: StudioActivityState | null = null;
    const stateStore = {
      load: async () => structuredClone(persisted),
      save: async (state: StudioActivityState) => {
        persisted = structuredClone(state);
      },
    };
    let clock = 1000;
    const seen: string[] = [];
    let fail = true;
    const make = () =>
      new StudioActivityPublisher({
        epoch: EPOCH,
        allowedProjectIds: [],
        reads: { listActivityThreads: () => [] },
        stateStore,
        nowMs: () => clock,
        sink: {
          send: (input) => {
            expect(persisted?.pending).toHaveLength(1);
            seen.push(JSON.stringify(input));
            if (fail) throw new Error("lost");
            return ack(input);
          },
        },
      });
    const first = make();
    expect((await first.publishNow()).delivered).toBe(false);
    const resumed = make();
    await resumed.initialize();
    await resumed.retryPending();
    expect(seen).toHaveLength(1);
    clock += 1000;
    fail = false;
    await resumed.retryPending();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
    expect((persisted as StudioActivityState | null)?.pending).toHaveLength(0);
    const third = make();
    await third.initialize();
    expect(third.lastAckedStamp?.sequence).toBe(1);
  });

  it("reconciles lost responses, duplicate and reordered replay without regressing the watermark", async () => {
    let saved: StudioActivityState | null = null;
    let cursor: string | null | undefined;
    const seen: ActivityProducerInput[] = [];
    const publisher = new StudioActivityPublisher({
      epoch: EPOCH,
      allowedProjectIds: [],
      reads: { listActivityThreads: () => [] },
      stateStore: {
        load: async () => null,
        save: async (state) => {
          saved = structuredClone(state);
        },
      },
      sink: {
        send: (input) => {
          seen.push(input);
          throw new Error("response lost");
        },
        readEvents: async (after) => {
          cursor = after;
          const receipt = ack(seen[0]!);
          return {
            events: [
              receipt,
              receipt,
              { ...receipt, eventId: "evt_older", stamp: { ...receipt.stamp, sequence: 0 } },
            ],
            cursor: "opaque-next",
            has_more: false,
            watermark: null,
          };
        },
      },
    });
    await publisher.publishNow();
    await publisher.recover();
    expect(cursor).toBeNull();
    expect(publisher.pendingCount).toBe(0);
    expect(publisher.lastAckedStamp?.sequence).toBe(1);
    expect((saved as StudioActivityState | null)?.cursor).toBe("opaque-next");
    expect((saved as StudioActivityState | null)?.seenEventIds).toEqual(["evt_1", "evt_older"]);
  });
  it("does not reconcile a conflicting hash or a foreign producer/epoch", async () => {
    const { publisher } = setup({
      send: () => {
        throw new Error("lost");
      },
    });
    const pending = (await publisher.publishNow()).envelope;
    const stamp = pending.stamp!;
    expect(publisher.observeWatermark(stamp, "different-hash").verdict).toBe("reject_conflict");
    expect(
      publisher.observeWatermark(
        { ...stamp, producer_id: "another-producer" },
        pending.payloadHash!,
      ).verdict,
    ).toBe("reject_epoch_reset_required");
    expect(
      publisher.observeWatermark({ ...stamp, epoch: "another-epoch" }, pending.payloadHash!)
        .verdict,
    ).toBe("reject_epoch_reset_required");
    expect(publisher.pendingCount).toBe(1);
    expect(publisher.lastAckedStamp).toBeNull();
  });

  it("bounds the accepted snapshot to the bridge's 200-record contract and marks coverage partial", async () => {
    const publisher = new StudioActivityPublisher({
      epoch: EPOCH,
      allowedProjectIds: [ALLOWED_PROJECT],
      reads: {
        listActivityThreads: () =>
          Array.from({ length: 201 }, (_, index) => row({ threadId: `thread-${index}` })),
      },
      sink: { send: ack },
      now: () => NOW,
    });
    const result = await publisher.publishNow();
    expect(result.delivered).toBe(true);
    expect(result.envelope.records).toHaveLength(200);
    expect(result.envelope.partial).toBe(true);
  });

  it("restores a validated cursor and dedupes replay across restart", async () => {
    let state: StudioActivityState | null = null;
    let input: ActivityProducerInput | undefined;
    const requested: Array<string | null> = [];
    const make = () =>
      new StudioActivityPublisher({
        epoch: EPOCH,
        allowedProjectIds: [],
        reads: { listActivityThreads: () => [] },
        stateStore: {
          load: async () =>
            state ? decodeStudioActivityState(JSON.parse(JSON.stringify(state))) : null,
          save: async (value) => {
            state = structuredClone(value);
          },
        },
        sink: {
          send: (value) => {
            input = value;
            throw new Error("lost");
          },
          readEvents: async (cursor) => {
            requested.push(cursor);
            return {
              cursor: "persisted-next",
              has_more: false,
              events: [ack(input!)],
              watermark: null,
            };
          },
        },
      });
    const first = make();
    await first.publishNow();
    await first.recover();
    const restarted = make();
    await restarted.recover();
    expect(requested).toEqual([null, "persisted-next"]);
    expect(restarted.lastAckedStamp?.sequence).toBe(1);
    expect(restarted.pendingCount).toBe(0);
    expect((state as StudioActivityState | null)?.seenEventIds).toEqual(["evt_1"]);
  });
});

import { describe, expect, it } from "@effect/vitest";

import {
  activityPayloadHash,
  canonicalActivityJson,
  StudioActivityPublisher,
  type ActivityProducerInput,
  type ActivityThreadRead,
} from "./StudioActivityPublisher.ts";

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
    send?: (input: ActivityProducerInput) => void | Promise<void>;
  } = {},
) {
  const { online = true, send } = options;
  const sent: ActivityProducerInput[] = [];
  const sink = { send: send ?? ((input: ActivityProducerInput) => void sent.push(input)) };
  const publisher = new StudioActivityPublisher({
    epoch: EPOCH,
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
    expect(publisher.pendingCount).toBe(1);
  });

  it("retry resends the original update identity (same stamp, same bytes)", async () => {
    let calls = 0;
    const seen: string[] = [];
    const { publisher } = setup({
      send: (input) => {
        calls += 1;
        seen.push(canonicalActivityJson(input));
        if (calls === 1) throw new Error("network down");
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
    const { publisher } = setup();
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
    expect(next.delivered).toBe(true);
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

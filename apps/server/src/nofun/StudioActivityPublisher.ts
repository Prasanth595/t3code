// @effect-diagnostics nodeBuiltinImport:off globalDate:off - plain deterministic module: sync sha256 and ISO timestamps, no Effect runtime.
// StudioActivityPublisher.ts — bounded T3 activity reference publisher.
//
// Turns existing orchestration projection reads into thin `t3.activity`
// producer references for the bridge studio snapshot (F07 consumer). One
// record per thread/run carries only: allowed persona/repo, thread id, run
// id, title, state, revision and last event time. Never transcript text,
// message bodies, provider auth or tokens.
//
// Shapes mirror the F07 consumer contract locally (do not import across
// repos): `ExternalProducerInput` with partition "t3.activity",
// `ProducerStamp`, and `classifyProducerUpdate` ordering semantics.
//
// Exclusion: Catches/client/private projects are excluded by an explicit
// allowlist plus a project-kind gate; unknown projects are excluded. Denied
// rows are dropped without their identities (no deliberatelyOmittedIds, so
// excluded ids/titles never reach output bytes).
//
// Persona (../persona.ts, labeling only) is respected through `allowedRoots`:
// a thread whose repo root sits outside the persona's allowed roots is
// excluded, mirroring `personaRootViolation` prefix semantics.
//
// The network send is an injected `sink`; this module performs no fetch and
// owns no scheduler.
//
import * as NodeCrypto from "node:crypto";
import { z } from "zod";

export const STUDIO_ACTIVITY_PARTITION = "t3.activity" as const;
export const STUDIO_ACTIVITY_PRODUCER_ID = "t3.activity-publisher" as const;
export const STUDIO_ACTIVITY_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;
const SUMMARY_MAX = 280;

/** Immutable publication stamp: (producer, epoch, sequence). */
export type ActivityProducerStamp = {
  producer_id: string;
  epoch: string;
  sequence: number;
  emitted_at: string;
};

/** Thin activity reference. Never carries transcript or message text. */
export type ActivityProducerRecord = {
  projection_id: string;
  origin_id: string;
  kind: "local_task";
  record_id: string;
  revision_scheme: string;
  revision_value: string;
  canonical_state: string;
  /** Thread title, truncated. Never raw body/message text. */
  summary: string;
  observed_at: string;
  fresh_until: string;
  correlation: null;
  provenance: "known";
  restriction: "none";
  derived: false;
};

/** Optional producer input. `stamp: null` means the producer was not read. */
export type ActivityProducerInput = {
  partition_id: typeof STUDIO_ACTIVITY_PARTITION;
  /** Online reachability of this read attempt (not data freshness). */
  status: "online" | "offline";
  stamp: ActivityProducerStamp | null;
  /** Hash of the producer payload bytes at `stamp` (for replay/conflict). */
  payloadHash: string | null;
  observed_at: string | null;
  heartbeat_at: string | null;
  records: ActivityProducerRecord[];
  partial: boolean;
};

/**
 * One thin orchestration read row. Wire to projection reads only
 * (`getShellSnapshot` / `getThreadShell`); never to message, turn-item or
 * transcript reads.
 */
export type ActivityThreadRead = {
  threadId: string;
  projectId: string;
  /** Catches/client/private/unknown projects are always excluded. */
  projectKind: "standard" | "catches" | "client" | "private" | "unknown";
  /** Workspace root / repo identity, checked against persona allowed roots. */
  repo: string;
  runId: string | null;
  title: string;
  state: string;
  revision: string;
  lastEventAt: string;
};

export type StudioActivityReads = {
  listActivityThreads: () =>
    | Promise<ReadonlyArray<ActivityThreadRead>>
    | ReadonlyArray<ActivityThreadRead>;
};

export type ActivityAcknowledgement = {
  eventId: string;
  verdict: "accept" | "replay_duplicate";
  stamp: ActivityProducerStamp;
  payloadHash: string;
};
export type ActivityReplayPage = {
  events: ActivityAcknowledgement[];
  cursor: string | null;
  has_more: boolean;
  watermark: ActivityAcknowledgement | null;
};
export type StudioActivitySink = {
  send: (
    input: ActivityProducerInput,
  ) => Promise<ActivityAcknowledgement | void> | ActivityAcknowledgement | void;
  readEvents?: (cursor: string | null, producerId: string) => Promise<ActivityReplayPage>;
};
export type StudioActivityState = {
  version: 1;
  producerId: string;
  epoch: string;
  nextSequence: number;
  watermark: ActivityAcknowledgement | null;
  pending: QueuedActivityUpdate[];
  cursor: string | null;
  seenEventIds: string[];
  failures: number;
  retryAt: number;
};
export type StudioActivityStateStore = {
  load: () => Promise<StudioActivityState | null>;
  save: (state: StudioActivityState) => Promise<void>;
};

export type StudioActivityPublisherOptions = {
  producerId?: string;
  epoch: string;
  /** Explicit allowlist. Unknown (unlisted) projects are excluded. */
  allowedProjectIds: ReadonlySet<string> | ReadonlyArray<string>;
  /** Persona allowed roots (labeling, not auth). Empty/absent: no restriction. */
  allowedRoots?: ReadonlyArray<string>;
  reads: StudioActivityReads;
  sink: StudioActivitySink;
  now?: () => string;
  online?: boolean;
  /** First sequence number. Seed from the clock so sequences stay monotonic across restarts. */
  initialSequence?: number;
  stateStore?: StudioActivityStateStore;
  nowMs?: () => number;
  retryBaseMs?: number;
};

/** Deterministic canonical JSON: sorted object keys, compact separators. */
export function canonicalActivityJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalActivityJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalActivityJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function activityPayloadHash(canonicalBytes: string): string {
  return NodeCrypto.createHash("sha256").update(canonicalBytes, "utf8").digest("hex");
}

export type ProducerUpdateVerdict =
  | "accept"
  | "replay_duplicate"
  | "reject_stale"
  | "reject_conflict"
  | "reject_epoch_reset_required";

/**
 * Ordering guard for one producer stream (mirrors F07
 * classifyProducerUpdate). Newer sequences win; duplicates dedupe; older or
 * conflicting updates never regress state.
 */
export function classifyProducerUpdate(args: {
  current: ActivityProducerStamp | null;
  incoming: ActivityProducerStamp;
  bytesEqual: boolean;
}): ProducerUpdateVerdict {
  const { current, incoming, bytesEqual } = args;
  if (!current) return "accept";
  if (incoming.epoch !== current.epoch) return "reject_epoch_reset_required";
  if (incoming.sequence > current.sequence) return "accept";
  if (incoming.sequence === current.sequence)
    return bytesEqual ? "replay_duplicate" : "reject_conflict";
  return "reject_stale";
}

const normalizeRoot = (value: string): string => {
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
};

const insideRoots = (roots: ReadonlyArray<string>, repo: string): boolean => {
  if (roots.length === 0) return true;
  const target = normalizeRoot(repo);
  return roots.some((root) => {
    const norm = normalizeRoot(root);
    return target === norm || target.startsWith(norm === "/" ? norm : `${norm}/`);
  });
};

export type QueuedActivityUpdate = {
  stamp: ActivityProducerStamp;
  payloadHash: string;
  canonicalBytes: string;
  envelope: ActivityProducerInput;
};

// Persist only the same thin, allowlisted shell references sent to the bridge.
const persistedStamp = z
  .object({
    producer_id: z.string().min(1),
    epoch: z.string().min(1),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    emitted_at: z.iso.datetime({ offset: true }),
  })
  .strict();
const persistedEnvelope = z
  .object({
    partition_id: z.literal("t3.activity"),
    status: z.enum(["online", "offline"]),
    stamp: persistedStamp.nullable(),
    payloadHash: z.string().nullable(),
    observed_at: z.string().nullable(),
    heartbeat_at: z.string().nullable(),
    partial: z.boolean(),
    records: z
      .array(
        z
          .object({
            projection_id: z.string(),
            origin_id: z.string(),
            kind: z.literal("local_task"),
            record_id: z.string(),
            revision_scheme: z.string(),
            revision_value: z.string(),
            canonical_state: z.string(),
            summary: z.string().max(280),
            observed_at: z.string(),
            fresh_until: z.string(),
            correlation: z.null(),
            provenance: z.literal("known"),
            restriction: z.literal("none"),
            derived: z.literal(false),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
const persistedReceipt = z
  .object({
    eventId: z.string(),
    verdict: z.enum(["accept", "replay_duplicate"]),
    stamp: persistedStamp,
    payloadHash: z.string(),
  })
  .strict();
const persistedState = z
  .object({
    version: z.literal(1),
    producerId: z.string(),
    epoch: z.string(),
    nextSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    watermark: persistedReceipt.nullable(),
    pending: z
      .array(
        z
          .object({
            stamp: persistedStamp,
            payloadHash: z.string(),
            canonicalBytes: z.string(),
            envelope: persistedEnvelope,
          })
          .strict(),
      )
      .max(1),
    cursor: z.string().max(4096).nullable(),
    seenEventIds: z.array(z.string().max(200)).max(512),
    failures: z.number().int().min(0).max(16),
    retryAt: z.number().nonnegative(),
  })
  .strict();

export function decodeStudioActivityState(value: unknown): StudioActivityState {
  const state = persistedState.parse(value);
  for (const entry of state.pending) {
    if (
      canonicalActivityJson(entry.stamp) !== canonicalActivityJson(entry.envelope.stamp) ||
      entry.payloadHash !== entry.envelope.payloadHash ||
      entry.canonicalBytes !== canonicalActivityJson(entry.envelope.records) ||
      entry.payloadHash !== activityPayloadHash(entry.canonicalBytes) ||
      entry.stamp.producer_id !== state.producerId ||
      entry.stamp.epoch !== state.epoch ||
      entry.stamp.sequence >= state.nextSequence
    )
      throw new Error("activity_state_invalid");
  }
  if (
    state.watermark &&
    (state.watermark.stamp.producer_id !== state.producerId ||
      state.watermark.stamp.epoch !== state.epoch)
  )
    throw new Error("activity_state_invalid");
  return state;
}

export type PublishResult =
  | { delivered: true; envelope: ActivityProducerInput }
  | { delivered: false; status: "offline"; envelope: ActivityProducerInput }
  | { delivered: false; status: "send_failed"; envelope: ActivityProducerInput; error: unknown };

/**
 * Bounded publisher with an injected read interface and an injected sink.
 * Offline publishes never call the sink and fabricate nothing: they return a
 * stamped-empty offline envelope. Failed sends stay queued under their
 * original stamp and bytes; retry resends the identical envelope.
 */
export class StudioActivityPublisher {
  private readonly producerId: string;
  private readonly epoch: string;
  private allowedProjectIds: ReadonlySet<string>;
  private readonly allowedRoots: ReadonlyArray<string>;
  private readonly reads: StudioActivityReads;
  private readonly sink: StudioActivitySink;
  private readonly now: () => string;
  private online: boolean;
  private nextSequence = 1;
  private watermark: ActivityAcknowledgement | null = null;
  private readonly stateStore: StudioActivityStateStore | undefined;
  private readonly nowMs: () => number;
  private readonly retryBaseMs: number;
  private initialized = false;
  private cursor: string | null = null;
  private seenEventIds: string[] = [];
  private failures = 0;
  private retryAt = 0;
  private pending: QueuedActivityUpdate[] = [];

  constructor(options: StudioActivityPublisherOptions) {
    this.producerId = options.producerId ?? STUDIO_ACTIVITY_PRODUCER_ID;
    this.epoch = options.epoch;
    this.allowedProjectIds = new Set<string>(options.allowedProjectIds);
    this.allowedRoots = options.allowedRoots ?? [];
    this.reads = options.reads;
    this.sink = options.sink;
    this.now = options.now ?? (() => new Date().toISOString());
    this.online = options.online ?? true;
    this.nextSequence = options.initialSequence ?? 1;
    this.stateStore = options.stateStore;
    this.nowMs = options.nowMs ?? Date.now;
    this.retryBaseMs = options.retryBaseMs ?? 1000;
  }

  /** Restore before reading or sending; a broken store must not silently lose pending work. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    const state = await this.stateStore?.load();
    if (state) {
      if (
        state.version !== 1 ||
        state.producerId !== this.producerId ||
        state.epoch !== this.epoch ||
        !Number.isSafeInteger(state.nextSequence) ||
        state.pending.length > 1
      )
        throw new Error("activity_state_invalid");
      this.nextSequence = Math.max(this.nextSequence, state.nextSequence);
      this.watermark = state.watermark;
      this.pending = state.pending;
      this.cursor = state.cursor;
      this.seenEventIds = state.seenEventIds.slice(-512);
      this.failures = state.failures;
      this.retryAt = state.retryAt;
    }
    this.initialized = true;
  }

  private async persist(): Promise<void> {
    await this.stateStore?.save({
      version: 1,
      producerId: this.producerId,
      epoch: this.epoch,
      nextSequence: this.nextSequence,
      watermark: this.watermark,
      pending: this.pending,
      cursor: this.cursor,
      seenEventIds: this.seenEventIds,
      failures: this.failures,
      retryAt: this.retryAt,
    });
  }

  private remember(receipt: ActivityAcknowledgement): void {
    if (this.seenEventIds.includes(receipt.eventId)) return;
    if (
      !receipt.eventId ||
      receipt.stamp.producer_id !== this.producerId ||
      receipt.stamp.epoch !== this.epoch
    )
      return;
    this.observeWatermark(receipt.stamp, receipt.payloadHash, receipt.eventId);
    this.seenEventIds = [...this.seenEventIds, receipt.eventId].slice(-512);
  }

  /** One bounded replay page per tick; persist its opaque cursor only after reconciliation. */
  async recover(): Promise<boolean> {
    await this.initialize();
    if (!this.online || !this.sink.readEvents) return false;
    const page = await this.sink.readEvents(this.cursor, this.producerId);
    for (const receipt of page.events) this.remember(receipt);
    if (page.watermark) this.remember(page.watermark);
    this.cursor = page.cursor;
    await this.persist();
    return page.has_more;
  }

  private async deliver(entry: QueuedActivityUpdate): Promise<void> {
    const receipt = await this.sink.send(entry.envelope);
    if (
      !receipt ||
      !receipt.eventId ||
      !["accept", "replay_duplicate"].includes(receipt.verdict) ||
      canonicalActivityJson(receipt.stamp) !== canonicalActivityJson(entry.stamp) ||
      receipt.payloadHash !== entry.payloadHash
    ) {
      throw new Error("activity_ack_invalid");
    }
    this.remember(receipt);
    this.failures = 0;
    this.retryAt = 0;
    await this.persist();
  }

  private async failed(): Promise<void> {
    this.failures = Math.min(16, this.failures + 1);
    this.retryAt = this.nowMs() + Math.min(60_000, this.retryBaseMs * 2 ** (this.failures - 1));
    await this.persist();
  }

  setOnline(online: boolean): void {
    this.online = online;
  }

  /**
   * Refresh the explicit project allowlist (e.g. after project
   * create/delete). Unknown (unlisted) projects stay excluded.
   */
  setAllowedProjectIds(ids: ReadonlySet<string> | ReadonlyArray<string>): void {
    this.allowedProjectIds = new Set<string>(ids);
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get lastAckedStamp(): ActivityProducerStamp | null {
    return this.watermark?.stamp ?? null;
  }

  private offlineEnvelope(): ActivityProducerInput {
    return {
      partition_id: STUDIO_ACTIVITY_PARTITION,
      status: "offline",
      stamp: null,
      payloadHash: null,
      observed_at: null,
      heartbeat_at: null,
      records: [],
      partial: false,
    };
  }

  private eligible(row: ActivityThreadRead): boolean {
    if (row.projectKind !== "standard") return false;
    if (!this.allowedProjectIds.has(row.projectId)) return false;
    return insideRoots(this.allowedRoots, row.repo);
  }

  private toRecord(row: ActivityThreadRead): ActivityProducerRecord {
    const observed = row.lastEventAt;
    return {
      projection_id: `t3.activity:${row.threadId}:${row.runId ?? "no-run"}`,
      origin_id: row.projectId,
      kind: "local_task",
      record_id: row.runId ?? row.threadId,
      revision_scheme: "t3.run-revision",
      revision_value: row.revision,
      canonical_state: row.state,
      summary: row.title.length <= SUMMARY_MAX ? row.title : row.title.slice(0, SUMMARY_MAX),
      observed_at: observed,
      fresh_until: new Date(
        Date.parse(observed) + STUDIO_ACTIVITY_FRESHNESS_WINDOW_MS,
      ).toISOString(),
      correlation: null,
      provenance: "known",
      restriction: "none",
      derived: false,
    };
  }

  private buildEnvelope(rows: ReadonlyArray<ActivityThreadRead>): {
    envelope: ActivityProducerInput;
    bytes: string;
  } {
    const at = this.now();
    const records = rows.filter((row) => this.eligible(row)).map((row) => this.toRecord(row));
    records.sort(
      (a, b) =>
        Date.parse(b.observed_at) - Date.parse(a.observed_at) ||
        (a.projection_id < b.projection_id ? -1 : 1),
    );
    const boundedRecords = records.slice(0, 200);
    const bytes = canonicalActivityJson(boundedRecords);
    const stamp: ActivityProducerStamp = {
      producer_id: this.producerId,
      epoch: this.epoch,
      sequence: this.nextSequence,
      emitted_at: at,
    };
    return {
      bytes,
      envelope: {
        partition_id: STUDIO_ACTIVITY_PARTITION,
        status: "online",
        stamp,
        payloadHash: activityPayloadHash(bytes),
        observed_at: at,
        heartbeat_at: at,
        records: boundedRecords,
        partial: records.length > boundedRecords.length,
      },
    };
  }

  // Every update is a full snapshot, so a newer one supersedes any older
  // unacknowledged update: the queue holds at most one entry.
  private queue(envelope: ActivityProducerInput, bytes: string): void {
    this.pending = [
      {
        stamp: envelope.stamp!,
        payloadHash: envelope.payloadHash!,
        canonicalBytes: bytes,
        envelope,
      },
    ];
    this.nextSequence += 1;
  }

  /** Build from current reads and send. Offline: sink untouched, nothing queued. */
  async publishNow(): Promise<PublishResult> {
    await this.initialize();
    if (!this.online)
      return { delivered: false, status: "offline", envelope: this.offlineEnvelope() };
    let rows: ReadonlyArray<ActivityThreadRead>;
    try {
      rows = await this.reads.listActivityThreads();
    } catch {
      return { delivered: false, status: "offline", envelope: this.offlineEnvelope() };
    }
    const { envelope, bytes } = this.buildEnvelope(rows);
    this.queue(envelope, bytes);
    // Durable outbox before network I/O, including the allocated sequence.
    await this.persist();
    if (this.nowMs() < this.retryAt)
      return {
        delivered: false,
        status: "send_failed",
        envelope,
        error: new Error("activity_backoff"),
      };
    try {
      await this.deliver(this.pending[0]!);
    } catch (error) {
      await this.failed();
      return { delivered: false, status: "send_failed", envelope, error };
    }
    return { delivered: true, envelope };
  }

  async retryPending(): Promise<
    Array<{
      stamp: ActivityProducerStamp;
      verdict: ProducerUpdateVerdict;
      sent: boolean;
      error?: unknown;
    }>
  > {
    await this.initialize();
    const entry = this.pending[0];
    if (!entry || !this.online || this.nowMs() < this.retryAt) return [];
    try {
      await this.deliver(entry);
      return [{ stamp: entry.stamp, verdict: "accept", sent: true }];
    } catch (error) {
      await this.failed();
      return [{ stamp: entry.stamp, verdict: "accept", sent: false, error }];
    }
  }

  /**
   * Observe the bridge-accepted (or remotely newer) watermark. A newer stamp
   * wins and drops covered pending updates; an older stamp can never move the
   * watermark backwards.
   */
  observeWatermark(
    stamp: ActivityProducerStamp,
    payloadHash: string,
    eventId = "",
  ): { verdict: ProducerUpdateVerdict; dropped: number } {
    if (stamp.producer_id !== this.producerId || stamp.epoch !== this.epoch)
      return { verdict: "reject_epoch_reset_required", dropped: 0 };
    if (
      this.pending.some(
        (entry) =>
          entry.stamp.epoch === stamp.epoch &&
          entry.stamp.sequence === stamp.sequence &&
          entry.payloadHash !== payloadHash,
      )
    )
      return { verdict: "reject_conflict", dropped: 0 };
    const verdict = classifyProducerUpdate({
      current: this.watermark?.stamp ?? null,
      incoming: stamp,
      bytesEqual:
        this.watermark !== null &&
        this.watermark.payloadHash === payloadHash &&
        this.watermark.stamp.sequence === stamp.sequence &&
        this.watermark.stamp.epoch === stamp.epoch,
    });
    if (verdict !== "accept") return { verdict, dropped: 0 };
    this.watermark = { stamp, payloadHash, eventId, verdict: "accept" };
    if (stamp.sequence + 1 > this.nextSequence) this.nextSequence = stamp.sequence + 1;
    const before = this.pending.length;
    this.pending = this.pending.filter(
      (entry) => entry.stamp.epoch !== stamp.epoch || entry.stamp.sequence > stamp.sequence,
    );
    return { verdict, dropped: before - this.pending.length };
  }
}

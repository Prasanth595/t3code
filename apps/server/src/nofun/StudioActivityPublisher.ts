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
// REGISTRATION REQUEST (for root; this file edits nothing shared):
// - Inject one publisher in apps/server/src/orchestration-v2/runtimeLayer.ts
//   next to the existing projection-store-backed services (same layer block
//   as the settlement/recovery readers), constructed with the persona scope
//   from readNofunPersonaScope and the explicit project allowlist.
// - Drive it from the existing thread/shell refresh trigger that already
//   re-reads getShellSnapshot (no new scheduler): after a shell refresh
//   commits, call publishNow(); on producer-offline, skip the sink call.
// - Wire observeWatermark to the bridge snapshot acknowledgement carrying
//   the accepted t3.activity producer stamp. No server.ts route changes.
import * as NodeCrypto from "node:crypto";

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

export type StudioActivitySink = {
  send: (input: ActivityProducerInput) => Promise<void> | void;
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

export type PublishResult =
  | { delivered: true; envelope: ActivityProducerInput }
  | { delivered: false; status: "offline"; envelope: ActivityProducerInput }
  | { delivered: false; status: "send_failed"; envelope: ActivityProducerInput };

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
  private watermark: { stamp: ActivityProducerStamp; payloadHash: string } | null = null;
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
    const bytes = canonicalActivityJson(records);
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
        records,
        partial: false,
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
    try {
      await this.sink.send(envelope);
    } catch {
      return { delivered: false, status: "send_failed", envelope };
    }
    return { delivered: true, envelope };
  }

  /**
   * Resend queued updates with their ORIGINAL stamp and bytes (no new
   * sequence). Entries the watermark already covers are dropped, or replayed
   * as duplicates when the bytes match. Returns one verdict per queued entry.
   */
  async retryPending(): Promise<
    Array<{ stamp: ActivityProducerStamp; verdict: ProducerUpdateVerdict; sent: boolean }>
  > {
    const outcomes: Array<{
      stamp: ActivityProducerStamp;
      verdict: ProducerUpdateVerdict;
      sent: boolean;
    }> = [];
    if (!this.online) {
      for (const entry of this.pending)
        outcomes.push({ stamp: entry.stamp, verdict: "reject_stale", sent: false });
      return outcomes;
    }
    const remaining: QueuedActivityUpdate[] = [];
    for (const entry of this.pending) {
      const verdict = classifyProducerUpdate({
        current: this.watermark?.stamp ?? null,
        incoming: entry.stamp,
        bytesEqual:
          this.watermark !== null &&
          this.watermark.payloadHash === entry.payloadHash &&
          this.watermark.stamp.sequence === entry.stamp.sequence &&
          this.watermark.stamp.epoch === entry.stamp.epoch,
      });
      if (
        verdict === "reject_stale" ||
        verdict === "reject_conflict" ||
        verdict === "reject_epoch_reset_required"
      ) {
        outcomes.push({ stamp: entry.stamp, verdict, sent: false });
        continue;
      }
      try {
        await this.sink.send(entry.envelope);
      } catch {
        remaining.push(entry);
        outcomes.push({ stamp: entry.stamp, verdict, sent: false });
        continue;
      }
      outcomes.push({ stamp: entry.stamp, verdict, sent: true });
      if (verdict === "accept")
        this.watermark = { stamp: entry.stamp, payloadHash: entry.payloadHash };
    }
    this.pending = remaining;
    return outcomes;
  }

  /**
   * Observe the bridge-accepted (or remotely newer) watermark. A newer stamp
   * wins and drops covered pending updates; an older stamp can never move the
   * watermark backwards.
   */
  observeWatermark(
    stamp: ActivityProducerStamp,
    payloadHash: string,
  ): { verdict: ProducerUpdateVerdict; dropped: number } {
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
    this.watermark = { stamp, payloadHash };
    if (stamp.sequence + 1 > this.nextSequence) this.nextSequence = stamp.sequence + 1;
    const before = this.pending.length;
    this.pending = this.pending.filter(
      (entry) => entry.stamp.epoch !== stamp.epoch || entry.stamp.sequence > stamp.sequence,
    );
    return { verdict, dropped: before - this.pending.length };
  }
}

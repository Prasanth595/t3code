import * as Option from "effect/Option";
import type * as Tracer from "effect/Tracer";

export type TrackedKind = "root" | "sql";

export interface TrackedSpanReport {
  readonly name: string;
  readonly kind: TrackedKind;
  /** Time from the span's start to the end of the window asked about. */
  readonly ageMs: number;
  readonly open: boolean;
  /** A SQL span's statement, cut to QUERY_TEXT_MAX characters. */
  readonly query?: string;
}

/** Longest statement text kept per SQL span. */
export const QUERY_TEXT_MAX = 160;

interface Entry {
  readonly name: string;
  kind: TrackedKind;
  query?: string;
  readonly startMs: number;
  endMs: number | undefined;
}

export interface SpanRegistry {
  start(name: string, kind: TrackedKind): number;
  end(id: number): void;
  /** Marks a span as a SQL statement, once its attributes say it is one. */
  markSql(id: number, query?: string): void;
  /**
   * Spans open at any time in [windowStartMs, windowEndMs], oldest first. A synchronous block
   * usually ends its span before a timer can notice the stall, so spans that already ended
   * inside the window count too.
   */
  active(
    windowStartMs: number,
    windowEndMs: number,
    limit: number,
  ): ReadonlyArray<TrackedSpanReport>;
}

export interface SpanRegistryOptions {
  /** Open spans kept. The oldest is dropped past this, so a span that never ends cannot leak. */
  readonly maxInFlight?: number;
  /** Ended spans kept for the window check. */
  readonly maxRecent?: number;
  readonly now?: () => number;
}

/**
 * A bounded record of the spans worth blaming for a stall. Every server span goes through the
 * tracer wrapper, so start and end do one Map operation and nothing else.
 */
export const makeSpanRegistry = (options: SpanRegistryOptions = {}): SpanRegistry => {
  const maxInFlight = options.maxInFlight ?? 512;
  const maxRecent = options.maxRecent ?? 256;
  const now = options.now ?? (() => performance.now());
  // A Map iterates in insertion order, which is start order.
  const open = new Map<number, Entry>();
  const recent: Array<Entry | undefined> = Array.from({ length: maxRecent });
  let recentNext = 0;
  let nextId = 0;

  return {
    start(name, kind) {
      const id = nextId++;
      if (open.size >= maxInFlight) {
        const oldest = open.keys().next();
        if (!oldest.done) open.delete(oldest.value);
      }
      open.set(id, { name, kind, startMs: now(), endMs: undefined });
      return id;
    },
    end(id) {
      const entry = open.get(id);
      if (entry === undefined) return;
      open.delete(id);
      entry.endMs = now();
      recent[recentNext] = entry;
      recentNext = (recentNext + 1) % maxRecent;
    },
    markSql(id, query) {
      const entry = open.get(id);
      if (entry === undefined) return;
      entry.kind = "sql";
      if (query !== undefined) entry.query = query.slice(0, QUERY_TEXT_MAX);
    },
    active(windowStartMs, windowEndMs, limit) {
      const hits: Array<Entry> = [];
      for (const entry of recent) {
        if (
          entry !== undefined &&
          entry.startMs <= windowEndMs &&
          (entry.endMs ?? Infinity) >= windowStartMs
        ) {
          hits.push(entry);
        }
      }
      for (const entry of open.values()) {
        if (entry.startMs <= windowEndMs) hits.push(entry);
      }
      hits.sort((a, b) => a.startMs - b.startMs);
      return hits.slice(0, limit).map((entry) => ({
        name: entry.name,
        kind: entry.kind,
        ageMs: Math.round(windowEndMs - entry.startMs),
        open: entry.endMs === undefined,
        ...(entry.query !== undefined && { query: entry.query }),
      }));
    },
  };
};

const ATTR_DB_SYSTEM_NAME = "db.system.name";
const ATTR_DB_QUERY_TEXT = "db.query.text";

const trackedKind = (options: Parameters<Tracer.Tracer["span"]>[0]): TrackedKind | undefined => {
  // effect names a SQL span after the database ("sqlite"), so only its kind and the attributes
  // it sets next identify it; `markSql` follows from `attribute`.
  if (options.kind === "client") return "root";
  if (Option.isNone(options.parent) || options.parent.value._tag === "ExternalSpan") return "root";
  return undefined;
};

/**
 * Delegates every span to `tracer`. Root spans (no parent, or an external one) and client spans
 * also go into `registry`; their `end` is wrapped, and all other spans are returned as the
 * delegate made them. A client span that sets `db.system.name` is a SQL statement, and the
 * `db.query.text` it sets next is kept for the report.
 */
export const wrapTracer = (tracer: Tracer.Tracer, registry: SpanRegistry): Tracer.Tracer => ({
  span(options) {
    const span = tracer.span(options);
    const kind = trackedKind(options);
    if (kind === undefined) return span;
    const id = registry.start(options.name, kind);
    const end = span.end;
    span.end = function (endTime, exit) {
      registry.end(id);
      return end.call(this, endTime, exit);
    };
    if (options.kind === "client") {
      const attribute = span.attribute;
      span.attribute = function (key, value) {
        if (key === ATTR_DB_SYSTEM_NAME) registry.markSql(id);
        else if (key === ATTR_DB_QUERY_TEXT && typeof value === "string") {
          registry.markSql(id, value);
        }
        return attribute.call(this, key, value);
      };
    }
    return span;
  },
  context: tracer.context,
});

import * as Option from "effect/Option";
import type * as Tracer from "effect/Tracer";

export type TrackedKind = "root" | "sql";

export interface TrackedSpanReport {
  readonly name: string;
  readonly kind: TrackedKind;
  /** Time from the span's start to the end of the window asked about. */
  readonly ageMs: number;
  readonly open: boolean;
}

interface Entry {
  readonly name: string;
  readonly kind: TrackedKind;
  readonly startMs: number;
  endMs: number | undefined;
}

export interface SpanRegistry {
  start(name: string, kind: TrackedKind): number;
  end(id: number): void;
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
      }));
    },
  };
};

const SQL_SPAN_NAME = "sql.execute";

const trackedKind = (
  name: string,
  parent: Option.Option<Tracer.AnySpan>,
): TrackedKind | undefined => {
  if (name === SQL_SPAN_NAME) return "sql";
  if (Option.isNone(parent) || parent.value._tag === "ExternalSpan") return "root";
  return undefined;
};

/**
 * Delegates every span to `tracer`. Root spans (no parent, or an external one) and SQL
 * statements also go into `registry`; their `end` is wrapped, and all other spans are returned
 * as the delegate made them.
 */
export const wrapTracer = (tracer: Tracer.Tracer, registry: SpanRegistry): Tracer.Tracer => ({
  span(options) {
    const span = tracer.span(options);
    const kind = trackedKind(options.name, options.parent);
    if (kind === undefined) return span;
    const id = registry.start(options.name, kind);
    const end = span.end;
    span.end = function (endTime, exit) {
      registry.end(id);
      return end.call(this, endTime, exit);
    };
    return span;
  },
  context: tracer.context,
});

import * as Option from "effect/Option";
import type * as Tracer from "effect/Tracer";
import { describe, expect, it } from "vite-plus/test";

import { makeSpanRegistry, wrapTracer } from "./spanRegistry.ts";

const clock = () => {
  let t = 0;
  return { now: () => t, set: (next: number) => void (t = next) };
};

describe("makeSpanRegistry.active", () => {
  it("reports a span still open at the end of the window, with its age", () => {
    const c = clock();
    const registry = makeSpanRegistry({ now: c.now });
    c.set(100);
    registry.start("ThreadLaunchService.prepare", "root");
    expect(registry.active(500, 3000, 10)).toEqual([
      { name: "ThreadLaunchService.prepare", kind: "root", ageMs: 2900, open: true },
    ]);
  });

  it("reports a span that ended inside the window, because a blocked loop cannot report it in time", () => {
    const c = clock();
    const registry = makeSpanRegistry({ now: c.now });
    c.set(100);
    const id = registry.start("sql.execute", "sql");
    c.set(2500);
    registry.end(id);
    expect(registry.active(500, 3000, 10)).toEqual([
      { name: "sql.execute", kind: "sql", ageMs: 2900, open: false },
    ]);
  });

  it("leaves out spans that ended before the window or started after it", () => {
    const c = clock();
    const registry = makeSpanRegistry({ now: c.now });
    c.set(10);
    registry.end(registry.start("early", "root"));
    c.set(600);
    registry.start("during", "root");
    c.set(3500);
    registry.start("late", "root");
    expect(registry.active(500, 3000, 10).map((s) => s.name)).toEqual(["during"]);
  });

  it("lists the oldest first and honours the limit", () => {
    const c = clock();
    const registry = makeSpanRegistry({ now: c.now });
    c.set(1);
    registry.start("a", "root");
    c.set(2);
    const b = registry.start("b", "sql");
    c.set(3);
    registry.start("c", "root");
    c.set(4);
    registry.end(b);
    expect(registry.active(0, 10, 10).map((s) => s.name)).toEqual(["a", "b", "c"]);
    expect(registry.active(0, 10, 2).map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("stays bounded: the open map and the recent ring drop their oldest entries", () => {
    const c = clock();
    const registry = makeSpanRegistry({ now: c.now, maxInFlight: 3, maxRecent: 2 });
    for (let i = 0; i < 10; i++) {
      c.set(i);
      registry.start(`open-${i}`, "root");
    }
    expect(registry.active(0, 100, 100).map((s) => s.name)).toEqual(["open-7", "open-8", "open-9"]);
    for (let i = 0; i < 10; i++) {
      c.set(20 + i);
      registry.end(registry.start(`done-${i}`, "root"));
    }
    const names = registry.active(0, 100, 100).map((s) => s.name);
    expect(names).toContain("done-9");
    expect(names).toContain("done-8");
    expect(names).not.toContain("done-7");
    expect(names.length).toBeLessThanOrEqual(5);
  });

  it("ignores an end for a span it already dropped", () => {
    const registry = makeSpanRegistry({ maxInFlight: 1 });
    const first = registry.start("first", "root");
    registry.start("second", "root");
    expect(() => registry.end(first)).not.toThrow();
  });
});

const fakeSpan = (name: string, parent: Option.Option<Tracer.AnySpan>) => {
  const ended: Array<bigint> = [];
  const span = {
    _tag: "Span",
    name,
    parent,
    end: (endTime: bigint) => void ended.push(endTime),
  } as unknown as Tracer.Span;
  return { span, ended };
};

const spanOptions = (name: string, parent: Option.Option<Tracer.AnySpan>) =>
  ({
    name,
    parent,
    annotations: undefined,
    links: [],
    startTime: 0n,
    kind: "internal",
    root: Option.isNone(parent),
    sampled: true,
  }) as unknown as Parameters<Tracer.Tracer["span"]>[0];

describe("wrapTracer", () => {
  const setup = () => {
    const c = clock();
    const registry = makeSpanRegistry({ now: c.now });
    const created = new Map<string, ReturnType<typeof fakeSpan>>();
    const base: Tracer.Tracer = {
      span(options) {
        const made = fakeSpan(options.name, options.parent);
        created.set(options.name, made);
        return made.span;
      },
    };
    return { c, registry, created, tracer: wrapTracer(base, registry) };
  };
  const parentSpan = { _tag: "Span" } as unknown as Tracer.AnySpan;
  const externalParent = { _tag: "ExternalSpan" } as unknown as Tracer.AnySpan;

  it("tracks root spans and sql.execute spans until they end, and still ends the delegate's span", () => {
    const { c, registry, created, tracer } = setup();
    c.set(5);
    const root = tracer.span(spanOptions("rpc.request", Option.none()));
    const sql = tracer.span(spanOptions("sql.execute", Option.some(parentSpan)));
    const external = tracer.span(spanOptions("http.server", Option.some(externalParent)));
    expect(registry.active(0, 10, 10).map((s) => [s.name, s.kind])).toEqual([
      ["rpc.request", "root"],
      ["sql.execute", "sql"],
      ["http.server", "root"],
    ]);
    c.set(7);
    root.end(9n, undefined as never);
    sql.end(9n, undefined as never);
    external.end(9n, undefined as never);
    expect(registry.active(0, 10, 10).every((s) => !s.open)).toBe(true);
    expect(created.get("rpc.request")?.ended).toEqual([9n]);
    expect(created.get("sql.execute")?.ended).toEqual([9n]);
  });

  it("returns the delegate's own span, untouched, for other child spans", () => {
    const { registry, created, tracer } = setup();
    const child = tracer.span(spanOptions("ProjectionStore.read", Option.some(parentSpan)));
    expect(child).toBe(created.get("ProjectionStore.read")?.span);
    expect(registry.active(0, 10, 10)).toEqual([]);
  });

  it("keeps the delegate's context hook", () => {
    const registry = makeSpanRegistry();
    const context = (() => undefined) as unknown as NonNullable<Tracer.Tracer["context"]>;
    const base: Tracer.Tracer = { span: () => fakeSpan("x", Option.none()).span, context };
    expect(wrapTracer(base, registry).context).toBe(context);
  });
});

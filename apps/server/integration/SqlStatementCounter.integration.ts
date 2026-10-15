import * as Tracer from "effect/Tracer";

export interface SqlStatementCounter {
  readonly tracer: Tracer.Tracer;
  readonly count: () => number;
}

/**
 * Counts the client spans the Effect SQL client opens once per statement. Our
 * SQLite client names them after its `db.system.name`, `sqlite`.
 *
 * Install the same counter on every runtime under test, otherwise statements
 * run by background reactors and statements run by request handlers land in
 * different counters.
 */
export function makeSqlStatementCounter(): SqlStatementCounter {
  let statements = 0;
  const tracer = Tracer.make({
    span: (options) => {
      if (options.kind === "client" && options.name === "sqlite") statements += 1;
      return new Tracer.NativeSpan(options);
    },
  });
  return { tracer, count: () => statements };
}

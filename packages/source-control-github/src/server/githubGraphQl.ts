import * as Effect from "effect/Effect";

export type GraphQlVariables = Readonly<Record<string, readonly [type: string, value: unknown]>>;

export interface GraphQlDocument {
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
}

/**
 * Every value travels as a variable renamed per alias (`$s0_owner`), and `field` is handed those
 * placeholders rather than the values: nothing an item holds is written into the document.
 * Null for no items, since a document with no selection is not a document.
 */
export function aliasedGraphQlDocument<Item, Variables extends GraphQlVariables>(input: {
  readonly operation: "query" | "mutation";
  readonly name?: string;
  readonly alias: string;
  readonly key?: (item: Item, index: number) => number;
  readonly items: ReadonlyArray<Item>;
  readonly variables: (item: Item) => Variables;
  readonly field: (
    placeholders: { readonly [Name in keyof Variables]: string },
    item: Item,
  ) => string;
  readonly shared?: GraphQlVariables;
  readonly within?: (fields: string) => string;
}): GraphQlDocument | null {
  if (input.items.length === 0) return null;
  const declarations: string[] = [];
  const variables: Record<string, unknown> = {};
  for (const [name, [type, value]] of Object.entries(input.shared ?? {})) {
    declarations.push(`$${name}: ${type}`);
    variables[name] = value;
  }
  const fields = input.items.map((item, index) => {
    const alias = `${input.alias}${input.key?.(item, index) ?? index}`;
    const placeholders: Record<string, string> = {};
    for (const [name, [type, value]] of Object.entries(input.variables(item))) {
      const variable = `${alias}_${name}`;
      declarations.push(`$${variable}: ${type}`);
      variables[variable] = value;
      placeholders[name] = `$${variable}`;
    }
    return `  ${alias}: ${input.field(placeholders as { readonly [Name in keyof Variables]: string }, item)}`;
  });
  const selection = fields.join("\n");
  const parameters = declarations.length === 0 ? "" : `(${declarations.join(", ")})`;
  return {
    query: `${input.operation}${input.name === undefined ? "" : ` ${input.name}`}${parameters} {\n${input.within?.(selection) ?? selection}\n}`,
    variables,
  };
}

/**
 * A cursor GitHub hands back a second time would page forever, so it stops the
 * read as truncated too.
 */
export const readGraphQlPages = <Page, E, R>(
  read: (after: string | null, pages: ReadonlyArray<Page>) => Effect.Effect<Page, E, R>,
  options: {
    readonly nextCursor: (page: NoInfer<Page>) => string | null;
    readonly from?: string | null;
    readonly maxPages?: number;
    readonly until?: (pages: ReadonlyArray<NoInfer<Page>>) => boolean;
  },
): Effect.Effect<{ readonly pages: ReadonlyArray<Page>; readonly truncated: boolean }, E, R> =>
  Effect.gen(function* () {
    const pages: Page[] = [];
    const seen = new Set<string>();
    let after = options.from ?? null;
    while (true) {
      const page: Page = yield* read(after, pages);
      pages.push(page);
      const next = options.nextCursor(page);
      if (next === null) return { pages, truncated: false };
      if (
        seen.has(next) ||
        pages.length >= (options.maxPages ?? Infinity) ||
        options.until?.(pages) === true
      ) {
        return { pages, truncated: true };
      }
      seen.add(next);
      after = next;
    }
  });

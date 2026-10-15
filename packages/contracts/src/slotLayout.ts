import { Effect, Schema } from "effect";

/**
 * A user-arranged layout of named elements in rows. Each row has a `start`
 * group that takes the free width and an `end` group pinned to the right.
 * Any surface that lets the user arrange its parts reuses this shape with its
 * own element list; the thread card is the first one.
 */
export interface SlotLayoutRow<Element extends string> {
  readonly start: ReadonlyArray<Element>;
  readonly end: ReadonlyArray<Element>;
}

export interface SlotLayout<Element extends string> {
  readonly rows: ReadonlyArray<SlotLayoutRow<Element>>;
}

export type SlotLayoutGroup = "start" | "end";

/** Rows beyond this stop reading as one compact item. Raise it when a surface needs more. */
export const MAX_SLOT_LAYOUT_ROWS = 4;

export function slotLayoutElements<Element extends string>(
  layout: SlotLayout<Element>,
): ReadonlyArray<Element> {
  return layout.rows.flatMap((row) => [...row.start, ...row.end]);
}

/**
 * The layout without the elements that this version does not know. A layout
 * with only known elements comes back as the same object, so memos hold.
 */
export function knownSlotLayout<const Element extends string>(
  layout: SlotLayout<string>,
  elements: ReadonlyArray<Element>,
): SlotLayout<Element> {
  const known: ReadonlyArray<string> = elements;
  const isKnown = (element: string): element is Element => known.includes(element);
  const isKnownLayout = (candidate: SlotLayout<string>): candidate is SlotLayout<Element> =>
    slotLayoutElements(candidate).every(isKnown);
  if (isKnownLayout(layout)) return layout;
  return {
    rows: layout.rows.map((row) => ({
      start: row.start.filter(isKnown),
      end: row.end.filter(isKnown),
    })),
  };
}

/**
 * Builds the stored schema for one surface. Every element appears at most
 * once, and the `required` elements must appear, so a layout can never hide
 * the parts a surface depends on (for example the controls a hover reveals).
 *
 * Element names are open strings. Every machine holds the layout, and a newer
 * version can store an element that an older one does not know. A closed list
 * would make an older server reject the whole settings patch, or reset every
 * setting when it reads a newer `settings.json`. Read through `knownSlotLayout`.
 */
// Export it when a second surface gets a layout; until then only this file uses it.
function makeSlotLayoutSchema(required: ReadonlyArray<string>) {
  const Row = Schema.Struct({
    start: Schema.Array(Schema.String),
    end: Schema.Array(Schema.String),
  });
  return Schema.Struct({
    rows: Schema.Array(Row).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_SLOT_LAYOUT_ROWS)),
  }).check(
    Schema.makeFilter(
      (layout: SlotLayout<string>) => {
        const placed = slotLayoutElements(layout);
        return (
          new Set(placed).size === placed.length && required.every((id) => placed.includes(id))
        );
      },
      { expected: `each element at most once, including ${required.join(", ")}` },
    ),
  );
}

export const THREAD_CARD_ELEMENTS = [
  "favicon",
  "project",
  "branch",
  "title",
  "pin",
  "status",
  "terminal",
  "pullRequest",
  "diff",
  "machine",
  "providers",
  "model",
  "access",
  "plan",
  "backgroundTasks",
  "goal",
  "lineage",
  "limitReset",
  "error",
  "unread",
  "age",
  "messageCount",
] as const;
export type ThreadCardElement = (typeof THREAD_CARD_ELEMENTS)[number];

/** The mobile row has no terminal or diff data, so it offers fewer elements. */
export const MOBILE_THREAD_CARD_ELEMENTS = [
  "favicon",
  "project",
  "branch",
  "title",
  "pin",
  "status",
  "pullRequest",
  "machine",
  "providers",
  "model",
  "access",
  "plan",
  "backgroundTasks",
  "goal",
  "lineage",
  "limitReset",
  "error",
  "unread",
  "age",
  "messageCount",
] as const satisfies ReadonlyArray<ThreadCardElement>;
export type MobileThreadCardElement = (typeof MOBILE_THREAD_CARD_ELEMENTS)[number];

/** The title names the thread, and the status slot hosts the settle and snooze controls. */
export const REQUIRED_THREAD_CARD_ELEMENTS = [
  "title",
  "status",
] as const satisfies ReadonlyArray<MobileThreadCardElement>;

/** A stored thread card layout of either surface. */
export const StoredThreadCardLayout = makeSlotLayoutSchema(REQUIRED_THREAD_CARD_ELEMENTS);
export type ThreadCardLayout = SlotLayout<ThreadCardElement>;
export type MobileThreadCardLayout = SlotLayout<MobileThreadCardElement>;

/** The layout a custom card starts from: where the thread lives on top, the title below. */
export const DEFAULT_THREAD_CARD_LAYOUT: ThreadCardLayout = {
  rows: [
    { start: ["favicon", "project", "branch"], end: ["pin", "status"] },
    { start: ["title"], end: ["terminal", "pullRequest", "diff", "machine", "providers"] },
  ],
};

export const DEFAULT_MOBILE_THREAD_CARD_LAYOUT: MobileThreadCardLayout = {
  rows: [
    { start: ["favicon", "project", "branch"], end: ["pin", "status"] },
    { start: ["title"], end: ["pullRequest", "machine", "providers"] },
  ],
};

/**
 * Fork: the thread card layout per client surface. `null` keeps the built-in
 * card, so the feature is off until the user builds a layout. The web settings
 * page edits both; the mobile app only reads `mobile`.
 */
export const ThreadCardLayouts = Schema.Struct({
  desktop: Schema.NullOr(StoredThreadCardLayout).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  mobile: Schema.NullOr(StoredThreadCardLayout).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type ThreadCardLayouts = typeof ThreadCardLayouts.Type;
export type ThreadCardSurface = keyof ThreadCardLayouts;

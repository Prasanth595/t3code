import {
  DEFAULT_MOBILE_THREAD_CARD_LAYOUT,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_THREAD_CARD_LAYOUT,
  REQUIRED_THREAD_CARD_ELEMENTS,
  THREAD_CARD_ELEMENTS,
  ThreadCardLayout,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { applyServerSettingsPatch } from "./serverSettings.ts";
import {
  addSlotLayoutRow,
  canRemoveSlotLayoutRow,
  findSlotLayoutElement,
  placeSlotLayoutElement,
  removeSlotLayoutElement,
  removeSlotLayoutRow,
  unplacedSlotLayoutElements,
} from "./slotLayout.ts";

const decodeLayout = Schema.decodeUnknownSync(ThreadCardLayout);
const required = REQUIRED_THREAD_CARD_ELEMENTS;

describe("slot layout schema", () => {
  it("accepts the default layouts", () => {
    expect(decodeLayout(DEFAULT_THREAD_CARD_LAYOUT)).toEqual(DEFAULT_THREAD_CARD_LAYOUT);
  });

  it("rejects an element placed twice", () => {
    expect(() =>
      decodeLayout({ rows: [{ start: ["title", "title"], end: ["status"] }] }),
    ).toThrow();
  });

  it("rejects a layout without a required element", () => {
    expect(() => decodeLayout({ rows: [{ start: ["title"], end: [] }] })).toThrow();
  });

  it("rejects an element the surface does not offer", () => {
    expect(() =>
      decodeLayout({ rows: [{ start: ["title", "weather"], end: ["status"] }] }),
    ).toThrow();
  });
});

describe("slot layout edits", () => {
  it("moves a placed element to another group instead of duplicating it", () => {
    const next = placeSlotLayoutElement(DEFAULT_THREAD_CARD_LAYOUT, "branch", 1, "start");
    expect(findSlotLayoutElement(next, "branch")).toEqual({ row: 1, group: "start", index: 1 });
    expect(decodeLayout(next)).toEqual(next);
  });

  it("inserts at a position, and a move within a group lands at that position", () => {
    const inserted = placeSlotLayoutElement(DEFAULT_THREAD_CARD_LAYOUT, "branch", 1, "end", 0);
    expect(inserted.rows[1]!.end[0]).toBe("branch");
    expect(inserted.rows[0]!.start).not.toContain("branch");
    const moved = placeSlotLayoutElement(DEFAULT_THREAD_CARD_LAYOUT, "terminal", 1, "end", 2);
    expect(moved.rows[1]!.end).toEqual(["pullRequest", "diff", "terminal", "machine", "providers"]);
  });

  it("returns removed elements to the unplaced list", () => {
    expect(
      unplacedSlotLayoutElements(DEFAULT_THREAD_CARD_LAYOUT, THREAD_CARD_ELEMENTS),
    ).not.toContain("diff");
    const next = removeSlotLayoutElement(DEFAULT_THREAD_CARD_LAYOUT, "diff", required);
    expect(unplacedSlotLayoutElements(next, THREAD_CARD_ELEMENTS)).toContain("diff");
  });

  it("refuses to remove a required element", () => {
    expect(() => removeSlotLayoutElement(DEFAULT_THREAD_CARD_LAYOUT, "title", required)).toThrow();
  });

  it("only removes rows without required elements", () => {
    const withRow = addSlotLayoutRow(DEFAULT_THREAD_CARD_LAYOUT);
    expect(canRemoveSlotLayoutRow(withRow, 2, required)).toBe(true);
    expect(removeSlotLayoutRow(withRow, 2, required)).toEqual(DEFAULT_THREAD_CARD_LAYOUT);
    expect(canRemoveSlotLayoutRow(withRow, 0, required)).toBe(false);
  });
});

describe("threadCardLayouts settings patch", () => {
  it("replaces one surface and keeps the other", () => {
    const withDesktop = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      threadCardLayouts: { desktop: DEFAULT_THREAD_CARD_LAYOUT },
    });
    const shorter = { rows: [{ start: ["title"], end: ["status"] }] } as const;
    const next = applyServerSettingsPatch(withDesktop, {
      threadCardLayouts: { desktop: shorter, mobile: DEFAULT_MOBILE_THREAD_CARD_LAYOUT },
    });
    expect(next.threadCardLayouts).toEqual({
      desktop: shorter,
      mobile: DEFAULT_MOBILE_THREAD_CARD_LAYOUT,
    });
    expect(
      applyServerSettingsPatch(next, { threadCardLayouts: { desktop: null } }).threadCardLayouts,
    ).toEqual({ desktop: null, mobile: DEFAULT_MOBILE_THREAD_CARD_LAYOUT });
  });

  it("is off by default", () => {
    expect(DEFAULT_SERVER_SETTINGS.threadCardLayouts).toEqual({ desktop: null, mobile: null });
  });
});

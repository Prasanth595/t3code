import { describe, expect, it } from "vite-plus/test";

import { presenceText, spatialArrow, timeAgo } from "./format.ts";

describe("spatialArrow (MM-1103)", () => {
  it("rounds to the nearest of the four directions and reads left or top first", () => {
    expect(spatialArrow({ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.6 })).toEqual({
      first: "from",
      glyph: "→",
    });
    expect(spatialArrow({ x: 0.8, y: 0.5 }, { x: 0.2, y: 0.6 })).toEqual({
      first: "to",
      glyph: "←",
    });
    expect(spatialArrow({ x: 0.5, y: 0.1 }, { x: 0.6, y: 0.9 })).toEqual({
      first: "from",
      glyph: "↓",
    });
    expect(spatialArrow({ x: 0.5, y: 0.9 }, { x: 0.6, y: 0.1 })).toEqual({
      first: "to",
      glyph: "↑",
    });
  });
});

describe("presence text (MM-205, MM-601)", () => {
  const now = Date.parse("2026-10-13T10:00:00.000Z");
  it("shows waiting, online and the time since the last connection", () => {
    expect(presenceText(undefined, now)).toBe("waiting");
    expect(
      presenceText({ online: false, lastSeenAt: null, appliedRevision: null, status: null }, now),
    ).toBe("waiting");
    expect(
      presenceText({ online: true, lastSeenAt: null, appliedRevision: null, status: null }, now),
    ).toBe("online");
    expect(
      presenceText(
        { online: false, lastSeenAt: "2026-10-13T08:00:00.000Z", appliedRevision: 1, status: null },
        now,
      ),
    ).toBe("offline 2 h");
    expect(timeAgo("2026-10-13T09:59:30.000Z", now)).toBe("just now");
  });
});

import { describe, expect, it } from "vite-plus/test";

import { actorText, presenceState, presenceText, spatialArrow, timeAgo } from "./format.ts";
import { threeMachines } from "../rules/testMap.ts";

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
    const never = { online: false, lastSeenAt: null, appliedRevision: null, status: null };
    const left = { ...never, lastSeenAt: "2026-10-13T08:00:00.000Z", appliedRevision: 1 };
    expect(presenceState(undefined)).toBe("waiting");
    expect(presenceState(never)).toBe("waiting");
    expect(presenceText(never, now)).toBe("Waiting to join");
    expect(presenceState({ ...never, online: true })).toBe("online");
    expect(presenceState(left)).toBe("offline");
    expect(presenceText(left, now)).toBe("Offline, seen 2 h ago");
    expect(timeAgo("2026-10-13T09:59:30.000Z", now)).toBe("just now");
  });
});

describe("actorText (MM-702)", () => {
  it("leaves out the parts of a device that the portal could not tell", () => {
    const map = threeMachines();
    expect(
      actorText({ _tag: "owner", email: "a@b.c", device: "Unknown device · Unknown browser" }, map),
    ).toBe("a@b.c");
    expect(actorText({ _tag: "owner", email: "a@b.c", device: "Mac · Chrome" }, map)).toBe(
      "a@b.c · Mac · Chrome",
    );
  });
});

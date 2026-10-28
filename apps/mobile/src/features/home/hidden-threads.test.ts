import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { filterHiddenThreads, updateHiddenThreadKeys } from "./hidden-threads";

const first = { environmentId: EnvironmentId.make("first"), id: ThreadId.make("same") };
const second = { environmentId: EnvironmentId.make("second"), id: ThreadId.make("same") };

describe("device-local hidden threads", () => {
  it("hides only the scoped thread and includes it when showing hidden threads", () => {
    const keys = updateHiddenThreadKeys([], first, true);
    expect(filterHiddenThreads([first, second], new Set(keys), false)).toEqual([second]);
    expect(filterHiddenThreads([first, second], new Set(keys), true)).toEqual([first, second]);
  });

  it("keeps a thread hidden through updates until explicitly restored", () => {
    const keys = updateHiddenThreadKeys([], first, true);
    expect(updateHiddenThreadKeys(keys, first, true)).toEqual(keys);
    const updated = { ...first, updatedAt: "2026-10-27T23:00:00Z", settledAt: null };
    expect(filterHiddenThreads([updated], new Set(keys), false)).toEqual([]);
    expect(updateHiddenThreadKeys(keys, first, false)).toEqual([]);
  });

  it("composes hides without dropping another environment or mutating the previous list", () => {
    const keys = updateHiddenThreadKeys([], first, true);
    const next = updateHiddenThreadKeys(keys, second, true);
    expect(keys).toHaveLength(1);
    expect(next).toHaveLength(2);
    const restored = updateHiddenThreadKeys(next, first, false);
    expect(filterHiddenThreads([first, second], new Set(restored), false)).toEqual([first]);
  });
});

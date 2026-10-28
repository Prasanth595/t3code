import { createTemporaryThreadView } from "@t3tools/client-runtime/temporary-threads";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { completeTemporaryChatLaunch } from "./temporaryChatViews";

describe("temporary launch ownership", () => {
  it("discards a thread created after its last view explicitly left", async () => {
    const ref = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("launched"));
    const view = createTemporaryThreadView({ viewId: "origin" });
    view.update({ environmentId: ref.environmentId, threadIds: [ref.threadId] });
    const open = new Map<string, ReadonlyArray<string>>();
    const discarded: string[] = [];
    await completeTemporaryChatLaunch({
      threadRef: ref,
      isCurrent: false,
      view,
      background: false,
      send: async (payloads) => {
        for (const payload of payloads) {
          const previous = open.get(payload.input.viewId) ?? [];
          open.set(payload.input.viewId, payload.input.threadIds);
          for (const id of previous) {
            if (![...open.values()].some((ids) => ids.includes(id))) discarded.push(id);
          }
        }
        return true;
      },
    });
    expect(discarded).toEqual([ref.threadId]);
  });

  it("attaches the created thread to its current background view before the shell arrives", async () => {
    const ref = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("launched"));
    const view = createTemporaryThreadView({ viewId: "origin" });
    view.update({ environmentId: ref.environmentId, threadIds: [ref.threadId], background: true });
    const open = new Map<string, ReadonlyArray<string>>();
    await completeTemporaryChatLaunch({
      threadRef: ref,
      isCurrent: true,
      view,
      background: true,
      send: async (payloads) => {
        for (const payload of payloads) {
          expect(payload.input.background).toBe(true);
          open.set(payload.input.viewId, payload.input.threadIds);
        }
        return true;
      },
    });
    expect(open.get("origin")).toEqual([ref.threadId]);
  });
});

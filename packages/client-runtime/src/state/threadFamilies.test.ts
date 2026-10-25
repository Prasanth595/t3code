import { ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadFamilyRowsMissingFromShell } from "./threadFamilies.ts";

const row = (id: string, title = id) =>
  ({ id: ThreadId.make(id), title }) as unknown as OrchestrationV2ThreadShell;

describe("threadFamilyRowsMissingFromShell", () => {
  it("adds only the rows the shell left out, once, with shell rows winning", () => {
    const missing = threadFamilyRowsMissingFromShell({
      shellThreads: [row("parent"), row("live", "live from shell")],
      families: [
        { snapshotSequence: 4, threads: [row("live", "stale family copy"), row("idle")] },
        { snapshotSequence: 4, threads: [row("idle"), row("other")] },
      ],
      removedAt: new Map(),
    });
    expect(missing.map((thread) => thread.id)).toEqual(["idle", "other"]);
  });

  it("drops a family copy read before the shell removed that thread", () => {
    const removedAt = new Map([
      [ThreadId.make("archived-after-read"), 7],
      [ThreadId.make("removed-before-read"), 3],
    ]);
    const missing = threadFamilyRowsMissingFromShell({
      shellThreads: [],
      families: [
        {
          snapshotSequence: 5,
          threads: [row("archived-after-read"), row("removed-before-read")],
        },
      ],
      removedAt,
    });
    expect(missing.map((thread) => thread.id)).toEqual(["removed-before-read"]);
  });
});

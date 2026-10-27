import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";
import { startDesktopUpdateLaunchNotice } from "./updateEverythingRun";

describe("startDesktopUpdateLaunchNotice", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps a server that is still restarting from looking idle after the app relaunches", async () => {
    const now = 1_800_000_000_000;
    vi.useFakeTimers({ now });
    const environmentId = EnvironmentId.make("slow-machine");
    const store = new Map([
      [
        "t3code:update-everything-result:v1",
        JSON.stringify({
          savedAt: now,
          localVersion: null,
          updatedServers: 0,
          updatedProviders: 0,
          failures: [],
          handedOff: [{ environmentId, label: "Slow", targetVersion: "9.9.9", startedAt: now }],
        }),
      ],
    ]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        removeItem: (key: string) => store.delete(key),
      },
    });

    const stop = startDesktopUpdateLaunchNotice();
    try {
      // Lets the registry run its cleanup of unobserved atoms before the UI mounts.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(appAtomRegistry.get(serverEnvironment.updateStateAtom(environmentId))).toMatchObject({
        status: "running",
        stage: "resuming",
        targetVersion: "9.9.9",
      });
    } finally {
      stop();
    }
  });
});

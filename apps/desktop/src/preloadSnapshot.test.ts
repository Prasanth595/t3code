import { expect, it } from "vite-plus/test";

import { createPreloadSnapshot } from "./preloadSnapshot.ts";

it("reads synchronously once, then serves pushed values without IPC", () => {
  let synchronousReads = 0;
  const snapshot = createPreloadSnapshot(() => {
    synchronousReads++;
    return ["primary"];
  });

  for (let read = 0; read < 1_000; read++) expect(snapshot.read()).toEqual(["primary"]);
  snapshot.set(["primary", "wsl"]);
  expect(snapshot.read()).toEqual(["primary", "wsl"]);
  expect(synchronousReads).toBe(1);
});

it("skips the synchronous read when a push arrives first", () => {
  const snapshot = createPreloadSnapshot<string[]>(() => {
    throw new Error("unexpected synchronous IPC");
  });
  snapshot.set(["wsl"]);
  expect(snapshot.read()).toEqual(["wsl"]);
});

it("retries the synchronous read after it fails", () => {
  let fail = true;
  const snapshot = createPreloadSnapshot(() => {
    if (fail) throw new Error("IPC unavailable");
    return ["primary"];
  });
  expect(() => snapshot.read()).toThrow("IPC unavailable");
  fail = false;
  expect(snapshot.read()).toEqual(["primary"]);
});

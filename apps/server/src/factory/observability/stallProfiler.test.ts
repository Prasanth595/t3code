// @effect-diagnostics nodeBuiltinImport:off - the tests read the profile files the profiler writes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { useTempDirs } from "../ledger/testSupport.ts";
import { makeProfileLimiter, makeStallProfiler } from "./stallProfiler.ts";

const tempDir = useTempDirs();

describe("makeProfileLimiter", () => {
  it("allows one profile per interval", () => {
    let now = 1_000;
    const limiter = makeProfileLimiter(600_000, () => now);
    expect(limiter.tryAcquire()).toBe(true);
    now += 599_999;
    expect(limiter.tryAcquire()).toBe(false);
    now += 1;
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });
});

describe("makeStallProfiler", () => {
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it("writes a cpuprofile for a noticeable stall, once per interval, and ignores smaller stalls", async () => {
    const dir = NodePath.join(tempDir(), "stall-profiles");
    const written: Array<string> = [];
    const errors: Array<unknown> = [];
    const profile = makeStallProfiler({
      dir,
      durationMs: 20,
      thresholdMs: 5000,
      onWritten: (file) => written.push(file),
      onError: (error) => errors.push(error),
    });
    profile(4999);
    profile(6000);
    profile(9000);
    await waitFor(() => written.length > 0 || errors.length > 0);
    expect(errors).toEqual([]);
    expect(written).toHaveLength(1);
    const [file] = written;
    expect(NodePath.dirname(file!)).toBe(dir);
    expect(file!.endsWith(".cpuprofile")).toBe(true);
    const parsed = JSON.parse(NodeFS.readFileSync(file!, "utf8"));
    expect(Array.isArray(parsed.nodes)).toBe(true);
  });

  it("reports a failure instead of throwing", async () => {
    const blocker = NodePath.join(tempDir(), "file");
    NodeFS.writeFileSync(blocker, "x");
    const errors: Array<unknown> = [];
    const profile = makeStallProfiler({
      dir: NodePath.join(blocker, "stall-profiles"),
      durationMs: 10,
      thresholdMs: 0,
      onError: (error) => errors.push(error),
    });
    expect(() => profile(1)).not.toThrow();
    await waitFor(() => errors.length > 0);
    expect(errors).toHaveLength(1);
  });
});

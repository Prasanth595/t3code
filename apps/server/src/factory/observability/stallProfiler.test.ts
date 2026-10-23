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
  it("writes a cpuprofile for a noticeable stall, once per interval, and ignores smaller stalls", async () => {
    const dir = NodePath.join(tempDir(), "stall-profiles");
    const written: Array<string> = [];
    let started: ReadonlyArray<boolean> = [];
    const file = await new Promise<string>((resolve, reject) => {
      const profile = makeStallProfiler({
        dir,
        durationMs: 20,
        thresholdMs: 5000,
        onWritten: (path) => {
          written.push(path);
          resolve(path);
        },
        onError: reject,
      });
      started = [profile(4999), profile(6000), profile(9000)];
    });
    expect(started).toEqual([false, true, false]);
    expect(written).toEqual([file]);
    expect(NodePath.dirname(file)).toBe(dir);
    expect(file.endsWith(".cpuprofile")).toBe(true);
    const parsed = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    expect(Array.isArray(parsed.nodes)).toBe(true);
  });

  it("keeps only the newest 10 profiles", async () => {
    const dir = NodePath.join(tempDir(), "stall-profiles");
    const written: Array<string> = [];
    for (let i = 0; i < 11; i += 1) {
      await new Promise<void>((resolve, reject) => {
        const profile = makeStallProfiler({
          dir,
          durationMs: 5,
          thresholdMs: 0,
          minIntervalMs: 0,
          onWritten: (path) => {
            written.push(path);
            resolve();
          },
          onError: reject,
        });
        profile(1);
      });
    }
    const left = NodeFS.readdirSync(dir).toSorted();
    expect(left).toHaveLength(10);
    expect(left).toEqual(written.slice(1).map((file) => NodePath.basename(file)));
  });

  it("reports a failure instead of throwing", async () => {
    const blocker = NodePath.join(tempDir(), "file");
    NodeFS.writeFileSync(blocker, "x");
    const error = await new Promise<unknown>((resolve) => {
      const profile = makeStallProfiler({
        dir: NodePath.join(blocker, "stall-profiles"),
        durationMs: 10,
        thresholdMs: 0,
        onError: resolve,
      });
      expect(() => profile(1)).not.toThrow();
    });
    expect(error).toBeDefined();
  });
});

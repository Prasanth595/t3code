import { describe, expect, it } from "@effect/vitest";

import {
  buildSample,
  parseCpuTime,
  parseDarwinNet,
  parseDarwinSwap,
  parseDarwinSwapTraffic,
  parseLinuxNet,
  parseLinuxSwap,
  parseLinuxSwapTraffic,
  parsePs,
  type RawReadings,
} from "./resourceSample.ts";

const raw = (overrides: Partial<RawReadings> = {}): RawReadings => ({
  atMs: Date.parse("2026-10-13T08:00:00.000Z"),
  cpuPercent: 42.345,
  cpuCount: 8,
  memory: { usedBytes: 6, totalBytes: 8 },
  load: [1.234, 0.5, 0.25],
  swap: { usedBytes: 1, totalBytes: 4 },
  swapTrafficBytes: 1_000,
  disk: { usedBytes: 50, totalBytes: 100 },
  net: { inBytes: 10_000, outBytes: 2_000 },
  t3: { cpuMicros: 1_000_000, rssBytes: 300 },
  agents: { count: 3, cpuPercent: 25.04, memoryBytes: 900 },
  processes: [
    { pid: 1, cpuMs: 1_000, rssBytes: 100, name: "launchd" },
    { pid: 2, cpuMs: 5_000, rssBytes: 900, name: "node" },
    { pid: 3, cpuMs: 9_000, rssBytes: 500, name: "codex" },
  ],
  ...overrides,
});

describe("parsers (MM-1501)", () => {
  it("reads CPU times of Linux and macOS ps", () => {
    expect(parseCpuTime("01:02:03")).toBe(3_723_000);
    expect(parseCpuTime("2-00:00:01")).toBe(172_801_000);
    expect(parseCpuTime("66:49.62")).toBe(4_009_620);
    expect(parseCpuTime("abc")).toBeNull();
  });

  it("keeps spaces in app paths and takes the executable name", () => {
    const processes = parsePs(
      [
        "    1  66:49.62  26304 /sbin/launchd",
        "  326   0:27.18 272384 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper (Renderer)",
        "  999   00:00:01   1000 node",
        "garbage",
      ].join("\n"),
    );
    expect(processes).toEqual([
      { pid: 1, cpuMs: 4_009_620, rssBytes: 26_304 * 1024, name: "launchd" },
      {
        pid: 326,
        cpuMs: 27_180,
        rssBytes: 272_384 * 1024,
        name: "Google Chrome Helper (Renderer)",
      },
      { pid: 999, cpuMs: 1_000, rssBytes: 1_024_000, name: "node" },
    ]);
  });

  it("reads Linux swap use, swap traffic and network bytes", () => {
    expect(parseLinuxSwap("MemTotal: 100 kB\nSwapTotal:  2048 kB\nSwapFree:   1024 kB\n")).toEqual({
      usedBytes: 1024 * 1024,
      totalBytes: 2048 * 1024,
    });
    expect(parseLinuxSwap("MemTotal: 100 kB\n")).toBeNull();
    expect(parseLinuxSwapTraffic("pgfault 9\npswpin 10\npswpout 5\n")).toBe(15 * 4096);
    expect(
      parseLinuxNet(
        [
          "Inter-|   Receive                            |  Transmit",
          " face |bytes    packets errs drop fifo frame compressed multicast|bytes",
          "    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0",
          "  eth0: 100 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0",
          "  eth1: 1 1 0 0 0 0 0 0 2 1 0 0 0 0 0 0",
        ].join("\n"),
      ),
    ).toEqual({ inBytes: 101, outBytes: 202 });
  });

  it("reads macOS swap use, swap traffic and network bytes", () => {
    expect(parseDarwinSwap("total = 2048.00M  used = 1.50G  free = 512.00M  (encrypted)")).toEqual({
      usedBytes: 1.5 * 1024 ** 3,
      totalBytes: 2048 * 1024 ** 2,
    });
    expect(
      parseDarwinSwapTraffic(
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nSwapins:     2.\nSwapouts:    3.\n",
      ),
    ).toBe(5 * 16_384);
    expect(
      parseDarwinNet(
        [
          "Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll",
          "lo0        16384 <Link#1>                      40 0 999 40 0 999 0",
          "en0        1500  <Link#6>    9a:93:4f:6f:b5:96 10 0 300 10 0 400 0",
          "en0        1500  192.168       192.168.1.2     10 - 300 10 - 400 -",
          "en1*       1500  <Link#7>                      0 0 0 0 0 0 0",
        ].join("\n"),
      ),
    ).toEqual({ inBytes: 300, outBytes: 400 });
  });
});

describe("buildSample (MM-1501)", () => {
  it("leaves rates null in the first sample and rounds values", () => {
    const { sample } = buildSample(raw(), null);
    expect(sample).toMatchObject({
      at: "2026-10-13T08:00:00.000Z",
      cpuPercent: 42.3,
      load: [1.2, 0.5, 0.3],
      memoryUsedBytes: 6,
      swapBytesPerSecond: null,
      netInBytesPerSecond: null,
      t3: { cpuPercent: null, memoryBytes: 300 },
      agents: { count: 3, cpuPercent: 25, memoryBytes: 900 },
      topCpu: null,
    });
    expect(sample.topMemory?.map((p) => p.name)).toEqual(["node", "codex", "launchd"]);
    expect(sample.topMemory?.every((p) => p.cpuPercent === null)).toBe(true);
  });

  it("computes rates and top CPU from the previous counters", () => {
    const first = buildSample(raw(), null);
    const later = raw({
      atMs: first.counters.atMs + 10_000,
      swapTrafficBytes: 21_000,
      net: { inBytes: 20_000, outBytes: 2_000 },
      t3: { cpuMicros: 2_000_000, rssBytes: 300 },
      processes: [
        { pid: 1, cpuMs: 1_000, rssBytes: 100, name: "launchd" },
        { pid: 2, cpuMs: 6_000, rssBytes: 900, name: "node" },
        { pid: 3, cpuMs: 14_000, rssBytes: 500, name: "codex" },
        { pid: 4, cpuMs: 99_000, rssBytes: 1, name: "new" },
      ],
    });
    const { sample } = buildSample(later, first.counters);
    expect(sample.swapBytesPerSecond).toBe(2_000);
    expect(sample.netInBytesPerSecond).toBe(1_000);
    expect(sample.netOutBytesPerSecond).toBe(0);
    expect(sample.t3?.cpuPercent).toBe(10);
    // Idle and new processes have no CPU since the previous sample, so they are not on the list.
    expect(sample.topCpu).toEqual([
      { name: "codex", cpuPercent: 50, memoryBytes: 500 },
      { name: "node", cpuPercent: 10, memoryBytes: 900 },
    ]);
  });

  it("gives null for a counter that went back, and null readings stay null", () => {
    const first = buildSample(raw(), null);
    const { sample } = buildSample(
      raw({
        atMs: first.counters.atMs + 60_000,
        net: { inBytes: 1, outBytes: 1 },
        load: null,
        swap: null,
        disk: null,
        agents: null,
        processes: null,
      }),
      first.counters,
    );
    expect(sample).toMatchObject({
      netInBytesPerSecond: null,
      load: null,
      swapTotalBytes: null,
      diskTotalBytes: null,
      agents: null,
      topCpu: null,
      topMemory: null,
    });
  });
});

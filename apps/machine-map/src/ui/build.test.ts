import { describe, expect, it } from "vite-plus/test";
import type { MachinePresence, MachineStatus } from "@t3tools/contracts/machineMap";

import { buildStandings, parseBuild } from "./build.ts";

const status = (t3Version: string, build: string, uptimeSeconds = 60): MachineStatus => ({
  t3Version,
  build,
  hostname: null,
  uptimeSeconds,
  runningTurns: 0,
  waitingThreads: 0,
  scheduledTasks: 0,
  updateWaiting: null,
  cpuPercent: null,
  memoryPercent: null,
  commands: [],
  clients: [],
});

const presence = (machineStatus: MachineStatus, online = true): MachinePresence => ({
  online,
  lastSeenAt: "2026-10-13T12:00:00.000Z",
  appliedRevision: null,
  status: machineStatus,
});

describe("parseBuild (MM-1002)", () => {
  it("reads the version, the kind and a 7-character commit", () => {
    expect(parseBuild(status("0.0.45", "live 5abed5f"))).toEqual({
      version: "0.0.45",
      kind: "live",
      commit: "5abed5f",
    });
    // An older server sends 12 characters.
    expect(parseBuild(status("0.0.45", "deploy 5abed5f44f97")).commit).toBe("5abed5f");
    expect(parseBuild(status("0.0.45", "release"))).toEqual({
      version: "0.0.45",
      kind: "release",
      commit: null,
    });
    expect(parseBuild(status("0.0.45", "release 0.0.45")).commit).toBeNull();
  });
});

describe("build standings (MM-1002)", () => {
  it("marks the newest version newest and the others behind", () => {
    const standings = buildStandings({
      mac: presence(status("0.0.46", "live 1111111")),
      vps: presence(status("0.0.45", "deploy 2222222")),
      win: presence(status("0.0.45", "release")),
    });
    expect(Object.fromEntries(standings)).toEqual({
      mac: "newest",
      vps: "behind",
      win: "behind",
    });
  });

  it("with the same version, the server that started last is newest, and its commit wins", () => {
    const standings = buildStandings({
      mac: presence(status("0.0.45", "live 1111111", 60)),
      vps: presence(status("0.0.45", "deploy 2222222", 3600)),
      dev: presence(status("0.0.45", "dev 1111111", 7200)),
    });
    expect(Object.fromEntries(standings)).toEqual({
      mac: "newest",
      vps: "behind",
      dev: "newest",
    });
  });

  it("marks every machine newest when the builds match", () => {
    const standings = buildStandings({
      mac: presence(status("0.0.45", "live 5abed5f")),
      vps: presence(status("0.0.45", "deploy 5abed5f44f97")),
    });
    expect(Object.fromEntries(standings)).toEqual({ mac: "newest", vps: "newest" });
  });

  it("ignores offline machines and marks nothing with one online machine", () => {
    const standings = buildStandings({
      mac: presence(status("0.0.45", "live 1111111")),
      vps: presence(status("0.0.46", "deploy 2222222"), false),
    });
    expect(standings.size).toBe(0);
  });
});

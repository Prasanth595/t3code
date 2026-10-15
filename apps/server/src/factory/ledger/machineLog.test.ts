// @effect-diagnostics globalDate:off - one test checks lines are stamped with the wall clock.
// @effect-diagnostics nodeBuiltinImport:off - the tests read and lay out a real machine log.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import type { AppendIo } from "./appendFile.ts";
import { MACHINE_EVENT_FIELDS, type MachineEvent } from "./events.ts";
import { MachineLog, scanMachineLog, type MachineLogOptions } from "./machineLog.ts";
import { catchLedgerError, scripted, T0, ticking, useTempDirs } from "./testSupport.ts";

const tempDir = useTempDirs();

const logFile = (dataDir: string) => NodePath.join(dataDir, "events.jsonl");
const readText = (path: string) => NodeFS.readFileSync(path, "utf8");

// Open handles are closed after each test: a run of this file would otherwise hold many.
const handles: Array<MachineLog> = [];
afterEach(() => {
  for (const log of handles.splice(0)) log.close();
});

const open = (
  dataDir: string,
  clock: () => number = ticking(T0, 1000),
  options: Omit<MachineLogOptions, "clock"> = {},
) => {
  const log = MachineLog.open(dataDir, { clock, ...options });
  handles.push(log);
  return log;
};

/** A line as written at `T0`. */
const lineAtT0 = (event: string, dataJson: string) =>
  `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"${event}","data":${dataJson}}\n`;

const passStarted: MachineEvent = { event: "pass_started", data: {} };

/** Every machine event, with the exact line it is written as at `T0`. */
const samples: ReadonlyArray<{ readonly event: MachineEvent; readonly line: string }> = [
  { event: passStarted, line: lineAtT0("pass_started", `{}`) },
  {
    event: { event: "pass_finished", data: { runs: 3, claimed: 1, errors: 2, attention: 0 } },
    line: lineAtT0("pass_finished", `{"runs":3,"claimed":1,"errors":2,"attention":0}`),
  },
  {
    event: { event: "preflight_failed", data: { check: "t3", why: "T3 Code is not reachable" } },
    line: lineAtT0("preflight_failed", `{"check":"t3","why":"T3 Code is not reachable"}`),
  },
  {
    event: {
      event: "repo_skipped",
      data: {
        repo: "rawphp/softfac",
        reason: "config-not-loaded",
        message: "the project config is invalid",
      },
    },
    line: lineAtT0(
      "repo_skipped",
      `{"repo":"rawphp/softfac","reason":"config-not-loaded","message":"the project config is invalid"}`,
    ),
  },
  {
    event: {
      event: "claim_skipped",
      data: { repo: "rawphp/softfac", issue: "12", reason: "limit" },
    },
    line: lineAtT0("claim_skipped", `{"repo":"rawphp/softfac","issue":12,"reason":"limit"}`),
  },
  {
    event: {
      event: "claim_skipped",
      data: { repo: "acme/widgets", issue: "ENG-42", reason: "blocked" },
    },
    line: lineAtT0("claim_skipped", `{"repo":"acme/widgets","issue":"ENG-42","reason":"blocked"}`),
  },
  {
    event: { event: "claim_skipped", data: { reason: "paused" } },
    line: lineAtT0("claim_skipped", `{"reason":"paused"}`),
  },
  {
    event: {
      event: "claim_repaired",
      data: { repo: "rawphp/softfac", issue: "12", outcome: "finished" },
    },
    line: lineAtT0("claim_repaired", `{"repo":"rawphp/softfac","issue":12,"outcome":"finished"}`),
  },
  {
    event: { event: "attention", data: { run: "rawphp__softfac__8__1", reason: "abandoned" } },
    line: lineAtT0("attention", `{"run":"rawphp__softfac__8__1","reason":"abandoned"}`),
  },
  {
    event: {
      event: "attention",
      data: { reason: "disk-floor", volume: "/", free_bytes: 5000000000, floor_gb: 10, held: 2 },
    },
    line: lineAtT0(
      "attention",
      `{"reason":"disk-floor","volume":"/","free_bytes":5000000000,"floor_gb":10,"held":2}`,
    ),
  },
  {
    event: {
      event: "attention",
      data: {
        reason: "t3-gh-config-dir",
        url: "http://localhost:3773",
        user: "rawphp",
        gh_config_dir: "/home/me/.config/gh-rawphp",
      },
    },
    line: lineAtT0(
      "attention",
      `{"reason":"t3-gh-config-dir","url":"http://localhost:3773","user":"rawphp","gh_config_dir":"/home/me/.config/gh-rawphp"}`,
    ),
  },
  {
    event: { event: "self_update_started", data: { from: "abc123", to: "def456" } },
    line: lineAtT0("self_update_started", `{"from":"abc123","to":"def456"}`),
  },
  {
    event: {
      event: "self_update_installed",
      data: { from: "abc123", to: "def456", duration_ms: 1200 },
    },
    line: lineAtT0("self_update_installed", `{"from":"abc123","to":"def456","duration_ms":1200}`),
  },
  {
    event: {
      event: "self_update_failed",
      data: { from: "abc123", to: "def456", step: "install", reason: "update-build-failed" },
    },
    line: lineAtT0(
      "self_update_failed",
      `{"from":"abc123","to":"def456","step":"install","reason":"update-build-failed"}`,
    ),
  },
  {
    event: { event: "self_update_rolled_back", data: { from: "def456", to: "abc123" } },
    line: lineAtT0("self_update_rolled_back", `{"from":"def456","to":"abc123"}`),
  },
  {
    event: {
      event: "fleet_failed",
      data: {
        call: "events",
        reason: "fleet-timeout",
        message: "the call took longer than 10 seconds",
      },
    },
    line: lineAtT0(
      "fleet_failed",
      `{"call":"events","reason":"fleet-timeout","message":"the call took longer than 10 seconds"}`,
    ),
  },
  {
    event: {
      event: "fleet_desired",
      data: {
        what: "config",
        asked: "7",
        state: "refused",
        reason: "config-key-not-allowed",
        detail: "poll_seconds",
      },
    },
    line: lineAtT0(
      "fleet_desired",
      `{"what":"config","asked":"7","state":"refused","reason":"config-key-not-allowed","detail":"poll_seconds"}`,
    ),
  },
  {
    event: {
      event: "fleet_desired",
      data: {
        what: "target-commit",
        asked: "abc123",
        state: "applied",
        reason: "target-installed",
      },
    },
    line: lineAtT0(
      "fleet_desired",
      `{"what":"target-commit","asked":"abc123","state":"applied","reason":"target-installed"}`,
    ),
  },
  {
    event: {
      event: "retro_started",
      data: {
        n: 1,
        thread_id: "thr_9",
        runs: 5,
        since_ms: null,
        model_instance: "claudeAgent",
        model: "claude-opus-5-5",
      },
    },
    line: lineAtT0(
      "retro_started",
      `{"n":1,"thread_id":"thr_9","runs":5,"since_ms":null,"model_instance":"claudeAgent","model":"claude-opus-5-5"}`,
    ),
  },
  {
    event: {
      event: "retro_finished",
      data: { n: 1, thread_id: "thr_9", result: "done", duration_ms: 60000 },
    },
    line: lineAtT0(
      "retro_finished",
      `{"n":1,"thread_id":"thr_9","result":"done","duration_ms":60000}`,
    ),
  },
  {
    event: { event: "worktrees_swept", data: { paths: ["/t3/worktrees/a", "/t3/worktrees/b"] } },
    line: lineAtT0("worktrees_swept", `{"paths":["/t3/worktrees/a","/t3/worktrees/b"]}`),
  },
  {
    event: {
      event: "error",
      data: { step: "retro", kind: "t3", message: "the retro thread could not be read" },
    },
    line: lineAtT0(
      "error",
      `{"step":"retro","kind":"t3","message":"the retro thread could not be read"}`,
    ),
  },
  {
    event: {
      event: "error",
      data: {
        run: "rawphp__softfac__8__1",
        step: "pass",
        kind: "ledger",
        message:
          "run rawphp__softfac__8__1: its ledger file cannot be read, so nothing was done for it and it counts as active",
      },
    },
    line: lineAtT0(
      "error",
      `{"run":"rawphp__softfac__8__1","step":"pass","kind":"ledger","message":"run rawphp__softfac__8__1: its ledger file cannot be read, so nothing was done for it and it counts as active"}`,
    ),
  },
];

describe("open", () => {
  it("open makes the data dir and an empty owner-only file, and fsyncs the directories", () => {
    const root = tempDir();
    const dataDir = NodePath.join(root, "fresh", "data");
    const synced: Array<string> = [];
    open(dataDir, ticking(T0, 1), { syncDir: (dir) => void synced.push(dir) });
    expect(NodeFS.readFileSync(logFile(dataDir)).length).toBe(0);
    expect(NodeFS.statSync(logFile(dataDir)).mode & 0o777).toBe(0o600);
    expect(NodeFS.statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(synced).toEqual([dataDir, NodePath.join(root, "fresh")]);
  });

  it("open in an existing data dir leaves its mode alone and still syncs it and its parent", () => {
    const dataDir = tempDir();
    NodeFS.chmodSync(dataDir, 0o755);
    const synced: Array<string> = [];
    open(dataDir, ticking(T0, 1), { syncDir: (dir) => void synced.push(dir) });
    expect(NodeFS.statSync(dataDir).mode & 0o777).toBe(0o755);
    expect(synced).toEqual([dataDir, NodePath.dirname(dataDir)]);
  });

  it("open on an existing log syncs the data dir and its parent and leaves the bytes alone", () => {
    const dataDir = tempDir();
    const content = lineAtT0("pass_started", `{}`);
    NodeFS.writeFileSync(logFile(dataDir), content);
    NodeFS.chmodSync(logFile(dataDir), 0o644);
    const synced: Array<string> = [];
    open(dataDir, ticking(T0, 1), { syncDir: (dir) => void synced.push(dir) });
    expect(synced).toEqual([dataDir, NodePath.dirname(dataDir)]);
    expect(readText(logFile(dataDir))).toBe(content);
    expect(NodeFS.statSync(logFile(dataDir)).mode & 0o777).toBe(0o644);
  });

  it("an open whose directory sync fails is an Io error, and the retry syncs and appends", () => {
    const root = tempDir();
    const dataDir = NodePath.join(root, "data");
    const error = catchLedgerError(() =>
      open(dataDir, ticking(T0, 1), {
        syncDir: () => {
          throw new Error("injected disk error");
        },
      }),
    );
    expect(error.kind).toBe("Io");
    expect(error.path).toBe(dataDir);

    const synced: Array<string> = [];
    const log = open(dataDir, ticking(T0, 1), { syncDir: (dir) => void synced.push(dir) });
    expect(synced).toEqual([dataDir, root]);
    log.append(passStarted);
    expect(readText(logFile(dataDir))).toBe(lineAtT0("pass_started", `{}`));
  });

  it("open ends an incomplete last line with a newline and leaves one that ends in a newline alone", () => {
    const whole = lineAtT0("pass_started", `{}`);
    const fragment = `{"ts":"2026-10-04T10:13:17.123Z","ms":17911087`;

    const torn = tempDir();
    NodeFS.writeFileSync(logFile(torn), `${whole}${fragment}`);
    const log = open(torn, ticking(T0 + 9000, 1000));
    expect(readText(logFile(torn))).toBe(`${whole}${fragment}\n`);
    log.append(passStarted);
    expect(readText(logFile(torn))).toBe(
      `${whole}${fragment}\n{"ts":"2026-10-04T10:13:25.123Z","ms":1791108805123,"event":"pass_started","data":{}}\n`,
    );

    const clean = tempDir();
    NodeFS.writeFileSync(logFile(clean), whole);
    open(clean);
    expect(readText(logFile(clean))).toBe(whole);
  });

  it("open refuses a symlink or a directory at events.jsonl", () => {
    const linked = tempDir();
    const target = NodePath.join(linked, "elsewhere.jsonl");
    NodeFS.writeFileSync(target, "");
    NodeFS.symlinkSync(target, logFile(linked));
    const error = catchLedgerError(() => open(linked));
    expect(error.kind).toBe("Io");
    expect(error.path).toBe(logFile(linked));
    expect(readText(target)).toBe("");

    const dangling = tempDir();
    NodeFS.symlinkSync(NodePath.join(dangling, "missing.jsonl"), logFile(dangling));
    expect(catchLedgerError(() => open(dangling)).kind).toBe("Io");
    expect(NodeFS.existsSync(NodePath.join(dangling, "missing.jsonl"))).toBe(false);

    const directory = tempDir();
    NodeFS.mkdirSync(logFile(directory));
    expect(catchLedgerError(() => open(directory)).kind).toBe("Io");
  });

  it("open refuses a pipe at events.jsonl without waiting on it", () => {
    const dataDir = tempDir();
    const made = NodeChildProcess.spawnSync("mkfifo", [logFile(dataDir)]);
    expect(made.status).toBe(0);
    expect(catchLedgerError(() => open(dataDir)).kind).toBe("Io");
  });
});

describe("append", () => {
  it("append writes a numeric issue key as a JSON number and an identifier as a string", () => {
    const dataDir = tempDir();
    const log = open(dataDir, ticking(T0, 1000));
    log.append({ event: "claim_skipped", data: { repo: "a/b", issue: "8", reason: "limit" } });
    log.append({
      event: "claim_repaired",
      data: { repo: "a/b", issue: "ENG-42", outcome: "released" },
    });
    const lines = readText(logFile(dataDir)).split("\n");
    expect(lines[0]).toContain(`"data":{"repo":"a/b","issue":8,"reason":"limit"}`);
    expect(lines[1]).toContain(`"data":{"repo":"a/b","issue":"ENG-42","outcome":"released"}`);
  });

  it("append writes an issue number above 2^53 digit for digit", () => {
    const dataDir = tempDir();
    const log = open(dataDir, ticking(T0, 1000));
    for (const issue of ["9007199254740993", "18446744073709551615"]) {
      log.append({ event: "claim_skipped", data: { repo: "a/b", issue, reason: "limit" } });
    }
    const lines = readText(logFile(dataDir)).split("\n");
    expect(lines[0]).toContain(`"issue":9007199254740993,`);
    expect(lines[1]).toContain(`"issue":18446744073709551615,`);
  });

  it("append writes the five example lines of the doc as exact bytes, with no cause", () => {
    const dataDir = tempDir();
    const log = open(
      dataDir,
      scripted([1791108796123, 1791108797123, 1791108798123, 1791108799123, 1791108800123]),
    );
    log.append({ event: "pass_started", data: {} });
    log.append({ event: "pass_finished", data: { runs: 3, claimed: 1, errors: 2, attention: 0 } });
    log.append({
      event: "claim_skipped",
      data: { repo: "rawphp/softfac", issue: "12", reason: "limit" },
    });
    log.append({ event: "attention", data: { run: "rawphp__softfac__8__1", reason: "abandoned" } });
    log.append({
      event: "error",
      data: {
        run: "rawphp__softfac__8__1",
        step: "pass",
        kind: "ledger",
        message:
          "run rawphp__softfac__8__1: its ledger file cannot be read, so nothing was done for it and it counts as active",
      },
    });
    expect(readText(logFile(dataDir))).toBe(
      [
        `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"pass_started","data":{}}`,
        `{"ts":"2026-10-04T10:13:17.123Z","ms":1791108797123,"event":"pass_finished","data":{"runs":3,"claimed":1,"errors":2,"attention":0}}`,
        `{"ts":"2026-10-04T10:13:18.123Z","ms":1791108798123,"event":"claim_skipped","data":{"repo":"rawphp/softfac","issue":12,"reason":"limit"}}`,
        `{"ts":"2026-10-04T10:13:19.123Z","ms":1791108799123,"event":"attention","data":{"run":"rawphp__softfac__8__1","reason":"abandoned"}}`,
        `{"ts":"2026-10-04T10:13:20.123Z","ms":1791108800123,"event":"error","data":{"run":"rawphp__softfac__8__1","step":"pass","kind":"ledger","message":"run rawphp__softfac__8__1: its ledger file cannot be read, so nothing was done for it and it counts as active"}}`,
        "",
      ].join("\n"),
    );
  });

  it("append writes one exact line per machine event and variant", () => {
    const dataDir = tempDir();
    const log = open(dataDir, ticking(T0, 0));
    let expected = "";
    const seen = new Set<string>();
    for (const { event, line } of samples) {
      log.append(event);
      expected += line;
      seen.add(event.event);
      expect(readText(logFile(dataDir)), event.event).toBe(expected);
    }
    // Every one of the 17 event types has at least one exact line.
    expect([...seen].sort()).toEqual(Object.keys(MACHINE_EVENT_FIELDS).sort());
    expect(seen.size).toBe(17);
  });

  it("the claims paused line has a reason and nothing else", () => {
    const dataDir = tempDir();
    open(dataDir, ticking(T0, 0)).append({ event: "claim_skipped", data: { reason: "paused" } });
    const text = readText(logFile(dataDir));
    expect(text).toBe(
      `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"claim_skipped","data":{"reason":"paused"}}\n`,
    );
    expect(text).toContain(`"event":"claim_skipped","data":{"reason":"paused"}}`);
    expect(Object.keys((JSON.parse(text) as { data: object }).data)).toEqual(["reason"]);
  });

  it("append writes the fields in the doc order whatever order the caller built the object in", () => {
    const dataDir = tempDir();
    open(dataDir, ticking(T0, 0)).append({
      event: "retro_finished",
      data: { duration_ms: 5, result: "stopped", thread_id: "t", n: 2 },
    });
    expect(readText(logFile(dataDir))).toBe(
      lineAtT0("retro_finished", `{"n":2,"thread_id":"t","result":"stopped","duration_ms":5}`),
    );
  });

  it("append refuses an event name the doc does not list and writes nothing", () => {
    const dataDir = tempDir();
    const log = open(dataDir, ticking(T0, 0));
    for (const name of ["merged", "toString", "__proto__", "claimed"]) {
      const error = catchLedgerError(() =>
        log.append({ event: name, data: {} } as unknown as MachineEvent),
      );
      expect(error.kind).toBe("UnknownEvent");
      expect(error.event).toBe(name);
    }
    expect(readText(logFile(dataDir))).toBe("");
  });

  it("two handles on one log interleave appends without overwriting", () => {
    const dataDir = tempDir();
    const first = open(dataDir, ticking(T0, 0));
    const second = open(dataDir, ticking(T0, 0));
    first.append({ event: "pass_started", data: {} });
    second.append({
      event: "pass_finished",
      data: { runs: 0, claimed: 0, errors: 0, attention: 0 },
    });
    first.append({ event: "pass_started", data: {} });
    expect(readText(logFile(dataDir)).split("\n")).toHaveLength(4);
  });

  it("a failed write gets a line break before the next event", () => {
    const dataDir = tempDir();
    let failAfter: number | null = null;
    const io: AppendIo = {
      writeSync(fd, buffer) {
        if (failAfter !== null) {
          const keep = failAfter;
          failAfter = null;
          NodeFS.writeSync(fd, buffer.subarray(0, keep));
          throw new Error("injected disk error");
        }
        return NodeFS.writeSync(fd, buffer);
      },
      fsyncSync: (fd) => NodeFS.fsyncSync(fd),
    };
    const log = open(dataDir, ticking(T0, 0), { io });
    log.append(passStarted);
    failAfter = 10;
    const error = catchLedgerError(() => log.append(passStarted));
    expect(error.kind).toBe("Io");
    expect(error.path).toBe(logFile(dataDir));
    log.append(passStarted);
    log.append(passStarted);
    const line = lineAtT0("pass_started", `{}`);
    expect(readText(logFile(dataDir))).toBe(`${line}{"ts":"202\n${line}${line}`);
    // The reader skips the fragment and gets the three whole lines.
    expect(scanMachineLog(dataDir)).toHaveLength(3);
  });

  it("a line another handle's failed write cut off gets a line break before this handle's event", () => {
    const dataDir = tempDir();
    let failAfter: number | null = null;
    const io: AppendIo = {
      writeSync(fd, buffer) {
        if (failAfter !== null) {
          const keep = failAfter;
          failAfter = null;
          NodeFS.writeSync(fd, buffer.subarray(0, keep));
          throw new Error("injected disk error");
        }
        return NodeFS.writeSync(fd, buffer);
      },
      fsyncSync: (fd) => NodeFS.fsyncSync(fd),
    };
    const first = open(dataDir, ticking(T0, 0), { io });
    const second = open(dataDir, ticking(T0, 0));
    failAfter = 10;
    expect(catchLedgerError(() => first.append(passStarted)).kind).toBe("Io");
    second.append(passStarted);
    const line = lineAtT0("pass_started", `{}`);
    expect(readText(logFile(dataDir))).toBe(`{"ts":"202\n${line}`);
    // The first handle still adds its own break after its failure, as softfac does: a blank line.
    first.append(passStarted);
    expect(readText(logFile(dataDir))).toBe(`{"ts":"202\n${line}\n${line}`);
    expect(scanMachineLog(dataDir)).toHaveLength(2);
  });

  it("a failed sync gets a line break before the next event", () => {
    const dataDir = tempDir();
    let failSync = true;
    const io: AppendIo = {
      writeSync: (fd, buffer) => NodeFS.writeSync(fd, buffer),
      fsyncSync(fd) {
        if (failSync) {
          failSync = false;
          throw new Error("injected disk error");
        }
        NodeFS.fsyncSync(fd);
      },
    };
    const log = open(dataDir, ticking(T0, 0), { io });
    expect(catchLedgerError(() => log.append(passStarted)).kind).toBe("Io");
    log.append(passStarted);
    const line = lineAtT0("pass_started", `{}`);
    expect(readText(logFile(dataDir))).toBe(`${line}\n${line}`);
  });

  it("open without a clock stamps events with the system clock", () => {
    const dataDir = tempDir();
    const before = Date.now();
    const log = MachineLog.open(dataDir);
    handles.push(log);
    log.append(passStarted);
    const after = Date.now();
    const line = JSON.parse(readText(logFile(dataDir))) as { ms: number };
    expect(line.ms).toBeGreaterThanOrEqual(before);
    expect(line.ms).toBeLessThanOrEqual(after);
  });
});

describe("scan machine log", () => {
  const machineLine = (ms: number, event: string, note: string) =>
    `{"ts":"2026-10-04T10:13:16.123Z","ms":${ms},"event":"${event}","data":{"note":"${note}"}}\n`;

  it("scanMachineLog gives the lines oldest first", () => {
    const dataDir = tempDir();
    const log = open(dataDir, ticking(T0, 1000));
    log.append(passStarted);
    log.append({ event: "pass_finished", data: { runs: 1, claimed: 0, errors: 0, attention: 0 } });
    expect(scanMachineLog(dataDir)).toEqual([
      { ts: "2026-10-04T10:13:16.123Z", ms: T0, event: "pass_started", data: {} },
      {
        ts: "2026-10-04T10:13:17.123Z",
        ms: T0 + 1000,
        event: "pass_finished",
        data: { runs: 1, claimed: 0, errors: 0, attention: 0 },
      },
    ]);
  });

  it("scanMachineLog skips blank and unparsable lines and keeps a last line with no newline that parses", () => {
    const dataDir = tempDir();
    NodeFS.writeFileSync(
      logFile(dataDir),
      [
        "\n\r\n",
        machineLine(10, "pass_started", "a"),
        "this is not json\n",
        `{"ts":"x"}\n`,
        "[]\n",
        `{"ts":"t","ms":"1","event":"e"}\n`,
        "\n",
        machineLine(20, "pass_finished", "b"),
        "\n\n",
        // A line from a newer build with extra keys, and one with no data at all.
        `{"ts":"t","ms":25,"event":"newer","data":{"k":1},"cause":{"step":"pass","reason":"x"},"extra":true}\n`,
        `{"ts":"t","ms":26,"event":"bare"}\n`,
        machineLine(30, "error", "c").trimEnd(),
      ].join(""),
    );
    expect(scanMachineLog(dataDir).map((entry) => [entry.ms, entry.event, entry.data])).toEqual([
      [10, "pass_started", { note: "a" }],
      [20, "pass_finished", { note: "b" }],
      [25, "newer", { k: 1 }],
      [26, "bare", null],
      [30, "error", { note: "c" }],
    ]);
  });

  it("scanMachineLog skips a line cut off by a crash", () => {
    const dataDir = tempDir();
    NodeFS.writeFileSync(
      logFile(dataDir),
      `${machineLine(10, "pass_started", "a")}${machineLine(40, "attention", "d").slice(0, 30)}`,
    );
    expect(scanMachineLog(dataDir).map((entry) => entry.ms)).toEqual([10]);
  });

  it("scanMachineLog skips a line that is not UTF-8", () => {
    const dataDir = tempDir();
    NodeFS.writeFileSync(
      logFile(dataDir),
      Buffer.concat([
        Buffer.from(machineLine(10, "pass_started", "a")),
        Buffer.from([0xff, 0xfe, 0x0a]),
        Buffer.from(machineLine(20, "pass_started", "b")),
      ]),
    );
    expect(scanMachineLog(dataDir).map((entry) => entry.ms)).toEqual([10, 20]);
  });

  it("scanMachineLog returns no lines for a missing or empty log", () => {
    const dataDir = tempDir();
    expect(scanMachineLog(dataDir)).toEqual([]);
    expect(scanMachineLog(NodePath.join(dataDir, "no", "such", "dir"))).toEqual([]);
    NodeFS.writeFileSync(logFile(dataDir), "");
    expect(scanMachineLog(dataDir)).toEqual([]);
  });

  it("scanMachineLog refuses a symlink and a directory", () => {
    const linked = tempDir();
    NodeFS.writeFileSync(NodePath.join(linked, "real"), machineLine(1, "pass_started", "a"));
    NodeFS.symlinkSync(NodePath.join(linked, "real"), logFile(linked));
    const error = catchLedgerError(() => scanMachineLog(linked));
    expect(error.kind).toBe("Io");
    expect(error.path).toBe(logFile(linked));

    const directory = tempDir();
    NodeFS.mkdirSync(logFile(directory));
    expect(catchLedgerError(() => scanMachineLog(directory)).kind).toBe("Io");
  });

  it("scanMachineLog refuses a pipe without waiting on it", () => {
    const dataDir = tempDir();
    expect(NodeChildProcess.spawnSync("mkfifo", [logFile(dataDir)]).status).toBe(0);
    expect(catchLedgerError(() => scanMachineLog(dataDir)).kind).toBe("Io");
  });
});

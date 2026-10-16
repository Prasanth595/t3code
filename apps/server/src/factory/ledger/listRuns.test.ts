// @effect-diagnostics nodeBuiltinImport:off - the tests lay out real run files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import type { State } from "../domain/lifecycle.ts";
import { makeCause } from "./events.ts";
import { Ledger } from "./ledger.ts";
import { holdsSlot, listUnfinishedRuns } from "./listRuns.ts";
import { RUNS_DIR, runIdFileName, type RunId } from "./runId.ts";
import { T0, ticking, useTempDirs } from "./testSupport.ts";

const tempDir = useTempDirs();

const handles: Array<Ledger> = [];
afterEach(() => {
  for (const ledger of handles.splice(0)) ledger.close();
});

const rid = (issue: number, repo = "rawphp/softfac", attempt = 1): RunId => ({
  repo,
  issue: String(issue),
  attempt,
});

const cause = makeCause("start", "claimed");

/** A run started at `startMs` whose last state is `to`, finished when `finish`. */
const runAt = (
  dataDir: string,
  id: RunId,
  startMs: number,
  to: "triage" | "building" | "pr-open" | "needs-info" | null,
  finish = false,
  approved = true,
) => {
  const ledger = Ledger.create(dataDir, id, { clock: ticking(startMs, 1000) });
  handles.push(ledger);
  if (approved) {
    ledger.append(
      { event: "step_changed", data: { step: "approved 2026-10-04T10:00:00Z" } },
      cause,
    );
  }
  ledger.append({ event: "claimed", data: { machine: "m", github_user: "u" } }, cause);
  if (to !== null) ledger.append({ event: "state_changed", data: { from: "ready", to } }, cause);
  if (finish) ledger.finish("stuck", null, null, cause);
};

describe("listUnfinishedRuns", () => {
  it("an empty data dir has no runs", () => {
    expect(listUnfinishedRuns(tempDir())).toEqual([]);
  });

  it("lists the unfinished runs oldest first with their state and without the finished ones", () => {
    const dataDir = tempDir();
    runAt(dataDir, rid(3), T0 + 20_000, "building");
    runAt(dataDir, rid(1), T0, "triage");
    runAt(dataDir, rid(2), T0 + 10_000, "pr-open", true);
    runAt(dataDir, rid(4), T0 + 30_000, null);
    expect(listUnfinishedRuns(dataDir)).toEqual([
      { id: rid(1), state: "triage", unreadable: false, confirmed: true, session: false },
      { id: rid(3), state: "building", unreadable: false, confirmed: true, session: false },
      { id: rid(4), state: null, unreadable: false, confirmed: true, session: false },
    ]);
  });

  it("a run that ended in needs-info is not listed", () => {
    const dataDir = tempDir();
    runAt(dataDir, rid(5), T0, "needs-info", true);
    expect(listUnfinishedRuns(dataDir)).toEqual([]);
  });

  it("a run whose file cannot be read is still listed, flagged unreadable, after the others", () => {
    const dataDir = tempDir();
    runAt(dataDir, rid(7), T0 + 5_000, "building");
    // A directory named like a run file is a run whose file cannot be read.
    NodeFS.mkdirSync(NodePath.join(dataDir, RUNS_DIR, runIdFileName(rid(6))));
    expect(listUnfinishedRuns(dataDir)).toEqual([
      { id: rid(7), state: "building", unreadable: false, confirmed: true, session: false },
      { id: rid(6), state: null, unreadable: true, confirmed: false, session: false },
    ]);
  });

  it("files that are not named like a run are ignored", () => {
    const dataDir = tempDir();
    NodeFS.mkdirSync(NodePath.join(dataDir, RUNS_DIR), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dataDir, RUNS_DIR, "notes.txt"), "x");
    NodeFS.writeFileSync(NodePath.join(dataDir, RUNS_DIR, "Rawphp__softfac__1__1.jsonl"), "x");
    expect(listUnfinishedRuns(dataDir)).toEqual([]);
  });

  it("a run with an unknown last state is listed with no state", () => {
    const dataDir = tempDir();
    NodeFS.mkdirSync(NodePath.join(dataDir, RUNS_DIR), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(dataDir, RUNS_DIR, runIdFileName(rid(9))),
      `{"ts":"2026-10-04T10:13:16.123Z","ms":${T0},"event":"state_changed","data":{"from":"ready","to":"later"}}\n`,
    );
    expect(listUnfinishedRuns(dataDir)).toEqual([
      { id: rid(9), state: null, unreadable: false, confirmed: false, session: false },
    ]);
  });

  it("a run with no approval and no session is listed as not confirmed", () => {
    const dataDir = tempDir();
    runAt(dataDir, rid(8), T0, "triage", false, false);
    expect(listUnfinishedRuns(dataDir)).toEqual([
      { id: rid(8), state: "triage", unreadable: false, confirmed: false, session: false },
    ]);
  });

  it("with one issue named, lists only that issue's runs, whatever the repo's case", () => {
    const dataDir = tempDir();
    runAt(dataDir, rid(1), T0, "triage");
    runAt(dataDir, rid(1, "rawphp/softfac", 2), T0 + 1_000, "building");
    runAt(dataDir, rid(2), T0 + 2_000, "triage");
    runAt(dataDir, rid(1, "rawphp/other"), T0 + 3_000, "triage");
    // A file of another issue that cannot be read is not opened, so it is not listed.
    NodeFS.mkdirSync(NodePath.join(dataDir, RUNS_DIR, runIdFileName(rid(3))));
    expect(listUnfinishedRuns(dataDir, { repo: "RawPhp/Softfac", issue: 1 })).toEqual([
      { id: rid(1), state: "triage", unreadable: false, confirmed: true, session: false },
      {
        id: rid(1, "rawphp/softfac", 2),
        state: "building",
        unreadable: false,
        confirmed: true,
        session: false,
      },
    ]);
  });
});

describe("listUnfinishedRuns: whether a session may be running", () => {
  it("is set by a launched session or a launch that was sent, and not by the claim alone", () => {
    const dataDir = tempDir();
    runAt(dataDir, rid(1), T0, "triage");
    runAt(dataDir, rid(2), T0 + 10_000, "triage");
    runAt(dataDir, rid(3), T0 + 20_000, "triage");
    const step = (id: RunId, line: Parameters<Ledger["append"]>[0]) => {
      const ledger = Ledger.open(dataDir, id, { clock: ticking(T0 + 30_000, 1000) });
      handles.push(ledger);
      ledger.append(line, cause);
    };
    step(rid(2), { event: "step_changed", data: { step: "launch-sending" } });
    step(rid(3), {
      event: "session_launched",
      data: {
        thread_id: "t-3",
        worktree: "/wt",
        branch: "b",
        model_instance: "m",
        model: "x",
        resumed_from: null,
      },
    });
    expect(listUnfinishedRuns(dataDir).map((r) => [r.id.issue, r.session])).toEqual([
      ["1", false],
      ["2", true],
      ["3", true],
    ]);
  });
});

describe("holdsSlot", () => {
  const run = (state: State | null, confirmed: boolean, unreadable = false) => ({
    id: rid(1),
    state,
    unreadable,
    confirmed,
    session: false,
  });

  it("every confirmed unfinished run holds a slot but one waiting in pr-open", () => {
    expect(holdsSlot(run("building", true))).toBe(true);
    expect(holdsSlot(run("triage", true))).toBe(true);
    expect(holdsSlot(run(null, true))).toBe(true);
    expect(holdsSlot(run("pr-open", true))).toBe(false);
  });

  it("a run that is not confirmed holds no slot: it never launches a session", () => {
    expect(holdsSlot(run("triage", false))).toBe(false);
    expect(holdsSlot(run(null, false))).toBe(false);
  });

  it("a run whose file cannot be read holds a slot", () => {
    expect(holdsSlot(run(null, false, true))).toBe(true);
    expect(holdsSlot(run("pr-open", false, true))).toBe(true);
  });
});

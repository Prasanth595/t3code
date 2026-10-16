// @effect-diagnostics nodeBuiltinImport:off - the script is run for real, in a temp data directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe } from "vite-plus/test";

import { makeCause, type RunEvent } from "./ledger/events.ts";
import { Ledger } from "./ledger/ledger.ts";
import { readRun } from "./ledger/read.ts";
import { runIdToString, type RunId } from "./ledger/runId.ts";
import { T0, useTempDirs } from "./ledger/testSupport.ts";
import { stopRequestPath, takeStopRequest } from "./runner/stop.ts";

const script = NodePath.resolve(import.meta.dirname, "../../../../factory/scripts/stop-run.sh");

const tempDir = useTempDirs();

const run10: RunId = { repo: "rawphp/softfac", issue: "10", attempt: 1 };
const ID = runIdToString(run10);
const NOT_BUILDING_TAIL = "Only a building run is stopped this way.";
/** How a run in `state` ends instead, as the refusal says it. */
const endsBy = (state: string) =>
  state === "pr-open"
    ? " It ends when its pull request is merged or closed."
    : state === "triage" || state === "needs-info"
      ? " To end it, close its issue."
      : "";

const moved = (from: string, to: string): RunEvent =>
  ({ event: "state_changed", data: { from, to } }) as RunEvent;

const CLAIMED: RunEvent = {
  event: "claimed",
  data: { machine: "mac-mini", github_user: "rawphp" },
};

const FINISHED: RunEvent = {
  event: "finished",
  data: {
    outcome: "stuck",
    total_ms: 0,
    gate_attempts: 0,
    review_cycles: null,
    pr_url: null,
    pr_end: null,
  },
};

const seed = (dataDir: string, events: ReadonlyArray<RunEvent>) => {
  const ledger = Ledger.create(dataDir, run10, { clock: () => T0 });
  try {
    for (const event of events) ledger.append(event, makeCause("start", "seed"));
  } finally {
    ledger.close();
  }
};

const BUILDING: ReadonlyArray<RunEvent> = [
  CLAIMED,
  moved("ready", "triage"),
  moved("triage", "building"),
];

/** Runs the script with `T3FAC_DATA` at `dataDir` (or unset) and `HOME` in a temp directory. */
const stop = (dataDir: string | null, ...args: Array<string>) => {
  const home = tempDir("home");
  const result = NodeChildProcess.spawnSync("bash", [script, ...args], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      ...(dataDir === null ? {} : { T3FAC_DATA: dataDir }),
    },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, home };
};

describe("factory/scripts/stop-run.sh", () => {
  it("is executable", () => {
    assert.ok((NodeFS.statSync(script).mode & 0o100) !== 0);
  });

  it("with no run id prints the usage and exits 1", () => {
    const result = stop(tempDir());
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /^usage: .*stop-run\.sh <run id>/);
    assert.strictEqual(result.stdout, "");
  });

  it("refuses a run id that names a path", () => {
    const dataDir = tempDir();
    const result = stop(dataDir, "../escape");
    assert.strictEqual(result.status, 1);
    assert.strictEqual(NodeFS.existsSync(NodePath.join(dataDir, "stop-requests")), false);
  });

  it("says when the run has no ledger", () => {
    const dataDir = tempDir();
    const result = stop(dataDir, ID);
    assert.strictEqual(result.status, 1);
    assert.strictEqual(result.stderr, `run ${ID} has no ledger under ${dataDir}\n`);
    assert.strictEqual(NodeFS.existsSync(NodePath.join(dataDir, "stop-requests")), false);
  });

  it("refuses a run that is finished", () => {
    const dataDir = tempDir();
    seed(dataDir, [...BUILDING, FINISHED]);
    const result = stop(dataDir, ID);
    assert.strictEqual(result.status, 1);
    assert.strictEqual(
      result.stderr,
      `run ${ID} is not building: it is finished. ${NOT_BUILDING_TAIL}\n`,
    );
    assert.strictEqual(NodeFS.existsSync(NodePath.join(dataDir, "stop-requests")), false);
  });

  it("refuses a run in another state, naming it", () => {
    for (const state of ["triage", "needs-info", "pr-open", "stuck"]) {
      const dataDir = tempDir();
      seed(dataDir, [
        CLAIMED,
        moved("ready", "triage"),
        ...(state === "triage" ? [] : [moved("triage", state)]),
      ]);
      const result = stop(dataDir, ID);
      assert.strictEqual(result.status, 1, state);
      assert.strictEqual(
        result.stderr,
        `run ${ID} is not building: its state is ${state}. ${NOT_BUILDING_TAIL}${endsBy(state)}\n`,
        state,
      );
      assert.strictEqual(NodeFS.existsSync(NodePath.join(dataDir, "stop-requests")), false);
    }
  });

  it("refuses a run that has no state yet", () => {
    const dataDir = tempDir();
    seed(dataDir, [CLAIMED]);
    const result = stop(dataDir, ID);
    assert.strictEqual(result.status, 1);
    assert.strictEqual(
      result.stderr,
      `run ${ID} is not building: it has no state yet. ${NOT_BUILDING_TAIL}${endsBy("triage")}\n`,
    );
  });

  it("reads the last state of a run that came back to building", () => {
    const dataDir = tempDir();
    seed(dataDir, [...BUILDING, moved("building", "pr-open"), moved("pr-open", "building")]);
    assert.strictEqual(stop(dataDir, ID).status, 0);
  });

  it("reads the state from the `to` key wherever it sits in the line", () => {
    // The ledger writes `from` first; a line written another way must read the same.
    for (const [to, status] of [
      ["building", 0],
      ["pr-open", 1],
    ] as const) {
      const dataDir = tempDir();
      seed(dataDir, [CLAIMED, moved("ready", "triage")]);
      NodeFS.appendFileSync(
        NodePath.join(dataDir, "runs", `${ID}.jsonl`),
        `${JSON.stringify({
          ts: "2026-10-16T00:00:00.000Z",
          ms: 0,
          event: "state_changed",
          data: { to, from: "triage" },
          cause: { step: "start", reason: "seed" },
        })}\n`,
      );
      assert.strictEqual(stop(dataDir, ID).status, status, to);
    }
  });

  it("writes the request and says what happens next", () => {
    const dataDir = tempDir();
    seed(dataDir, BUILDING);
    const before = NodeFS.readFileSync(NodePath.join(dataDir, "runs", `${ID}.jsonl`), "utf8");
    const result = stop(dataDir, ID);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(
      result.stdout,
      `stop requested: ${ID}; the issue goes to factory:stuck on the next pass\n`,
    );
    assert.strictEqual(result.stderr, "");
    assert.strictEqual(NodeFS.readFileSync(stopRequestPath(dataDir, run10), "utf8"), "operator\n");
    // The script asks; it never writes the ledger or prints it.
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(dataDir, "runs", `${ID}.jsonl`), "utf8"),
      before,
    );
    assert.ok(!result.stdout.includes("github_user"));
  });

  it("overwrites an earlier request", () => {
    const dataDir = tempDir();
    seed(dataDir, BUILDING);
    NodeFS.mkdirSync(NodePath.join(dataDir, "stop-requests"));
    NodeFS.writeFileSync(stopRequestPath(dataDir, run10), "someone else, a long time ago\n");
    assert.strictEqual(stop(dataDir, ID).status, 0);
    assert.strictEqual(NodeFS.readFileSync(stopRequestPath(dataDir, run10), "utf8"), "operator\n");
  });

  it("keeps its data under ~/.config/t3fac/factory when T3FAC_DATA is not set", () => {
    const home = tempDir("home");
    const dataDir = NodePath.join(home, ".config", "t3fac", "factory");
    seed(dataDir, BUILDING);
    const result = NodeChildProcess.spawnSync("bash", [script, ID], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(NodeFS.readFileSync(stopRequestPath(dataDir, run10), "utf8"), "operator\n");
  });

  it.effect("writes a request the pass takes: the file's place and words agree", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seed(dataDir, BUILDING);
      assert.strictEqual(stop(dataDir, ID).status, 0);
      assert.strictEqual(yield* takeStopRequest(dataDir, run10, () => T0 + 1), "recorded");
      const last = readRun(dataDir, run10).entries.at(-1)!;
      assert.deepStrictEqual(
        { event: last.event, data: last.data },
        {
          event: "stop_requested",
          data: { by: "operator" },
        },
      );
    }),
  );
});

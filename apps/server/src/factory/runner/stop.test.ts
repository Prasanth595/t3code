// @effect-diagnostics nodeBuiltinImport:off - the tests lay out the request files and read the bytes of real run files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe } from "vite-plus/test";

import { makeCause, type RunEvent } from "../ledger/events.ts";
import { Ledger } from "../ledger/ledger.ts";
import { readRun } from "../ledger/read.ts";
import { runPath, type RunId } from "../ledger/runId.ts";
import { T0, useTempDirs } from "../ledger/testSupport.ts";
import { STOP_REQUESTS_DIR, stopRequestPath, takeStopRequest } from "./stop.ts";

const tempDir = useTempDirs();

const run10: RunId = { repo: "rawphp/softfac", issue: "10", attempt: 1 };

const BUILDING: ReadonlyArray<RunEvent> = [
  { event: "claimed", data: { machine: "mac-mini", github_user: "rawphp" } },
  { event: "state_changed", data: { from: "ready", to: "triage" } },
  { event: "state_changed", data: { from: "triage", to: "building" } },
];

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

/** What `stop-run.sh` leaves: the word `operator` and a newline. */
const request = (dataDir: string) => {
  const path = stopRequestPath(dataDir, run10);
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, "operator\n");
  return path;
};

const bytesOf = (dataDir: string) => NodeFS.readFileSync(runPath(dataDir, run10), "utf8");

describe("takeStopRequest", () => {
  it("keeps its requests in a directory of the data dir, one file per run", () => {
    assert.strictEqual(STOP_REQUESTS_DIR, "stop-requests");
    assert.strictEqual(
      stopRequestPath("/data", run10),
      NodePath.join("/data", "stop-requests", "rawphp__softfac__10__1"),
    );
  });

  it.effect("is none, and writes nothing, when no one asked", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seed(dataDir, BUILDING);
      const bytes = bytesOf(dataDir);
      assert.strictEqual(yield* takeStopRequest(dataDir, run10, () => T0 + 5), "none");
      assert.strictEqual(bytesOf(dataDir), bytes);
    }),
  );

  it.effect("records the request in the ledger and removes the file", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seed(dataDir, BUILDING);
      const path = request(dataDir);
      assert.strictEqual(yield* takeStopRequest(dataDir, run10, () => T0 + 5), "recorded");
      const last = readRun(dataDir, run10).entries.at(-1)!;
      assert.strictEqual(last.event, "stop_requested");
      assert.deepStrictEqual(last.data, { by: "operator" });
      assert.strictEqual(last.ms, T0 + 5);
      assert.deepStrictEqual(last.cause, makeCause("operator", "stop-requested"));
      assert.strictEqual(NodeFS.existsSync(path), false);
    }),
  );

  it.effect("finds the line already there, as after a crash before the file was removed", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seed(dataDir, [...BUILDING, { event: "stop_requested", data: { by: "operator" } }]);
      const path = request(dataDir);
      const bytes = bytesOf(dataDir);
      assert.strictEqual(yield* takeStopRequest(dataDir, run10, () => T0 + 5), "already-requested");
      assert.strictEqual(bytesOf(dataDir), bytes);
      assert.strictEqual(NodeFS.existsSync(path), false);
    }),
  );

  it.effect("writes nothing to a run that finished, and removes the file", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seed(dataDir, [...BUILDING, FINISHED]);
      const path = request(dataDir);
      const bytes = bytesOf(dataDir);
      assert.strictEqual(yield* takeStopRequest(dataDir, run10, () => T0 + 5), "finished");
      assert.strictEqual(bytesOf(dataDir), bytes);
      assert.strictEqual(NodeFS.existsSync(path), false);
    }),
  );

  it.effect("is an error when the run has no ledger, and the file is kept", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const path = request(dataDir);
      const error = yield* Effect.flip(takeStopRequest(dataDir, run10, () => T0));
      assert.strictEqual(error._tag, "LedgerNotFoundError");
      assert.strictEqual(NodeFS.existsSync(path), true);
    }),
  );
});

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
import { LedgerNotFoundError } from "../ledger/errors.ts";
import { T0, catchLedgerError, useTempDirs } from "../ledger/testSupport.ts";
import { readProgress } from "./progress.ts";
import {
  STOP_REQUESTS_DIR,
  notBuildingMessage,
  requestStop,
  stopRequestPath,
  takeStopRequest,
} from "./stop.ts";

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

  it.effect.each<{ name: string; events: ReadonlyArray<RunEvent> }>([
    {
      name: "pr-open",
      events: [...BUILDING, { event: "state_changed", data: { from: "building", to: "pr-open" } }],
    },
    {
      name: "needs-info",
      events: [
        ...BUILDING,
        { event: "state_changed", data: { from: "building", to: "needs-info" } },
      ],
    },
    { name: "no state yet", events: [BUILDING[0]!] },
  ])("drops a request for a run at $name: no line, the file removed", ({ events }) =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seed(dataDir, events);
      const path = request(dataDir);
      const bytes = bytesOf(dataDir);
      assert.strictEqual(yield* takeStopRequest(dataDir, run10, () => T0 + 5), "not-building");
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

describe("requestStop", () => {
  it("records a stop for a building run, once", () => {
    const dataDir = tempDir();
    seed(dataDir, BUILDING);
    assert.strictEqual(
      requestStop(dataDir, run10, () => T0 + 5),
      "recorded",
    );
    const lines = readRun(dataDir, run10).entries;
    const last = lines.at(-1)!;
    assert.strictEqual(last.event, "stop_requested");
    assert.deepStrictEqual(last.data, { by: "operator" });
    assert.strictEqual(last.ms, T0 + 5);
    assert.deepStrictEqual(last.cause, { step: "operator", reason: "stop-requested" });
    const bytes = bytesOf(dataDir);
    assert.strictEqual(
      requestStop(dataDir, run10, () => T0 + 9),
      "already-requested",
    );
    assert.strictEqual(bytesOf(dataDir), bytes);
  });

  it("writes nothing to a run that finished", () => {
    const dataDir = tempDir();
    seed(dataDir, [...BUILDING, FINISHED]);
    const bytes = bytesOf(dataDir);
    assert.strictEqual(
      requestStop(dataDir, run10, () => T0 + 5),
      "finished",
    );
    assert.strictEqual(bytesOf(dataDir), bytes);
  });

  it.each(["triage", "needs-info", "pr-open"] as const)(
    "writes nothing to a run in %s",
    (state) => {
      const dataDir = tempDir();
      seed(dataDir, [
        { event: "claimed", data: { machine: "mac-mini", github_user: "rawphp" } },
        { event: "state_changed", data: { from: "ready", to: state } },
      ]);
      const bytes = bytesOf(dataDir);
      assert.strictEqual(
        requestStop(dataDir, run10, () => T0 + 5),
        "not-building",
      );
      assert.strictEqual(bytesOf(dataDir), bytes);
    },
  );

  it("writes nothing to a run with no state yet", () => {
    const dataDir = tempDir();
    seed(dataDir, [BUILDING[0]!]);
    assert.strictEqual(
      requestStop(dataDir, run10, () => T0 + 5),
      "not-building",
    );
  });

  it("fails for a run with no ledger", () => {
    catchLedgerError(() => requestStop(tempDir(), run10, () => T0), LedgerNotFoundError);
  });
});

describe("notBuildingMessage", () => {
  const messageFor = (events: ReadonlyArray<RunEvent>) => {
    const dataDir = tempDir();
    seed(dataDir, events);
    return notBuildingMessage("ID", readProgress(readRun(dataDir, run10).entries));
  };
  const moved = (to: string): RunEvent =>
    ({ event: "state_changed", data: { from: "ready", to } }) as RunEvent;

  it("says a finished run is finished, with no way out", () => {
    assert.strictEqual(
      messageFor([...BUILDING, FINISHED]),
      "run ID is not building: it is finished. Only a building run is stopped this way.",
    );
  });

  it("says how a run in another state ends instead", () => {
    const base = "run ID is not building: its state is";
    const tail = "Only a building run is stopped this way.";
    assert.strictEqual(
      messageFor([BUILDING[0]!, moved("pr-open")]),
      `${base} pr-open. ${tail} It ends when its pull request is merged or closed.`,
    );
    assert.strictEqual(
      messageFor([BUILDING[0]!, moved("triage")]),
      `${base} triage. ${tail} To end it, close its issue.`,
    );
    assert.strictEqual(
      messageFor([BUILDING[0]!, moved("needs-info")]),
      `${base} needs-info. ${tail} To end it, close its issue.`,
    );
    assert.strictEqual(messageFor([BUILDING[0]!, moved("stuck")]), `${base} stuck. ${tail}`);
  });

  it("says a run with no state has none yet", () => {
    assert.strictEqual(
      messageFor([BUILDING[0]!]),
      "run ID is not building: it has no state yet. Only a building run is stopped this way. To end it, close its issue.",
    );
  });
});

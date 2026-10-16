import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import type { Entry } from "../ledger/read.ts";
import { readProgress } from "./progress.ts";

const MINUTE = 60_000;

const line = (ms: number, event: string, data: unknown): Entry => ({
  ts: "2026-10-04T10:00:00Z",
  ms,
  event,
  data,
  cause: null,
});

const step = (ms: number, text: string) => line(ms, "step_changed", { step: text });
const moved = (ms: number, from: string, to: string) => line(ms, "state_changed", { from, to });
const launched = (ms: number) =>
  line(ms, "session_launched", {
    thread_id: "thread-1",
    worktree: "/t3/wt",
    branch: "t3code/abc",
    model_instance: null,
    model: null,
    resumed_from: null,
  });

describe("readProgress: the pull request", () => {
  it("keeps every pull request the run reported and the newest one with its url", () => {
    const seen = readProgress([
      line(1, "pr_opened", { pr: 12, url: "https://github.com/rawphp/softfac/pull/12" }),
      line(2, "pr_opened", { pr: 14, url: "https://github.com/rawphp/softfac/pull/14" }),
    ]);
    assert.deepStrictEqual(seen.opened, [12, 14]);
    assert.deepStrictEqual(seen.lastPr, {
      pr: 14,
      url: "https://github.com/rawphp/softfac/pull/14",
    });
  });

  it("has none before the first", () => {
    const seen = readProgress([]);
    assert.deepStrictEqual(seen.opened, []);
    assert.strictEqual(seen.lastPr, null);
    assert.strictEqual(seen.prReported, false);
  });

  it("is reported from pr_opened until the run is building again", () => {
    const opened = line(1, "pr_opened", {
      pr: 12,
      url: "https://github.com/rawphp/softfac/pull/12",
    });
    assert.strictEqual(readProgress([opened]).prReported, true);
    assert.strictEqual(readProgress([opened, moved(2, "building", "pr-open")]).prReported, true);
    assert.strictEqual(
      readProgress([opened, moved(2, "building", "pr-open"), moved(3, "pr-open", "building")])
        .prReported,
      false,
    );
  });
});

describe("readProgress: the questions", () => {
  it("are posted from questions_posted until the run is building again", () => {
    assert.strictEqual(
      readProgress([line(1, "questions_posted", { questions: "q" })]).questionsPosted,
      true,
    );
    assert.strictEqual(
      readProgress([
        line(1, "questions_posted", { questions: "q" }),
        moved(2, "needs-info", "building"),
      ]).questionsPosted,
      false,
    );
    assert.strictEqual(
      readProgress([
        line(1, "questions_posted", { questions: "q" }),
        moved(2, "building", "needs-info"),
      ]).questionsPosted,
      true,
    );
  });
});

describe("readProgress: the reminder and the wait for a newer run", () => {
  it("reads the ordinal of a reminder that was started, and that it was sent", () => {
    const started = readProgress([step(1, "result-line-reminding 3")]);
    assert.strictEqual(started.reminding, 3);
    assert.strictEqual(started.reminded, false);
    const sent = readProgress([
      step(1, "result-line-reminding 3"),
      step(2, "result-line-reminded"),
    ]);
    assert.strictEqual(sent.reminding, 3);
    assert.strictEqual(sent.reminded, true);
  });

  it("waits for a run newer than the reminder's, or a forward's", () => {
    assert.strictEqual(readProgress([step(1, "result-line-reminding 3")]).waitingAfter, 3);
    assert.strictEqual(readProgress([step(1, "forward-wait 2")]).waitingAfter, 2);
    assert.strictEqual(readProgress([]).waitingAfter, null);
  });

  it("never waits for an older run than before", () => {
    assert.strictEqual(
      readProgress([step(1, "forward-wait 4"), step(2, "result-line-reminding 2")]).waitingAfter,
      4,
    );
    assert.strictEqual(
      readProgress([step(1, "forward-wait 2"), step(2, "result-line-reminding 2")]).waitingAfter,
      2,
    );
  });

  it("does not read a forward's wait as a reminder", () => {
    const seen = readProgress([step(1, "forward-wait 1")]);
    assert.strictEqual(seen.reminding, null);
    assert.strictEqual(seen.reminded, false);
  });

  it("ignores steps whose number is not one", () => {
    const seen = readProgress([
      step(1, "result-line-reminding"),
      step(2, "result-line-reminding x"),
      step(3, "result-line-reminding 01"),
      step(4, "result-line-reminding 1 2"),
    ]);
    assert.strictEqual(seen.reminding, null);
    assert.strictEqual(seen.waitingAfter, null);
  });

  it("starts again for a new session: each thread has one reminder and its own run numbers", () => {
    const seen = readProgress([
      step(1, "result-line-reminding 3"),
      step(2, "result-line-reminded"),
      line(3, "session_paused", { run_ordinal: 3 }),
      launched(4),
    ]);
    assert.strictEqual(seen.reminding, null);
    assert.strictEqual(seen.reminded, false);
    assert.strictEqual(seen.waitingAfter, null);
    assert.strictEqual(seen.paused, null);
  });
});

describe("readProgress: a stop by hand", () => {
  it("keeps the newest pause with the run it stopped", () => {
    assert.strictEqual(readProgress([]).paused, null);
    assert.deepStrictEqual(readProgress([line(1, "session_paused", { run_ordinal: 2 })]).paused, {
      runOrdinal: 2,
    });
    assert.deepStrictEqual(
      readProgress([
        line(1, "session_paused", { run_ordinal: 2 }),
        line(2, "session_paused", { run_ordinal: null }),
      ]).paused,
      { runOrdinal: null },
    );
  });
});

describe("readProgress: the time worked", () => {
  it("counts from the first line while the run is in triage or building", () => {
    const seen = readProgress([line(1000, "claimed", {}), moved(1000, "ready", "triage")]);
    assert.strictEqual(seen.workedMs, 0);
    assert.strictEqual(seen.workingSince, 1000);
  });

  it("is zero and not counting for a ledger with no lines", () => {
    const seen = readProgress([]);
    assert.strictEqual(seen.workedMs, 0);
    assert.strictEqual(seen.workingSince, null);
  });

  it("adds each stint when the state changes, and starts the next in triage or building", () => {
    const seen = readProgress([
      line(0, "claimed", {}),
      moved(0, "ready", "triage"),
      moved(MINUTE, "triage", "building"),
      moved(10 * MINUTE, "building", "needs-info"),
    ]);
    assert.strictEqual(seen.workedMs, 10 * MINUTE);
    assert.strictEqual(seen.workingSince, null);
  });

  it("stops counting when the run is finished", () => {
    const seen = readProgress([
      line(0, "claimed", {}),
      moved(0, "ready", "triage"),
      line(5 * MINUTE, "finished", {}),
    ]);
    assert.strictEqual(seen.workingSince, null);
  });

  it("does not charge the build again when a pull request that was open comes back to building", () => {
    const seen = readProgress([
      line(0, "claimed", {}),
      moved(0, "ready", "triage"),
      moved(MINUTE, "triage", "building"),
      moved(30 * MINUTE, "building", "pr-open"),
      moved(500 * MINUTE, "pr-open", "building"),
    ]);
    assert.strictEqual(seen.workedMs, 0);
    assert.strictEqual(seen.workingSince, 500 * MINUTE);
  });

  it("never counts a backwards clock", () => {
    const seen = readProgress([
      line(10 * MINUTE, "claimed", {}),
      moved(5 * MINUTE, "ready", "triage"),
    ]);
    assert.strictEqual(seen.workedMs, 0);
  });
});

describe("readProgress: a stop by hand", () => {
  it("is requested from the stop_requested line on, whatever follows", () => {
    assert.strictEqual(readProgress([]).stopRequested, false);
    const requested = line(1, "stop_requested", { by: "operator" });
    assert.strictEqual(readProgress([requested]).stopRequested, true);
    assert.strictEqual(
      readProgress([requested, step(2, "launch-sending"), moved(3, "triage", "building")])
        .stopRequested,
      true,
    );
  });
});

describe("readProgress: forwarded comments and body edits", () => {
  it("keeps the id of every comment_forwarded line", () => {
    assert.deepStrictEqual([...readProgress([]).forwarded], []);
    const seen = readProgress([
      line(1, "comment_forwarded", { comment_id: "102" }),
      line(2, "comment_forwarded", { comment_id: "101" }),
      line(3, "comment_forwarded", { comment_id: "102" }),
    ]);
    assert.deepStrictEqual([...seen.forwarded].sort(), ["101", "102"]);
  });

  it("keeps the time of every body-edit-forwarded step, whatever follows the space", () => {
    const seen = readProgress([
      step(1, "body-edit-forwarded 2026-10-04T10:15:00Z"),
      step(2, "body-edit-forwarded x"),
    ]);
    assert.deepStrictEqual([...seen.bodyEdits].sort(), ["2026-10-04T10:15:00Z", "x"]);
  });

  it("does not count a step that only looks like a forwarded edit", () => {
    const seen = readProgress([
      step(1, "body-edit-forwarded2026-10-04T10:15:00Z"),
      step(2, "body-edit-forward 2026-10-04T10:15:00Z"),
      step(3, "Body-edit-forwarded 2026-10-04T10:15:00Z"),
      step(4, "xbody-edit-forwarded 2026-10-04T10:15:00Z"),
    ]);
    assert.deepStrictEqual([...seen.bodyEdits], []);
  });

  it("keeps the id of every comment-dropped step", () => {
    assert.deepStrictEqual([...readProgress([]).dropped], []);
    const seen = readProgress([
      step(1, "comment-dropped 8"),
      step(2, "comment-dropped IC_kwDO1"),
      step(3, "comment-dropped 8"),
    ]);
    assert.deepStrictEqual([...seen.dropped].sort(), ["8", "IC_kwDO1"]);
  });

  it("a comment-dropped id is one plain token", () => {
    const seen = readProgress(
      [
        "comment-dropped ",
        "comment-dropped a b",
        "comment-dropped a\tb",
        "comment-dropped a\u0007b",
        "comment-dropped a\n",
        "comment-dropped7",
      ].map((text, index) => step(index + 1, text)),
    );
    assert.deepStrictEqual([...seen.dropped], []);
  });
});

describe("readProgress: the last wait marker", () => {
  const sentBack = (ms: number, ordinal: number) =>
    line(ms, "gate_sent_back", { attempt: 1, run_ordinal: ordinal });
  const command = (ms: number) =>
    line(ms, "gate_command", { attempt: 1, command: "cargo test", exit_code: 0, duration_ms: 5 });

  it("is none before any marker", () => {
    assert.strictEqual(readProgress([launched(1)]).lastWait, null);
  });

  it("is the ordinal of a forward-wait, a reminder or a send-back, whichever is the newest", () => {
    assert.strictEqual(readProgress([step(1, "forward-wait 3")]).lastWait, 3);
    assert.strictEqual(readProgress([step(1, "result-line-reminding 2")]).lastWait, 2);
    assert.strictEqual(readProgress([sentBack(1, 4)]).lastWait, 4);
    assert.strictEqual(readProgress([step(1, "forward-wait 1"), sentBack(2, 2)]).lastWait, 2);
  });

  it("never goes down when a marker for an older run is written later", () => {
    const seen = readProgress([step(1, "forward-wait 3"), sentBack(2, 2)]);
    assert.strictEqual(seen.lastWait, 3);
    assert.strictEqual(seen.waitingAfter, 3);
  });

  it("is kept after a gate_command drops a send-back's marker", () => {
    const seen = readProgress([sentBack(1, 2), command(2)]);
    assert.strictEqual(seen.waitingAfter, null);
    assert.strictEqual(seen.lastWait, 2);
  });

  it("starts again with a new session", () => {
    const seen = readProgress([step(1, "forward-wait 5"), launched(2)]);
    assert.strictEqual(seen.lastWait, null);
    assert.strictEqual(seen.waitingAfter, null);
  });

  it("ignores a step that only looks like a wait marker", () => {
    for (const bad of [
      "forward-wait 007",
      "forward-wait -1",
      "forward-wait 1 ",
      "forward-wait x",
    ]) {
      const seen = readProgress([step(1, bad)]);
      assert.strictEqual(seen.lastWait, null, bad);
      assert.strictEqual(seen.waitingAfter, null, bad);
    }
  });
});

describe("readProgress: an interruption", () => {
  const interrupted = (ms: number, over: Record<string, unknown> = {}) =>
    line(ms, "session_interrupted", {
      resumes: 1,
      relaunch: false,
      run_ordinal: 2,
      branch: "t3code/abc",
      t3_error: null,
      ended_in_pass: 2,
      ...over,
    });

  it("is none before the first line", () => {
    const seen = readProgress([launched(1)]);
    assert.strictEqual(seen.interruption, null);
    assert.strictEqual(seen.lastBranch, "t3code/abc");
  });

  it("keeps the newest line, owed its send until the matching step", () => {
    const owed = readProgress([launched(1), interrupted(2)]);
    assert.deepStrictEqual(owed.interruption, {
      resumes: 1,
      relaunch: false,
      runOrdinal: 2,
      sent: false,
    });
    const sent = readProgress([launched(1), interrupted(2), step(3, "interruption-sent 1")]);
    assert.strictEqual(sent.interruption?.sent, true);
    // A step for another count is not this line's.
    const other = readProgress([launched(1), interrupted(2), step(3, "interruption-sent 2")]);
    assert.strictEqual(other.interruption?.sent, false);
  });

  it("is a wait marker for the run that ended, as a forward's is", () => {
    const seen = readProgress([launched(1), interrupted(2)]);
    assert.strictEqual(seen.waitingAfter, 2);
    assert.strictEqual(seen.lastWait, 2);
    // A relaunch waits for nothing: the thread is gone.
    const relaunch = readProgress([
      launched(1),
      interrupted(2, { relaunch: true, run_ordinal: null }),
    ]);
    assert.strictEqual(relaunch.waitingAfter, null);
    assert.strictEqual(relaunch.interruption?.relaunch, true);
  });

  it("names the newest branch a launch or an interruption line carries", () => {
    const seen = readProgress([
      launched(1),
      interrupted(2, { branch: "t3code/def" }),
      interrupted(3, { branch: null }),
    ]);
    assert.strictEqual(seen.lastBranch, "t3code/def");
  });

  it("owes nothing to a new session: its thread has its own runs", () => {
    const seen = readProgress([launched(1), interrupted(2), launched(3)]);
    assert.strictEqual(seen.interruption?.sent, true);
    assert.strictEqual(seen.waitingAfter, null);
  });
});

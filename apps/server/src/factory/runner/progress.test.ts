import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import type { Entry } from "../ledger/read.ts";
import {
  movedSince,
  pendingRelaunch,
  readProgress,
  regateAttempt,
  relaunchCommandId,
} from "./progress.ts";

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

describe("readProgress: gating again", () => {
  const HEAD = "4f1c2d3e4a5b60718293a4b5c6d7e8f901234567";
  const PUSHED = "7e6d5c4b3a291807f6e5d4c3b2a190817263a4b5";
  const BASE = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
  const MOVED = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
  const RUN = { repo: "rawphp/softfac", issue: "10", attempt: 1 };

  const checkout = (ms: number, base: string) =>
    line(ms, "gate_checkout", { attempt: 1, dir: "/d", sha: HEAD, base_sha: base });
  const command = (ms: number) =>
    line(ms, "gate_command", { attempt: 1, command: "cargo test", exit_code: 0, duration_ms: 5 });
  const passed = (ms: number) => ({
    ...step(ms, `gate-passed ${HEAD} 1`),
    cause: { step: "gate", reason: "gate-passed", attempt: 1 },
  });
  /** A pass on `HEAD` against `BASE`, then `pr-open`. */
  const PASS: ReadonlyArray<Entry> = [
    launched(1),
    line(2, "pr_opened", { pr: 12, url: "https://github.com/rawphp/softfac/pull/12" }),
    checkout(3, BASE),
    command(4),
    passed(5),
    step(6, "gate-results-posted"),
    moved(7, "building", "pr-open"),
  ];
  const regated = (ms: number, sha: string, base: string, previous: string) =>
    line(ms, "gate_regate", { sha, base_sha: base, previous_base_sha: previous });
  const relaunching = (ms: number) =>
    line(ms, "regate_relaunching", { attempt: 2, branch: "t3code/abc", message: "boom" });

  it("has no re-gate under way before a gate_regate line", () => {
    const seen = readProgress(PASS);
    assert.strictEqual(seen.regating, false);
    assert.strictEqual(seen.regateMoved, null);
    assert.strictEqual(seen.regatePassed, false);
    assert.strictEqual(seen.regateSentBack, false);
    assert.strictEqual(seen.relaunch, null);
    assert.strictEqual(seen.regates, 0);
  });

  it("is under way from a gate_regate line, and says what moved since the recorded pass", () => {
    const seen = readProgress([...PASS, regated(8, HEAD, MOVED, BASE)]);
    assert.strictEqual(seen.regating, true);
    assert.strictEqual(seen.regateMoved, "base");
    assert.strictEqual(seen.regates, 1);
    assert.strictEqual(readProgress([...PASS, regated(8, PUSHED, BASE, BASE)]).regateMoved, "head");
    assert.strictEqual(
      readProgress([...PASS, regated(8, PUSHED, MOVED, BASE)]).regateMoved,
      "both",
    );
  });

  it("keeps the newest line's answer when the base moves again", () => {
    const seen = readProgress([
      ...PASS,
      regated(8, HEAD, MOVED, BASE),
      regated(9, HEAD, BASE, MOVED),
    ]);
    assert.strictEqual(seen.regates, 2);
    assert.strictEqual(seen.regateMoved, "base");
  });

  it("records a pass of the re-gate, and drops it with the posted results", () => {
    const again = [...PASS, regated(8, HEAD, MOVED, BASE), command(9), passed(10)];
    assert.strictEqual(readProgress(again).regatePassed, true);
    assert.strictEqual(readProgress(again).regating, true);
    const posted = readProgress([...again, step(11, "gate-results-posted")]);
    assert.strictEqual(posted.regating, false);
    assert.strictEqual(posted.regatePassed, false);
    // A pass that is not a re-gate's is not a regate pass.
    assert.strictEqual(readProgress([launched(1), command(2), passed(3)]).regatePassed, false);
  });

  it("records a failure of the re-gate as sent back, until the state changes", () => {
    const sent = [
      ...PASS,
      regated(8, HEAD, MOVED, BASE),
      line(9, "gate_sent_back", { attempt: 2, run_ordinal: 0 }),
    ];
    assert.strictEqual(readProgress(sent).regateSentBack, true);
    const back = readProgress([...sent, moved(10, "pr-open", "building")]);
    assert.strictEqual(back.regateSentBack, false);
    assert.strictEqual(back.regating, false);
    assert.strictEqual(
      readProgress([...PASS, line(8, "gate_sent_back", { attempt: 2, run_ordinal: 3 })])
        .regateSentBack,
      false,
    );
  });

  it("holds a relaunch from its decision until the state changes", () => {
    const seen = readProgress([...PASS, regated(8, HEAD, MOVED, BASE), relaunching(9)]);
    assert.deepStrictEqual(seen.relaunch, {
      fixes: { kind: "regate", attempt: 2 },
      branch: "t3code/abc",
      message: "boom",
    });
    assert.deepStrictEqual(seen.sending, { attempt: 2, runOrdinal: 0 });
    assert.strictEqual(seen.launchedSinceSending, false);
    assert.strictEqual(pendingRelaunch(seen), seen.relaunch);
    assert.strictEqual(
      readProgress([...PASS, relaunching(9), moved(10, "pr-open", "building")]).relaunch,
      null,
    );
  });

  it("is no longer pending once a session is launched after the decision", () => {
    const seen = readProgress([...PASS, relaunching(9), launched(10)]);
    assert.strictEqual(seen.launchedSinceSending, true);
    assert.strictEqual(pendingRelaunch(seen), null);
    assert.notStrictEqual(seen.relaunch, null);
    assert.strictEqual(pendingRelaunch(readProgress(PASS)), null);
  });

  it("forgets a launch when a later gate-sending step or relaunch decision comes", () => {
    const launchedAfter = [launched(1), step(2, "gate-sending 1 1"), launched(3)];
    assert.strictEqual(readProgress(launchedAfter).launchedSinceSending, true);
    assert.strictEqual(
      readProgress([...launchedAfter, step(4, "gate-sending 2 1")]).launchedSinceSending,
      false,
    );
    assert.strictEqual(
      readProgress([...launchedAfter, relaunching(4)]).launchedSinceSending,
      false,
    );
  });

  it("reads a feedback relaunch, which is no attempt and no gate-sending", () => {
    const seen = readProgress([
      ...PASS,
      line(8, "feedback_relaunching", {
        n: 3,
        branch: "t3code/abc",
        items: ["review:1"],
        message: "fix it",
      }),
    ]);
    assert.deepStrictEqual(seen.relaunch, {
      fixes: { kind: "feedback", n: 3 },
      branch: "t3code/abc",
      message: "fix it",
    });
    assert.strictEqual(seen.sending, null);
    assert.strictEqual(regateAttempt(seen.relaunch!), null);
    assert.strictEqual(
      relaunchCommandId(seen.relaunch!, RUN),
      "softfac:rawphp__softfac__10__1:feedback:3",
    );
  });

  it("names a re-gate relaunch's attempt and command id", () => {
    const seen = readProgress([...PASS, relaunching(8)]);
    assert.strictEqual(regateAttempt(seen.relaunch!), 2);
    assert.strictEqual(
      relaunchCommandId(seen.relaunch!, RUN),
      "softfac:rawphp__softfac__10__1:regate:2",
    );
  });
});

describe("movedSince: what differs from the recorded pass", () => {
  const HEAD = "4f1c2d3e4a5b60718293a4b5c6d7e8f901234567";
  const PUSHED = "7e6d5c4b3a291807f6e5d4c3b2a190817263a4b5";
  const BASE = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
  const MOVED = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

  it("is nothing without a pass on record, whatever the head and tip are", () => {
    assert.strictEqual(movedSince("", "", HEAD, BASE), null);
  });
  it("is the base when only the tip differs, with or without a head on record", () => {
    assert.strictEqual(movedSince("", BASE, HEAD, MOVED), "base");
    assert.strictEqual(movedSince(HEAD, BASE, HEAD, MOVED), "base");
  });
  it("is the head when only the head differs and no base is on record", () => {
    assert.strictEqual(movedSince(HEAD, "", PUSHED, BASE), "head");
    assert.strictEqual(movedSince(HEAD, BASE, PUSHED, BASE), "head");
  });
  it("is both when both differ", () => {
    assert.strictEqual(movedSince(HEAD, BASE, PUSHED, MOVED), "both");
  });
  it("is unknown for a pass with a head and no base when the head did not move", () => {
    assert.strictEqual(movedSince(HEAD, "", HEAD, MOVED), "unknown");
    assert.strictEqual(movedSince(HEAD, "", HEAD, BASE), "unknown");
  });
  it("compares commit ids without regard to case", () => {
    assert.strictEqual(movedSince(HEAD, BASE, HEAD.toUpperCase(), BASE.toUpperCase()), null);
  });
});

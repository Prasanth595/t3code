/**
 * The events a run ledger can hold, and the fields of each in the order they are written to the
 * file. `docs/reference/ledger.md` in softfac is the spec; the order of the fields is the order
 * of the fields in softfac's `Event` enum, which is the order serde writes them in.
 */

/** Which part of the factory wrote a line. */
export const CAUSE_STEPS = [
  "start",
  "watch",
  "forward",
  "advance",
  "gate",
  "pass",
  "retro",
  "operator",
] as const;
export type CauseStep = (typeof CAUSE_STEPS)[number];

/** How a run ended. */
export const OUTCOMES = ["pr-open", "stuck", "needs-info"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** How a run's pull request ended, for a run that ended because it did. */
export const PR_ENDS = ["merged", "closed"] as const;
export type PrEnd = (typeof PR_ENDS)[number];

/** The label names without their `factory:` prefix. */
export const STATE_NAMES = [
  "proposed",
  "ready",
  "triage",
  "needs-info",
  "building",
  "pr-open",
  "stuck",
] as const;
export type StateName = (typeof STATE_NAMES)[number];

/** What an `error` line was about. */
export const ERROR_KINDS = ["github", "tracker", "t3", "git", "gate", "ledger", "config"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

/** One required check in a `checks_read` line. */
export type CheckRead = { readonly name: string; readonly state: string };

/** The earlier run and branch a launch continued from. */
export type ResumedFrom = { readonly run: string; readonly branch: string };

/**
 * Something that happened in a run, as `{ event, data }`. A field that softfac omits when it is
 * absent is optional here and left out of the line when `undefined`; every other field is
 * written, as `null` when softfac writes `null`. No event holds a token, a comment body or a
 * prompt.
 */
export type RunEvent =
  | { readonly event: "claimed"; readonly data: { machine: string; github_user: string } }
  | {
      readonly event: "triage_result";
      readonly data: { passed: boolean; reasons: ReadonlyArray<string> };
    }
  | { readonly event: "questions_posted"; readonly data: { questions: string } }
  | {
      readonly event: "answer_received";
      readonly data: { comment_id: string | null; body_edited: boolean };
    }
  | {
      readonly event: "session_launched";
      readonly data: {
        thread_id: string;
        worktree: string | null;
        branch: string | null;
        model_instance: string | null;
        model: string | null;
        resumed_from: ResumedFrom | null;
      };
    }
  | { readonly event: "comment_forwarded"; readonly data: { comment_id: string } }
  | {
      readonly event: "session_interrupted";
      readonly data: {
        resumes: number;
        relaunch: boolean;
        run_ordinal: number | null;
        branch: string | null;
        t3_error: string | null;
        ended_in_pass: number;
      };
    }
  | { readonly event: "session_paused"; readonly data: { run_ordinal: number | null } }
  | { readonly event: "stop_requested"; readonly data: { by: string } }
  | { readonly event: "step_changed"; readonly data: { step: string } }
  | { readonly event: "pr_opened"; readonly data: { pr: number; url: string } }
  | {
      readonly event: "pr_adopted";
      readonly data: { pr: number; branch: string; run: string };
    }
  | { readonly event: "branch_bound"; readonly data: { pr: number; branch: string } }
  | { readonly event: "pr_set_draft"; readonly data: { pr: number } }
  | { readonly event: "pr_ready_outside"; readonly data: { pr: number; by?: string } }
  | {
      readonly event: "gate_command";
      readonly data: { attempt: number; command: string; exit_code: number; duration_ms: number };
    }
  | {
      readonly event: "gate_sent_back";
      readonly data: { attempt: number; run_ordinal: number };
    }
  | {
      readonly event: "gate_checkout";
      readonly data: { attempt: number; dir: string; sha: string; base_sha: string };
    }
  | {
      readonly event: "gate_regate";
      readonly data: { sha: string; base_sha: string; previous_base_sha: string };
    }
  | {
      readonly event: "regate_relaunching";
      readonly data: { attempt: number; branch: string; message: string };
    }
  | {
      readonly event: "feedback_relaunching";
      readonly data: { n: number; branch: string; items: ReadonlyArray<string>; message: string };
    }
  | {
      readonly event: "feedback_forwarding";
      readonly data: {
        n: number;
        run_ordinal: number | null;
        items: ReadonlyArray<string>;
        message: string;
      };
    }
  | { readonly event: "gate_cleanup_failed"; readonly data: { dir: string; error: string } }
  | { readonly event: "worktree_removed"; readonly data: { path: string } }
  | { readonly event: "worktree_remove_failed"; readonly data: { path: string; error: string } }
  | {
      readonly event: "checks_read";
      readonly data: { sha: string; checks: ReadonlyArray<CheckRead> };
    }
  | { readonly event: "state_changed"; readonly data: { from: StateName; to: StateName } }
  | {
      readonly event: "stuck";
      readonly data: { reason: string; branch?: string; commits_ahead?: number };
    }
  | {
      readonly event: "error";
      readonly data: { step: CauseStep; kind: ErrorKind; message: string };
    }
  | {
      readonly event: "finished";
      readonly data: {
        outcome: Outcome;
        total_ms: number;
        gate_attempts: number;
        review_cycles: number | null;
        pr_url: string | null;
        pr_end: PrEnd | null;
      };
    };

export type RunEventName = RunEvent["event"];

type RunDataKeys<N extends RunEventName> = keyof Extract<RunEvent, { event: N }>["data"];

/**
 * The 30 event types a run file can hold, each with the names of its `data` fields in the order
 * they are written.
 */
export const RUN_EVENT_FIELDS: Readonly<Record<RunEventName, ReadonlyArray<string>>> = {
  claimed: ["machine", "github_user"],
  triage_result: ["passed", "reasons"],
  questions_posted: ["questions"],
  answer_received: ["comment_id", "body_edited"],
  session_launched: ["thread_id", "worktree", "branch", "model_instance", "model", "resumed_from"],
  comment_forwarded: ["comment_id"],
  session_interrupted: [
    "resumes",
    "relaunch",
    "run_ordinal",
    "branch",
    "t3_error",
    "ended_in_pass",
  ],
  session_paused: ["run_ordinal"],
  stop_requested: ["by"],
  step_changed: ["step"],
  pr_opened: ["pr", "url"],
  pr_adopted: ["pr", "branch", "run"],
  branch_bound: ["pr", "branch"],
  pr_set_draft: ["pr"],
  pr_ready_outside: ["pr", "by"],
  gate_command: ["attempt", "command", "exit_code", "duration_ms"],
  gate_sent_back: ["attempt", "run_ordinal"],
  gate_checkout: ["attempt", "dir", "sha", "base_sha"],
  gate_regate: ["sha", "base_sha", "previous_base_sha"],
  regate_relaunching: ["attempt", "branch", "message"],
  feedback_relaunching: ["n", "branch", "items", "message"],
  feedback_forwarding: ["n", "run_ordinal", "items", "message"],
  gate_cleanup_failed: ["dir", "error"],
  worktree_removed: ["path"],
  worktree_remove_failed: ["path", "error"],
  checks_read: ["sha", "checks"],
  state_changed: ["from", "to"],
  stuck: ["reason", "branch", "commits_ahead"],
  error: ["step", "kind", "message"],
  finished: ["outcome", "total_ms", "gate_attempts", "review_cycles", "pr_url", "pr_end"],
} satisfies { readonly [N in RunEventName]: ReadonlyArray<RunDataKeys<N>> };

const NESTED_FIELDS = {
  resumed_from: ["run", "branch"],
  check: ["name", "state"],
} as const;

const inOrder = (value: unknown, keys: ReadonlyArray<string>): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const given = value as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of keys) if (given[key] !== undefined) ordered[key] = given[key];
  return ordered;
};

/**
 * The `data` object of a line: the event's fields in the order of `fields`, leaving out any that
 * are `undefined` and anything that is not a field. `overrides` replace a field's value in place.
 */
export const buildData = (
  fields: ReadonlyArray<string>,
  data: object,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => {
  const given = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = Object.hasOwn(overrides, field) ? overrides[field] : given[field];
    if (value !== undefined) out[field] = value;
  }
  return out;
};

/**
 * `buildData` for a run event, with the two nested shapes (`resumed_from` and the entries of
 * `checks`) also written in softfac's field order.
 */
export const runEventData = (
  event: RunEvent,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => {
  const out = buildData(RUN_EVENT_FIELDS[event.event], event.data, overrides);
  if (event.event === "session_launched") {
    out.resumed_from = inOrder(out.resumed_from, NESTED_FIELDS.resumed_from);
  } else if (event.event === "checks_read" && Array.isArray(out.checks)) {
    out.checks = out.checks.map((check) => inOrder(check, NESTED_FIELDS.check));
  }
  return out;
};

/**
 * Why a line was written: the part of the factory that wrote it, a reason code from the lists in
 * ledger.md, and, only when they apply, who did something, which gate command, which attempt
 * and which label. None of it is text from a comment, a prompt or a session.
 */
export type Cause = {
  readonly step: CauseStep;
  readonly reason: string;
  readonly actor?: string;
  readonly command?: string;
  readonly attempt?: number;
  readonly label?: string;
};

export type CauseExtras = {
  readonly actor?: string;
  readonly command?: string;
  readonly attempt?: number;
  readonly label?: string;
};

const CAUSE_FIELD_LIMIT = 100;
const CAUSE_COMMAND_LIMIT = 1_000;

/**
 * A character that must not reach a terminal as itself: C0 and C1 controls, DEL, and the bidi
 * controls that can make text read in a different order than it is stored.
 */
const isUnsafeCodePoint = (cp: number) =>
  cp <= 0x1f ||
  (cp >= 0x7f && cp <= 0x9f) ||
  (cp >= 0x202a && cp <= 0x202e) ||
  (cp >= 0x2066 && cp <= 0x2069);

/** `text` on one line with no control or bidi characters, cut at `limit` characters. */
const cleanCauseText = (text: string, limit: number): string => {
  let out = "";
  let count = 0;
  for (const char of text) {
    if (isUnsafeCodePoint(char.codePointAt(0)!)) continue;
    if (count === limit) break;
    out += char;
    count += 1;
  }
  return out;
};

/**
 * A cause. `actor` and `label` are cleaned and cut at 100 characters, and `command` is cleaned
 * and cut at 1000; the keys come in the order step, reason, actor, command, attempt, label, and
 * only when set.
 */
export const makeCause = (step: CauseStep, reason: string, extras: CauseExtras = {}): Cause => ({
  step,
  reason,
  ...(extras.actor !== undefined && { actor: cleanCauseText(extras.actor, CAUSE_FIELD_LIMIT) }),
  ...(extras.command !== undefined && {
    command: cleanCauseText(extras.command, CAUSE_COMMAND_LIMIT),
  }),
  ...(extras.attempt !== undefined && { attempt: extras.attempt }),
  ...(extras.label !== undefined && { label: cleanCauseText(extras.label, CAUSE_FIELD_LIMIT) }),
});

/** The cause as written to a line: the keys in softfac's order, whatever order they were built in. */
export const causeObject = (cause: Cause): Record<string, unknown> =>
  buildData(["step", "reason", "actor", "command", "attempt", "label"], cause);

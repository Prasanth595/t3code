/**
 * The status report: what `softfac status --json` carries, built from the data dir (the run
 * ledgers, the machine log and the pause file) and a few facts the caller has (the loop's status,
 * whether a pass is running now, the open attention items). `GET /api/factory/status` serves it.
 * It writes nothing and reads no network, so it answers when GitHub and T3 do not.
 *
 * Left out, because the fork has nothing for them: softfac's `commit`, `self_update_repo`,
 * `disk`, `claims_paused` (the disk floor), `t3_env_holds` and `t3_logs`. `attention` is the
 * fork's own.
 */
import type { AttentionItem } from "./attention.ts";
import { loadHandPause } from "./claims.ts";
import { scanMachineLog, type MachineEntry } from "./ledger/machineLog.ts";
import { holdsSlot, listUnfinishedRuns, readRuns, type RunRead } from "./ledger/listRuns.ts";
import { asciiLower, runIdToString } from "./ledger/runId.ts";
import { formatTs } from "./ledger/time.ts";

/** The settings of the machine config the status report shows. */
export interface StatusSettings {
  readonly pollSeconds: number;
  readonly maxConcurrentRuns: number;
  /** The `repo` of every watched repo, `owner/name`. */
  readonly repos: ReadonlyArray<string>;
}

/**
 * What the factory is doing: running, or idle for a reason (no config, or one it cannot read).
 * `running` means the pass loop started; it says nothing about whether passes succeed, which the
 * server log records. The reason names no path and no error, as every reading client gets it;
 * the log has the detail.
 */
export type FactoryStatus =
  | { readonly state: "running"; readonly settings: StatusSettings }
  | { readonly state: "idle"; readonly reason: string };

export interface StatusReport {
  readonly state: "running" | "idle";
  /** Why the factory is idle; null when it is running. */
  readonly reason: string | null;
  /** The version of the server. */
  readonly version: string;
  readonly machine_config: string;
  readonly machine: string;
  readonly data_dir: string;
  readonly passes: {
    /** When the last pass ended, or failed its checks. */
    readonly at: string | null;
    readonly ago_ms: number | null;
    readonly result: "ok" | "preflight_failed" | null;
    /** For a failed preflight, `<check>: <why>`. */
    readonly reason: string | null;
    readonly poll_seconds: number | null;
    /** A pass is running now. */
    readonly running: boolean;
    /** How long the running pass has been running, when the machine log says when it began. */
    readonly running_for_ms: number | null;
    readonly stale: boolean;
  };
  readonly slots: { readonly used: number; readonly max: number | null };
  /** Claims held back by a person, or null. */
  readonly paused_by_hand: { readonly since: string; readonly for_ms: number } | null;
  /** The runs that are not finished, oldest first. */
  readonly runs: ReadonlyArray<{
    readonly id: string;
    readonly state: string | null;
    /** The GitHub user the run was claimed as, from its `claimed` line. */
    readonly user: string | null;
    readonly for_ms: number | null;
    readonly pr_url: string | null;
    readonly thread_id: string | null;
    readonly unreadable: boolean;
  }>;
  /** The unfinished runs, also in `runs`, whose repo is not in the machine config. */
  readonly left_out: ReadonlyArray<{
    readonly id: string;
    readonly state: string;
    readonly pr_url: string | null;
  }>;
  readonly problems: ReadonlyArray<{
    readonly at: string;
    readonly event: "error" | "attention";
    readonly run: string | null;
    readonly step: string | null;
    readonly kind: string | null;
    readonly reason: string | null;
    readonly message: string | null;
  }>;
  /** What the factory needs a person for, from the open attention items. */
  readonly attention: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly repo: string | null;
    readonly issue: number | null;
    readonly run: string | null;
    readonly message: string;
    readonly first_seen: string;
  }>;
}

/** How far back a problem still counts as recent. */
const PROBLEM_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The most problems the report lists. */
const PROBLEM_LIMIT = 10;
/** The last pass is stale when it is older than this many polls. */
const STALE_POLLS = 3;

const recent = (ms: number, nowMs: number) => ms + PROBLEM_WINDOW_MS >= nowMs;

const field = (data: unknown, key: string): unknown =>
  typeof data === "object" && data !== null ? (data as Record<string, unknown>)[key] : undefined;

/** The string at `key` of an entry's data, or null when it is not a string. */
const text = (data: unknown, key: string): string | null => {
  const value = field(data, key);
  return typeof value === "string" ? value : null;
};

type Problem = StatusReport["problems"][number] & { readonly ms: number };

const machineProblem = (entry: MachineEntry): Problem => ({
  at: formatTs(entry.ms),
  event: entry.event === "error" ? "error" : "attention",
  run: text(entry.data, "run"),
  step: text(entry.data, "step"),
  kind: text(entry.data, "kind"),
  reason: text(entry.data, "reason"),
  message: text(entry.data, "message"),
  ms: entry.ms,
});

const passesOf = (
  log: ReadonlyArray<MachineEntry>,
  settings: StatusSettings | null,
  running: boolean,
  nowMs: number,
): StatusReport["passes"] => {
  let last: MachineEntry | null = null;
  let lastStart: number | null = null;
  for (const entry of log) {
    if (entry.event === "pass_started") lastStart = entry.ms;
    if (entry.event === "pass_finished" || entry.event === "preflight_failed") last = entry;
  }
  const pollSeconds = settings === null ? null : settings.pollSeconds;
  // The running pass began after the last one ended, so a start that `last` came after is not it.
  const runningForMs =
    running && lastStart !== null && (last === null || lastStart > last.ms)
      ? Math.max(0, nowMs - lastStart)
      : null;
  if (last === null) {
    return {
      at: null,
      ago_ms: null,
      result: null,
      reason: null,
      poll_seconds: pollSeconds,
      running,
      running_for_ms: runningForMs,
      stale: false,
    };
  }
  const ago = Math.max(0, nowMs - last.ms);
  const ok = last.event === "pass_finished";
  return {
    at: formatTs(last.ms),
    ago_ms: ago,
    result: ok ? "ok" : "preflight_failed",
    reason: ok ? null : `${text(last.data, "check") ?? ""}: ${text(last.data, "why") ?? ""}`,
    poll_seconds: pollSeconds,
    running,
    running_for_ms: runningForMs,
    stale: settings !== null && !running && ago > STALE_POLLS * settings.pollSeconds * 1000,
  };
};

const runRow = (read: RunRead, nowMs: number): StatusReport["runs"][number] => {
  const { summary } = read;
  const entries = read.record?.entries ?? [];
  const lastChange = entries.findLast((entry) => entry.event === "state_changed");
  const launch = entries.findLast((entry) => entry.event === "session_launched");
  const claim = entries.find((entry) => entry.event === "claimed");
  return {
    id: runIdToString(summary.id),
    state: summary.state,
    user: claim === undefined ? null : text(claim.data, "github_user"),
    for_ms: lastChange === undefined ? null : Math.max(0, nowMs - lastChange.ms),
    pr_url: summary.prUrl,
    thread_id: launch === undefined ? null : text(launch.data, "thread_id"),
    unreadable: summary.unreadable,
  };
};

/**
 * Reads the data dir into a report as of `nowMs`. `dataDir` is the factory dir; a missing one
 * reads as an empty one. Throws the ledger's errors like the other ledger reads (a machine log
 * that is a symlink, a runs directory that cannot be listed), so call it through `ledgerCall`.
 * Writes nothing.
 */
export const buildStatus = (input: {
  readonly status: FactoryStatus;
  readonly version: string;
  readonly machine: string;
  readonly machineConfigPath: string;
  readonly dataDir: string;
  readonly nowMs: number;
  /** A pass is running now (the loop's `passRunning`). */
  readonly passRunning: boolean;
  readonly attention: ReadonlyArray<AttentionItem>;
}): StatusReport => {
  const { dataDir, nowMs } = input;
  const settings = input.status.state === "running" ? input.status.settings : null;
  const log = scanMachineLog(dataDir);
  const reads = readRuns(dataDir);
  const open = reads.filter((read) => !read.summary.finished);

  // The one place the port follows the fork's pass, not softfac's `holds_slot`: a run counts as
  // the pass counts it, so an unconfirmed run and one whose pull request is reported hold none.
  const used = listUnfinishedRuns(dataDir).filter(holdsSlot).length;

  // Oldest first: the machine log, then the runs. Reversed and stably sorted by time, a later
  // line comes before an earlier one of the same time.
  const problems: Array<Problem> = [];
  for (const entry of log) {
    if ((entry.event === "error" || entry.event === "attention") && recent(entry.ms, nowMs)) {
      problems.push(machineProblem(entry));
    }
  }
  for (const read of reads) {
    for (const entry of read.record?.entries ?? []) {
      if (entry.event !== "error" || !recent(entry.ms, nowMs)) continue;
      problems.push({
        at: formatTs(entry.ms),
        event: "error",
        run: runIdToString(read.summary.id),
        step: text(entry.data, "step"),
        kind: text(entry.data, "kind"),
        reason: null,
        message: text(entry.data, "message"),
        ms: entry.ms,
      });
    }
  }
  problems.reverse();
  problems.sort((a, b) => b.ms - a.ms);

  const watched = settings === null ? null : settings.repos.map(asciiLower);
  const pause = loadHandPause(dataDir);
  return {
    state: input.status.state,
    reason: input.status.state === "idle" ? input.status.reason : null,
    version: input.version,
    machine_config: input.machineConfigPath,
    machine: input.machine,
    data_dir: dataDir,
    passes: passesOf(log, settings, input.passRunning, nowMs),
    slots: { used, max: settings === null ? null : settings.maxConcurrentRuns },
    paused_by_hand:
      pause === null
        ? null
        : { since: formatTs(pause.sinceMs), for_ms: Math.max(0, nowMs - pause.sinceMs) },
    runs: open.map((read) => runRow(read, nowMs)),
    left_out:
      watched === null
        ? []
        : open
            .filter((read) => !watched.includes(asciiLower(read.summary.id.repo)))
            .map((read) => ({
              id: runIdToString(read.summary.id),
              state: read.summary.unreadable ? "unreadable" : (read.summary.state ?? "starting"),
              pr_url: read.summary.prUrl,
            })),
    problems: problems.slice(0, PROBLEM_LIMIT).map((problem) => ({
      at: problem.at,
      event: problem.event,
      run: problem.run,
      step: problem.step,
      kind: problem.kind,
      reason: problem.reason,
      message: problem.message,
    })),
    attention: input.attention.map((item) => ({
      id: item.id,
      kind: item.kind,
      repo: item.repo,
      issue: item.issue,
      run: item.run,
      message: item.message,
      first_seen: formatTs(item.firstSeenMs),
    })),
  };
};

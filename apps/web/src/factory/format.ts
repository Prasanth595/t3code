import { formatElapsedDurationLabel } from "../timestampFormat";
import type { FactoryEntry } from "./api";

export interface ParsedRunId {
  readonly owner: string;
  readonly repo: string;
  readonly issue: string;
  readonly attempt: number;
}

/**
 * `<owner>__<repo>__<issue>__<attempt>`; null for anything else. Read the way the server reads it:
 * the owner ends at the first `__`, the attempt and issue come from the right, and the rest is the
 * repo, which may hold `__`.
 */
export function parseRunId(id: string): ParsedRunId | null {
  const first = id.indexOf("__");
  if (first === -1) return null;
  const owner = id.slice(0, first);
  const afterOwner = id.slice(first + 2);
  const lastA = afterOwner.lastIndexOf("__");
  if (lastA === -1) return null;
  const attemptText = afterOwner.slice(lastA + 2);
  const beforeAttempt = afterOwner.slice(0, lastA);
  const lastB = beforeAttempt.lastIndexOf("__");
  if (lastB === -1) return null;
  const repo = beforeAttempt.slice(0, lastB);
  const issue = beforeAttempt.slice(lastB + 2);
  if (!/^[0-9]+$/.test(attemptText) || !owner || !repo || !issue) return null;
  return { owner, repo, issue, attempt: Number(attemptText) };
}

/** An error's message, or the value as text, for a notice. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The string at `key` of an object, null for anything else. */
export const textField = (data: unknown, key: string): string | null => {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
};

const numberField = (data: unknown, key: string): number | null => {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
};

/**
 * The runs the list shows before "Show all": every unfinished run, and the first `limit` finished
 * ones in the order given (newest first), so the active runs never fall out of the window.
 */
export function recentWindow<T extends { readonly finished: boolean }>(
  runs: ReadonlyArray<T>,
  limit: number,
): Array<T> {
  let finished = 0;
  return runs.filter((run) => !run.finished || finished++ < limit);
}

/** The `step` of the last `step_changed` entry that has one. */
export function currentStep(entries: ReadonlyArray<FactoryEntry>): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.event !== "step_changed") continue;
    const step = textField(entry.data, "step");
    if (step !== null) return step;
  }
  return null;
}

/** The `thread_id` of the last `session_launched` entry that has one. */
export function threadIdOf(entries: ReadonlyArray<FactoryEntry>): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.event !== "session_launched") continue;
    const id = textField(entry.data, "thread_id");
    if (id !== null) return id;
  }
  return null;
}

export interface GateCommand {
  readonly command: string;
  readonly exit_code: number;
  readonly duration_ms: number;
}

export interface GateOutput {
  readonly attempt: number | null;
  readonly commands: ReadonlyArray<GateCommand>;
  /** What was last sent to the session: untrusted text, show it as text only. */
  readonly message: string | null;
  readonly stuckReason: string | null;
}

const MESSAGE_EVENTS = new Set([
  "regate_relaunching",
  "feedback_relaunching",
  "feedback_forwarding",
]);

/**
 * What a ledger holds of the last gate: the commands of the highest attempt, the message of the
 * last relaunch or forward after that attempt's last command, and the reason of the last `stuck` entry when it names the gate.
 */
export function lastGateOutput(entries: ReadonlyArray<FactoryEntry>): GateOutput {
  let attempt: number | null = null;
  for (const entry of entries) {
    if (entry.event !== "gate_command") continue;
    const n = numberField(entry.data, "attempt");
    if (n !== null && (attempt === null || n > attempt)) attempt = n;
  }
  // The index of the last command of that attempt: a message counts only after it, as the answer
  // to that attempt's failure. One before it was about an earlier attempt.
  let lastCommandAt = -1;
  entries.forEach((entry, index) => {
    if (entry.event === "gate_command" && numberField(entry.data, "attempt") === attempt) {
      lastCommandAt = index;
    }
  });
  const commands: Array<GateCommand> = [];
  let message: string | null = null;
  let stuckReason: string | null = null;
  for (const [index, entry] of entries.entries()) {
    if (entry.event === "gate_command" && numberField(entry.data, "attempt") === attempt) {
      const command = textField(entry.data, "command");
      const exit = numberField(entry.data, "exit_code");
      const duration = numberField(entry.data, "duration_ms");
      if (command !== null && exit !== null && duration !== null) {
        commands.push({ command, exit_code: exit, duration_ms: duration });
      }
    } else if (MESSAGE_EVENTS.has(entry.event) && index > lastCommandAt) {
      message = textField(entry.data, "message") ?? message;
    } else if (entry.event === "stuck") {
      const reason = textField(entry.data, "reason");
      stuckReason = reason !== null && /gate/i.test(reason) ? reason : null;
    }
  }
  return { attempt, commands, message, stuckReason };
}

/** The time since `sinceMs` (Unix epoch ms) as `5m`; a dash when it is not a time. */
export function formatAge(sinceMs: number, nowMs: number): string {
  if (!Number.isFinite(sinceMs)) return "—";
  return formatElapsedDurationLabel(new Date(sinceMs).toISOString(), nowMs);
}

export function labelForState(state: string | null): string {
  return state ?? "unknown";
}

export type StateBadgeVariant = "info" | "success" | "error" | "warning" | "secondary";

export function stateBadgeVariant(state: string | null): StateBadgeVariant {
  switch (state) {
    case "building":
      return "info";
    case "pr-open":
      return "success";
    case "stuck":
      return "error";
    case "needs-info":
      return "warning";
    default:
      return "secondary";
  }
}

/** The `to` of the last `state_changed` entry. */
export function runState(entries: ReadonlyArray<FactoryEntry>): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.event !== "state_changed") continue;
    const to = textField(entry.data, "to");
    if (to !== null) return to;
  }
  return null;
}

/** A `finished` entry is written: the run is over whatever its last state says. */
export function runIsFinished(entries: ReadonlyArray<FactoryEntry>): boolean {
  return entries.some((entry) => entry.event === "finished");
}

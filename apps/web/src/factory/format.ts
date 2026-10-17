import { formatElapsedDurationLabel } from "../timestampFormat";
import type { FactoryEntry } from "./api";

export interface ParsedRunId {
  readonly owner: string;
  readonly repo: string;
  readonly issue: string;
  readonly attempt: number;
}

/** `<owner>__<repo>__<issue>__<attempt>`; null for anything else. The repo may hold `__`. */
export function parseRunId(id: string): ParsedRunId | null {
  const parts = id.split("__");
  if (parts.length < 4) return null;
  const attemptText = parts[parts.length - 1]!;
  const issue = parts[parts.length - 2]!;
  const owner = parts[0]!;
  const repo = parts.slice(1, -2).join("__");
  if (!/^[0-9]+$/.test(attemptText) || !owner || !repo || !issue) return null;
  return { owner, repo, issue, attempt: Number(attemptText) };
}

const textField = (data: unknown, key: string): string | null => {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
};

const numberField = (data: unknown, key: string): number | null => {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
};

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
 * last relaunch or forward, and the reason of the last `stuck` entry when it names the gate.
 */
export function lastGateOutput(entries: ReadonlyArray<FactoryEntry>): GateOutput {
  let attempt: number | null = null;
  for (const entry of entries) {
    if (entry.event !== "gate_command") continue;
    const n = numberField(entry.data, "attempt");
    if (n !== null && (attempt === null || n > attempt)) attempt = n;
  }
  const commands: Array<GateCommand> = [];
  let message: string | null = null;
  let stuckReason: string | null = null;
  for (const entry of entries) {
    if (entry.event === "gate_command" && numberField(entry.data, "attempt") === attempt) {
      const command = textField(entry.data, "command");
      const exit = numberField(entry.data, "exit_code");
      const duration = numberField(entry.data, "duration_ms");
      if (command !== null && exit !== null && duration !== null) {
        commands.push({ command, exit_code: exit, duration_ms: duration });
      }
    } else if (MESSAGE_EVENTS.has(entry.event)) {
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

import { workLogEntryIsToolLike, workEntryDisplayIndicatesToolFailure } from "../../session-logic";
import type { WorkLogEntry } from "../../session-logic";
import * as DateTime from "effect/DateTime";

export type ToolCallState = "running" | "done" | "failed" | "stopped" | "none";

function entryItem(entry: WorkLogEntry) {
  return entry.projectedItem?.item ?? entry.structuredPayload;
}

function epochMillis(value: DateTime.Utc | null | undefined) {
  return value ? DateTime.toEpochMillis(value) : null;
}

/** Wall time of one finished call, or null while it runs or when the provider sent no times. */
export function toolCallDurationMs(entry: WorkLogEntry): number | null {
  const item = entryItem(entry);
  const start = epochMillis(item?.startedAt);
  const end = epochMillis(item?.completedAt);
  return start !== null && end !== null ? Math.max(0, end - start) : null;
}

/** When a call started, for the running timer. Falls back to when the row was created. */
export function toolCallStartedAt(entry: WorkLogEntry): string {
  const startedAt = entryItem(entry)?.startedAt;
  return startedAt ? DateTime.formatIso(startedAt) : entry.createdAt;
}

/** `live` is true only for entries in the run that is still working. */
export function toolCallState(entry: WorkLogEntry, live: boolean): ToolCallState {
  if (!workLogEntryIsToolLike(entry) || entry.itemType === "reasoning") return "none";
  if (workEntryDisplayIndicatesToolFailure(entry)) return "failed";
  // An unfinished call outside the working run was interrupted; it must not read as done.
  if (entry.toolLifecycleStatus === "inProgress" || entry.toolLifecycleStatus === "stopped") {
    return live && entry.toolLifecycleStatus === "inProgress" ? "running" : "stopped";
  }
  return "done";
}

/** Short result note for the row, such as a failed command's exit code. */
export function toolCallResultNote(entry: WorkLogEntry): string | null {
  const item = entryItem(entry);
  if (item?.type === "command_execution" && item.exitCode !== undefined && item.exitCode !== 0) {
    return `exit ${item.exitCode}`;
  }
  return null;
}

export interface ToolGroupStats {
  toolCount: number;
  failedCount: number;
  /** From the first call's start to the last call's end. */
  durationMs: number | null;
}

export function toolGroupStats(entries: ReadonlyArray<WorkLogEntry>): ToolGroupStats {
  let toolCount = 0;
  let failedCount = 0;
  let start = Infinity;
  let end = -Infinity;
  for (const entry of entries) {
    if (!workLogEntryIsToolLike(entry) || entry.itemType === "reasoning") continue;
    toolCount += 1;
    if (workEntryDisplayIndicatesToolFailure(entry)) failedCount += 1;
    const item = entryItem(entry);
    const itemStart = epochMillis(item?.startedAt);
    const itemEnd = epochMillis(item?.completedAt);
    if (itemStart !== null) start = Math.min(start, itemStart);
    if (itemEnd !== null) end = Math.max(end, itemEnd);
  }
  return {
    toolCount,
    failedCount,
    durationMs: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null,
  };
}

/** Newest entries for the live card's tail, oldest first. */
export function liveToolCardTail<T>(entries: ReadonlyArray<T>, limit: number): ReadonlyArray<T> {
  return entries.length > limit ? entries.slice(-limit) : entries;
}

const LEADING_CD = /^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/;

/** Drops a leading `cd <dir> &&` or `cd <dir>;` so the row shows the command that did the work. */
export function withoutLeadingCd(command: string): string {
  const rest = command.replace(LEADING_CD, "");
  return rest.trim().length > 0 ? rest : command;
}

/** Shows paths inside the workspace as relative, so a row shows what the command touched. */
export function withoutWorkspaceRoot(command: string, workspaceRoot: string | undefined): string {
  const root = workspaceRoot?.replace(/\/+$/, "");
  if (!root) return command;
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return command
    .replaceAll(`${root}/`, "")
    .replace(new RegExp(`${escaped}(?=$|[\\s'";&|)])`, "g"), ".");
}

import { CheckIcon, CircleDashedIcon, MinusIcon, XIcon } from "lucide-react";
import { use } from "react";
import { formatDuration, type WorkLogEntry } from "../../session-logic";
import { cn } from "~/lib/utils";
import { tickTextContent } from "~/lib/tickTextContent";
import { TimelineRowActivityCtx, TimelineRowCtx } from "./timelineRowContext";
import { TimelineRowTimestamp } from "./TimelineRowParts";
import { formatWorkingTimerNow } from "./TimelineWorkGroupRows.logic";
import {
  toolCallDurationMs,
  toolCallResultNote,
  toolCallStartedAt,
  toolCallState,
  type ToolCallState,
} from "./ToolCallCard.logic";

/** A call's state in the timeline; only calls in the run that is working now can be running. */
export function useToolCallState(entry: WorkLogEntry): ToolCallState {
  const { isWorking, latestRunId } = use(TimelineRowActivityCtx);
  return toolCallState(entry, isWorking && entry.runId != null && entry.runId === latestRunId);
}

function StatusGlyph({ state }: { state: ToolCallState }) {
  if (state === "done") {
    return (
      <CheckIcon
        className="size-3.5 shrink-0 text-success-foreground"
        strokeWidth={2.5}
        aria-hidden
      />
    );
  }
  if (state === "failed") {
    return <XIcon className="size-3.5 shrink-0 text-destructive-foreground" aria-hidden />;
  }
  if (state === "stopped") {
    return <MinusIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
  }
  return <CircleDashedIcon className="size-3.5 shrink-0 text-foreground/80" aria-hidden />;
}

/** Trailing result note, duration, and status for one call. Running calls tick their elapsed time. */
export function ToolCallMeta({ entry, state }: { entry: WorkLogEntry; state: ToolCallState }) {
  const { timestampFormat } = use(TimelineRowCtx);
  if (state === "none") {
    return <TimelineRowTimestamp createdAt={entry.createdAt} timestampFormat={timestampFormat} />;
  }
  const durationMs = state === "done" || state === "failed" ? toolCallDurationMs(entry) : null;
  const note = state === "failed" ? toolCallResultNote(entry) : null;
  const startedAt = toolCallStartedAt(entry);
  return (
    <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
      <TimelineRowTimestamp
        createdAt={entry.createdAt}
        timestampFormat={timestampFormat}
        className={cn((note || durationMs !== null) && "after:ms-2 after:content-['·']")}
      />
      {note ? <span className="text-destructive-foreground">{note}</span> : null}
      {state === "running" ? (
        <span
          ref={tickTextContent(() => formatWorkingTimerNow(startedAt), true)}
          className="text-foreground/80"
        />
      ) : durationMs !== null ? (
        <span>{formatDuration(durationMs)}</span>
      ) : null}
      <StatusGlyph state={state} />
      <span className="sr-only">{state === "done" ? "completed" : state}</span>
    </span>
  );
}

import { PauseIcon, PlayIcon, TargetIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button, InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerGoalBarModel } from "./presentComposerGoalBar";

/** The thread's goal, sitting on the top edge of the composer above the message field. */
export function ComposerGoalBar({
  model,
  canOperate,
  onSendCommand,
}: {
  readonly model: ComposerGoalBarModel;
  readonly canOperate: boolean;
  readonly onSendCommand: (text: string, failureMessage: string) => Promise<void>;
}) {
  const emphasized = model.emphasizing !== null;
  const showClear = model.emphasizing !== "clear";
  const playbackLabel = model.playback === "pause" ? "Pause goal" : "Resume goal";
  const label =
    model.usage === null
      ? `${model.title}. ${model.objective}`
      : `${model.title}. ${model.objective}. ${model.usage}`;
  return (
    <div
      role="status"
      data-chat-composer-goal=""
      data-goal-emphasis={model.emphasizing ?? "resting"}
      aria-label={label}
      className={cn(
        "flex min-w-0 items-center gap-2 border-b px-3 py-1.5 text-xs",
        emphasized ? "border-primary/25 bg-primary/10" : "border-border/70",
      )}
    >
      <TargetIcon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0",
          emphasized ? "text-foreground" : "text-muted-foreground",
        )}
      />
      <span className="shrink-0 font-medium text-foreground">{model.title}</span>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-left",
                emphasized ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {model.objective}
            </span>
          }
        />
        <TooltipPopup side="top">{model.objective}</TooltipPopup>
      </Tooltip>
      {model.usage === null ? null : (
        <span className="shrink-0 tabular-nums text-muted-foreground">{model.usage}</span>
      )}
      {model.playback !== null || showClear ? (
        <span className="flex shrink-0 items-center gap-1">
          {model.playback === null ? null : (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              disabled={!canOperate}
              aria-label={playbackLabel}
              onClick={() =>
                void onSendCommand(
                  model.playback === "pause" ? "/goal pause" : "/goal resume",
                  model.playback === "pause" ? "Failed to pause goal." : "Failed to resume goal.",
                )
              }
            >
              {model.playback === "pause" ? <PauseIcon /> : <PlayIcon />}
            </Button>
          )}
          {showClear ? (
            <InlineButton
              tone="muted"
              disabled={!canOperate}
              onClick={() => void onSendCommand("/goal clear", "Failed to clear goal.")}
            >
              Clear
            </InlineButton>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

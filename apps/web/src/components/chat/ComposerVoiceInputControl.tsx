import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, MicIcon, XIcon } from "lucide-react";
import { useEffect, useState, type PointerEvent } from "react";

import type { useComposerVoiceInput } from "~/voiceInput/useComposerVoiceInput";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type ComposerVoiceInput = ReturnType<typeof useComposerVoiceInput>;

const keepEditorFocus = (event: PointerEvent<HTMLElement>) => event.preventDefault();

function formatElapsed(totalSeconds: number): string {
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function RecordingElapsed({ startedAt }: { readonly startedAt: number }) {
  const [now, setNow] = useState(startedAt);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ticks the recording clock once a second while recording
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, []);
  return (
    <span className="tabular-nums" aria-hidden="true">
      {formatElapsed(Math.max(0, Math.floor((now - startedAt) / 1_000)))}
    </span>
  );
}

function IconAction(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onPointerDown={keepEditorFocus}
            onClick={props.onClick}
            aria-label={props.label}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** The footer mic, or the status and controls of an active dictation. */
export function ComposerVoiceInputControl({
  voiceInput,
  disabledReason,
}: {
  readonly voiceInput: ComposerVoiceInput;
  readonly disabledReason: string | null;
}) {
  const { state } = voiceInput;
  if (state.phase === "idle" || state.phase === "error") {
    if (!voiceInput.visible) return null;
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onPointerDown={keepEditorFocus}
            onClick={voiceInput.start}
            disabled={disabledReason !== null}
            aria-label={state.phase === "error" ? "Retry voice input" : "Start voice input"}
          >
            <MicIcon />
          </Button>
        </TooltipTrigger>
        <TooltipPopup>
          {disabledReason ?? (
            <>
              <div>Voice input</div>
              <div className="text-muted-foreground">
                Transcribed on this device. The first use downloads a 45 MB speech model.
              </div>
            </>
          )}
        </TooltipPopup>
      </Tooltip>
    );
  }

  const statusLabel =
    state.phase === "preparing"
      ? voiceInput.loadingPercent === null
        ? "Loading voice model"
        : `Loading voice model ${voiceInput.loadingPercent}%`
      : state.phase === "recording"
        ? "Recording"
        : "Transcribing";
  return (
    <div className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs">
      {state.phase === "recording" ? (
        <span className="size-2 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
      ) : (
        <Spinner size="sm" tone="muted" aria-hidden="true" />
      )}
      <span role="status" className="truncate">
        {statusLabel}
      </span>
      {state.phase === "recording" && voiceInput.recordingStartedAt !== null ? (
        <RecordingElapsed startedAt={voiceInput.recordingStartedAt} />
      ) : null}
      {state.phase === "recording" ? (
        <IconAction label="Stop and insert transcript" onClick={voiceInput.stop}>
          <CheckIcon />
        </IconAction>
      ) : null}
      <IconAction label="Cancel voice input" onClick={voiceInput.cancel}>
        <XIcon />
      </IconAction>
    </div>
  );
}

export function ComposerVoiceInputError({
  voiceInput,
}: {
  readonly voiceInput: ComposerVoiceInput;
}) {
  const navigate = useNavigate();
  const { state } = voiceInput;
  if (state.phase !== "error" || state.error === null) return null;
  return (
    <div
      role="alert"
      className="flex items-center gap-2 px-3 pb-2 text-destructive text-xs sm:px-4"
    >
      <p className="min-w-0">{state.error}</p>
      {state.errorAction === "settings" ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            voiceInput.cancel();
            void navigate({ to: "/settings/chat", hash: "voice-input-microphone" });
          }}
        >
          Settings
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onPointerDown={keepEditorFocus}
        onClick={voiceInput.cancel}
        aria-label="Dismiss voice input error"
      >
        <XIcon />
      </Button>
    </div>
  );
}

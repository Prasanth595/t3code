import {
  VoiceInputController,
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { MicIcon, SquareIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { createBrowserVoiceCapture, transcodeRecordingToPcm16 } from "../../voiceInput";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** A press held at least this long is hold-to-talk: releasing it stops recording. */
const HOLD_TO_TALK_MS = 400;

const IDLE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

function isPlainComposerKey(event: KeyboardEvent): boolean {
  return (
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.isComposing &&
    document.activeElement?.getAttribute("data-testid") === "composer-editor"
  );
}

export type ComposerVoiceDraft = { readonly text: string; readonly cursor: number };

/**
 * Dictation into the composer, transcribed by the environment's Claude login
 * the way Claude Code's voice mode does. Hold Space in the composer or hold
 * the button and release to finish, or tap the button to start and stop.
 */
export function ComposerVoiceInputControl(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly ownerKey: string;
  readonly readDraft: () => ComposerVoiceDraft | null;
  readonly commitDraft: (text: string, cursor: number) => void;
}) {
  const transcribe = useAtomCommand(serverEnvironment.transcribeAudio, { reportFailure: false });
  const [state, setState] = useState<VoiceInputState>(IDLE);
  const latest = useRef({ ...props, transcribe });
  useLayoutEffect(() => {
    latest.current = { ...props, transcribe };
  });
  const [voice] = useState(() => {
    const capture = createBrowserVoiceCapture((uri) => {
      void controller.handleRecorderStatus({
        isFinished: true,
        hasError: false,
        error: null,
        url: uri,
      });
    });
    let failureDetail: string | null = null;
    const controller: VoiceInputController = new VoiceInputController({
      recorder: capture.recorder,
      requestPermission: capture.requestPermission,
      configureRecording: async () => {},
      releaseRecording: capture.release,
      deleteRecording: capture.deleteRecording,
      readDraft: () => {
        const draft = latest.current.readDraft();
        if (!draft) return null;
        const selection = { start: draft.cursor, end: draft.cursor };
        return { ownerKey: latest.current.ownerKey, text: draft.text, selection, revision: 0 };
      },
      commitDraft: (text, selection) => latest.current.commitDraft(text, selection.start),
      getTranscriber: () => ({
        prepare: async () => ({
          locale: navigator.language,
          transcribe: async (uri, { signal }) => {
            const { environmentId, instanceId, transcribe } = latest.current;
            const recording = capture.takeRecording(uri);
            if (!recording) {
              throw new VoiceTranscriptionError("transcription-failed", "Recording missing.");
            }
            const audio = await transcodeRecordingToPcm16(recording);
            throwIfVoiceTranscriptionAborted(signal);
            const result = await transcribe({
              environmentId,
              input: { instanceId, audio, language: navigator.language },
            });
            if (result._tag === "Success") return result.value.text;
            failureDetail =
              "error" in result.cause && result.cause.error instanceof Error
                ? result.cause.error.message
                : null;
            throw new VoiceTranscriptionError("transcription-failed", failureDetail ?? "Failed.");
          },
        }),
      }),
      onStateChange: (next) => {
        // An error reads as idle here; the next press starts over.
        if (next.phase === "error" && next.error) {
          toastManager.add({
            type: "error",
            title: next.error,
            ...(failureDetail ? { description: failureDetail } : {}),
          });
          failureDetail = null;
        }
        setState(next);
      },
    });
    return controller;
  });

  useEffect(() => voice.ownerChanged(), [props.ownerKey, voice]);
  useEffect(() => () => voice.dispose(), [voice]);

  // A button press starts or stops dictation, and releasing a long press
  // stops the recording it started.
  const pressStartedAt = useRef<number | null>(null);
  const press = () => {
    const phase = voice.currentState.phase;
    if (phase === "recording") {
      pressStartedAt.current = null;
      void voice.stop();
    } else if (phase === "idle" || phase === "error") {
      pressStartedAt.current = performance.now();
      void voice.start();
    }
  };
  const release = () => {
    const startedAt = pressStartedAt.current;
    pressStartedAt.current = null;
    // A release while still preparing, such as during the first permission
    // prompt, leaves the recording running until the next press.
    if (startedAt === null || performance.now() - startedAt < HOLD_TO_TALK_MS) return;
    if (voice.currentState.phase === "recording") void voice.stop();
  };

  // Claude Code's hold-to-talk: a tap on Space types a space as usual. Once the
  // key repeats it is being held, so the space it typed is taken back and
  // recording runs until Space is released.
  useEffect(() => {
    let holding = false;
    const finishHold = () => {
      holding = false;
      if (voice.currentState.phase === "recording") void voice.stop();
      // Released before recording began, e.g. during the first permission prompt.
      else if (voice.currentState.phase === "preparing") voice.cancel();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      if (holding) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!event.repeat || !isPlainComposerKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const phase = voice.currentState.phase;
      if (phase !== "idle" && phase !== "error") return;
      holding = true;
      const draft = latest.current.readDraft();
      if (draft && draft.text[draft.cursor - 1] === " ") {
        latest.current.commitDraft(
          draft.text.slice(0, draft.cursor - 1) + draft.text.slice(draft.cursor),
          draft.cursor - 1,
        );
      }
      void voice.start();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!holding || event.code !== "Space") return;
      event.preventDefault();
      finishHold();
    };
    // Switching windows mid-hold swallows the keyup.
    const onBlur = () => {
      if (holding) finishHold();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [voice]);

  const recording = state.phase === "recording";
  const busy = state.phase === "preparing" || state.phase === "transcribing";
  const label = recording ? "Stop voice input" : busy ? "Transcribing…" : "Voice input";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant={recording ? "ghost-destructive" : "ghost"}
            size="icon-sm"
            aria-label={label}
            aria-pressed={recording}
            disabled={state.phase === "transcribing"}
            onPointerDown={(event) => {
              // Keep focus and the caret in the editor while dictating.
              event.preventDefault();
              if (event.button === 0) press();
            }}
            onPointerUp={release}
            onPointerCancel={release}
            onClick={(event) => {
              // Keyboard activation has no pointer press.
              if (event.detail === 0) press();
            }}
          />
        }
      >
        {busy ? <Spinner /> : recording ? <SquareIcon /> : <MicIcon />}
      </TooltipTrigger>
      <TooltipPopup>
        {recording ? "Release or click to finish" : busy ? label : "Voice input (hold Space)"}
      </TooltipPopup>
    </Tooltip>
  );
}

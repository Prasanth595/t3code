import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { CheckIcon, MicIcon, XIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { isWebVoiceRecordingSupported, WebVoiceRecorder } from "~/lib/webVoiceRecorder";
import { serverEnvironment } from "~/state/server";
import { createWebVoiceTranscriber } from "~/state/voiceInput";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const WAVEFORM_BARS = 20;
const SAMPLE_INTERVAL_MS = 80;

type VoiceDraft = {
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
};

export function useComposerVoiceInput(input: {
  readonly environmentId: EnvironmentId;
  readonly ownerKey: string;
  readonly readDraft: () => VoiceDraft | null;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
}) {
  const environmentSettings = useAtomValue(
    serverEnvironment.settingsValueAtom(input.environmentId),
  );
  // Clients receive the key redacted, so a non-empty value only says one is saved.
  const isConfigured = (environmentSettings?.voiceTranscriptionOpenAiApiKey ?? "") !== "";
  const [state, setState] = useState<VoiceInputState>(IDLE_STATE);
  const readDraft = useStableCallback(input.readDraft);
  const commitDraft = useStableCallback(input.commitDraft);
  const ownerKeyRef = useRef(input.ownerKey);
  ownerKeyRef.current = input.ownerKey;
  const environmentIdRef = useRef(input.environmentId);
  environmentIdRef.current = input.environmentId;

  const runtimeRef = useRef<{
    readonly recorder: WebVoiceRecorder;
    readonly controller: VoiceInputController;
  } | null>(null);
  if (!runtimeRef.current) {
    const recorder = new WebVoiceRecorder((status) =>
      runtimeRef.current?.controller.handleRecorderStatus(status),
    );
    let capturedOwnerKey: string | null = null;
    const controller = new VoiceInputController({
      recorder,
      getTranscriber: () => createWebVoiceTranscriber(environmentIdRef.current),
      requestPermission: () => recorder.requestPermission(),
      configureRecording: async () => {},
      releaseRecording: async () => recorder.release(),
      deleteRecording: (uri) => URL.revokeObjectURL(uri),
      readDraft: () => {
        const draft = readDraft();
        if (!draft) return null;
        capturedOwnerKey ??= ownerKeyRef.current;
        return { ownerKey: ownerKeyRef.current, revision: 0, ...draft };
      },
      commitDraft: (text, selection) => {
        if (capturedOwnerKey === ownerKeyRef.current) commitDraft(text, selection);
      },
      onStateChange: (next) => {
        if (!voiceInputBlocksSubmission(next)) {
          capturedOwnerKey = null;
          recorder.release();
        }
        setState(next);
      },
    });
    runtimeRef.current = { recorder, controller };
  }
  const { recorder, controller } = runtimeRef.current;

  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => controller.ownerChanged(), [controller, input.ownerKey]);

  useEffect(() => {
    if (state.phase !== "error" || !state.error) return;
    toastManager.add({ type: "error", title: "Voice input", description: state.error });
    controller.cancel();
  }, [controller, state]);

  return {
    isAvailable: isConfigured && isWebVoiceRecordingSupported(),
    state,
    recorder,
    isBusy: voiceInputBlocksSubmission(state),
    start: () => void controller.start(),
    stop: () => void controller.stop(),
    cancel: () => controller.cancel(),
  };
}

type ComposerVoiceInput = ReturnType<typeof useComposerVoiceInput>;

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Samples only while recording; nothing repaints once the recording stops. */
function useRecordingMeter(recorder: WebVoiceRecorder, recording: boolean) {
  const [meter, setMeter] = useState(() => ({
    levels: Array<number>(WAVEFORM_BARS).fill(0),
    elapsedSeconds: 0,
  }));
  useEffect(() => {
    if (!recording) return;
    setMeter({ levels: Array<number>(WAVEFORM_BARS).fill(0), elapsedSeconds: 0 });
    const intervalId = setInterval(() => {
      setMeter((current) => ({
        levels: [...current.levels.slice(1), recorder.level()],
        elapsedSeconds: recorder.elapsedSeconds(),
      }));
    }, SAMPLE_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [recorder, recording]);
  return meter;
}

const preventPointerFocus = (event: { preventDefault: () => void }) => event.preventDefault();

export const ComposerVoiceInputControl = memo(function ComposerVoiceInputControl({
  voice,
  disabled,
}: {
  readonly voice: ComposerVoiceInput;
  readonly disabled: boolean;
}) {
  const { phase } = voice.state;
  const meter = useRecordingMeter(voice.recorder, phase === "recording");

  if (phase === "recording") {
    return (
      <div
        data-chat-composer-voice-recording="true"
        className="flex h-8 items-center gap-1 rounded-full border border-border bg-muted/40 ps-1 pe-1"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onPointerDown={preventPointerFocus}
          onClick={voice.cancel}
          aria-label="Cancel voice input"
        >
          <XIcon />
        </Button>
        <div className="flex h-5 items-center gap-px" aria-hidden="true">
          {meter.levels.map((level, index) => (
            <span
              key={index}
              className="w-0.5 rounded-full bg-foreground/70"
              style={{ height: `${Math.max(2, Math.round(level * 20))}px` }}
            />
          ))}
        </div>
        <span className="min-w-8 text-center text-xs tabular-nums text-muted-foreground">
          {formatElapsed(meter.elapsedSeconds)}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onPointerDown={preventPointerFocus}
          onClick={voice.stop}
          aria-label="Finish voice input"
        >
          <CheckIcon />
        </Button>
      </div>
    );
  }

  const busy = phase === "preparing" || phase === "transcribing";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onPointerDown={preventPointerFocus}
            onClick={busy ? voice.cancel : voice.start}
            disabled={disabled && !busy}
            aria-label={
              phase === "transcribing"
                ? "Transcribing. Click to cancel"
                : busy
                  ? "Starting voice input. Click to cancel"
                  : "Voice input"
            }
          />
        }
      >
        {busy ? <Spinner size="sm" aria-hidden="true" /> : <MicIcon />}
      </TooltipTrigger>
      <TooltipPopup>{phase === "transcribing" ? "Transcribing…" : "Voice input"}</TooltipPopup>
    </Tooltip>
  );
});

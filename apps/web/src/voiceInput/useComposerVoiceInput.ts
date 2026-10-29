import {
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useStableCallback } from "~/hooks/useStableCallback";
import {
  createBrowserVoiceInput,
  voiceInputUnsupportedReason,
  type BrowserVoiceInput,
} from "./browserVoiceInput";
import {
  getLocalVoiceTranscription,
  releaseLocalVoiceTranscription,
} from "./localVoiceTranscription";
import { normalizeVoiceInputLanguage } from "./voiceInputLanguages";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const UNSUPPORTED_REASON = voiceInputUnsupportedReason();

export function useComposerVoiceInput(input: {
  /** Identifies the draft being edited; null when it cannot take dictation. */
  readonly ownerKey: string | null;
  /** The draft text as rendered; every change makes an earlier capture stale. */
  readonly value: string;
  readonly readText: () => string;
  /** The selection in draft-text offsets, with inline tokens expanded. */
  readonly readSelection: () => { readonly start: number; readonly end: number };
  /** Replaces the draft text and puts the caret at a draft-text offset. */
  readonly commit: (text: string, cursor: number) => void;
}) {
  const settings = useClientSettings((current) => ({
    enabled: current.voiceInputEnabled,
    language: current.voiceInputLanguage,
    microphoneId: current.voiceInputMicrophoneId,
  }));
  const [state, setState] = useState(IDLE_STATE);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const voiceInputRef = useRef<BrowserVoiceInput | null>(null);
  const revisionRef = useRef(0);
  const transcription = getLocalVoiceTranscription();
  const loadingPercent = useSyncExternalStore(
    transcription.subscribe,
    transcription.getLoadingPercent,
  );

  const { value, ownerKey } = input;
  const observedRef = useRef({ value, ownerKey });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- counts committed draft edits so a transcript never lands in text that was edited and changed back, and cancels dictation when the composer switches drafts
  useLayoutEffect(() => {
    const observed = observedRef.current;
    if (observed.value !== value) revisionRef.current += 1;
    const ownerChanged = observed.ownerKey !== ownerKey;
    observedRef.current = { value, ownerKey };
    if (ownerChanged) voiceInputRef.current?.controller.ownerChanged();
  }, [value, ownerKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the microphone, recording, and model when the composer unmounts
  useEffect(
    () => () => {
      voiceInputRef.current?.dispose();
      voiceInputRef.current = null;
    },
    [],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- turning voice input off stops any capture and frees the model worker
  useEffect(() => {
    if (settings.enabled) return;
    voiceInputRef.current?.controller.cancel();
    releaseLocalVoiceTranscription();
  }, [settings.enabled]);

  const readSettings = useStableCallback(() => ({
    language: normalizeVoiceInputLanguage(settings.language),
    microphoneId: settings.microphoneId,
  }));
  const readDraft = useStableCallback((): VoiceDraftSnapshot | null =>
    input.ownerKey === null
      ? null
      : {
          ownerKey: input.ownerKey,
          text: input.readText(),
          selection: input.readSelection(),
          revision: revisionRef.current,
        },
  );
  const commitDraft = useStableCallback(
    (text: string, selection: { readonly start: number; readonly end: number }) =>
      input.commit(text, selection.start),
  );

  const start = useStableCallback(() => {
    if (input.ownerKey === null || !settings.enabled || UNSUPPORTED_REASON !== null) return;
    let voiceInput = voiceInputRef.current;
    if (!voiceInput) {
      voiceInput = createBrowserVoiceInput({
        readSettings,
        readDraft,
        commitDraft,
        onStateChange: (next) => {
          setState(next);
          setRecordingStartedAt(next.phase === "recording" ? Date.now() : null);
        },
      });
      voiceInputRef.current = voiceInput;
    }
    void voiceInput.start();
  });
  const isBusyNow = useStableCallback(() => {
    const controller = voiceInputRef.current?.controller;
    return controller ? voiceInputBlocksSubmission(controller.currentState) : false;
  });
  const stop = useStableCallback(() => void voiceInputRef.current?.controller.stop());
  const cancel = useStableCallback(() => voiceInputRef.current?.controller.cancel());

  return {
    /** Hidden when turned off in Settings or when this client cannot record locally. */
    visible: settings.enabled && UNSUPPORTED_REASON === null,
    state,
    isBusy: voiceInputBlocksSubmission(state),
    /** Reads the controller rather than the last render, for checks at send time. */
    isBusyNow,
    loadingPercent: state.phase === "preparing" ? loadingPercent : null,
    recordingStartedAt,
    start,
    stop,
    cancel,
  };
}

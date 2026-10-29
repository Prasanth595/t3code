export type LocalVoiceWorkerRequest =
  | { readonly id: number; readonly kind: "load" }
  | {
      readonly id: number;
      readonly kind: "transcribe";
      /** 16 kHz mono samples, transferred to the worker. */
      readonly audio: Float32Array;
      /** A Whisper language code, or null to detect it from the audio. */
      readonly language: string | null;
    };

export type LocalVoiceWorkerResponse =
  | { readonly kind: "progress"; readonly percent: number }
  | { readonly kind: "done"; readonly id: number; readonly text: string }
  | { readonly kind: "failed"; readonly id: number; readonly message: string };

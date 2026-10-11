import { requireOptionalNativeModule } from "expo";

/** Projects the CarPlay screen and Siri can offer; see modules/t3-voice-dispatch. */
export interface NativeVoiceDispatchProject {
  readonly key: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly spokenNames: ReadonlyArray<string>;
}

export interface NativeVoicePrompt {
  readonly title: string;
  readonly listening: boolean;
  readonly buttons: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly systemImage: string;
  }>;
}

export interface NativeListenRequest {
  readonly endSilenceMs: number;
  readonly startTimeoutMs: number;
  readonly maxDurationMs: number;
  readonly hints: ReadonlyArray<string>;
}

export type NativeListenOutcome =
  | { readonly type: "speech"; readonly transcript: string }
  | { readonly type: "button"; readonly buttonId: string }
  | { readonly type: "no-speech" };

export interface VoiceDispatchNativeEvents {
  /** The CarPlay screen connected or went away. */
  readonly onCarPlaySession: { readonly connected: boolean };
  /** A CarPlay screen button was tapped. */
  readonly onVoiceButton: { readonly buttonId: string };
  /** Siri asks to start a thread; answer with resolveDispatch. */
  readonly onDispatchRequest: {
    readonly requestId: string;
    readonly projectKey: string;
    readonly text: string;
  };
}

export interface VoiceDispatchNativeModule {
  /** Call once listeners are attached; native waits for it before sending requests. */
  markReady(): Promise<void>;
  setProjects(projects: ReadonlyArray<NativeVoiceDispatchProject>): Promise<void>;
  resolveDispatch(
    requestId: string,
    status: "started" | "queued" | "failed",
    message: string | null,
  ): Promise<void>;
  showPrompt(prompt: NativeVoicePrompt): Promise<void>;
  speak(text: string): Promise<void>;
  stopSpeaking(): Promise<void>;
  listen(request: NativeListenRequest): Promise<NativeListenOutcome>;
  stopListening(buttonId: string, keepTranscript: boolean): Promise<void>;
  chooseProject(projects: ReadonlyArray<NativeVoiceDispatchProject>): Promise<string | null>;
  /** Releases the audio session; CarPlay asks voice apps not to hold it idle. */
  endConversation(): Promise<void>;
  addListener<Name extends keyof VoiceDispatchNativeEvents>(
    eventName: Name,
    listener: (event: VoiceDispatchNativeEvents[Name]) => void,
  ): { remove(): void };
}

/** Null on Android and in iOS builds without the module. */
export function getVoiceDispatchModule(): VoiceDispatchNativeModule | null {
  return requireOptionalNativeModule<VoiceDispatchNativeModule>("T3VoiceDispatch");
}

import {
  WS_METHODS,
  type EnvironmentId,
  type VoiceTranscribeInput,
  type VoiceTranscribeResult,
} from "@t3tools/contracts";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
  type AttachmentByteUpload,
  type AttachmentCreateUploadUrlCommand,
  type AttachmentRemoveCommand,
} from "../state/attachments.ts";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "../state/runtime.ts";
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "./transcription.ts";

export function createVoiceInputEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    transcribe: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:voice-input:transcribe",
      tag: WS_METHODS.voiceInputTranscribe,
    }),
  };
}

export type VoiceRecordingUpload = {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly transport: (url: string) => AttachmentByteUpload;
};

type VoiceTranscribeCommand<E> = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: VoiceTranscribeInput },
  VoiceTranscribeResult,
  E
>;

const SERVER_EXPLAINED_FAILURES = new Set([
  "VoiceTranscriptionRequestError",
  "EnvironmentAuthorizationError",
]);

function serverFailureMessage(error: unknown): string | undefined {
  return error instanceof Error &&
    "_tag" in error &&
    typeof error._tag === "string" &&
    SERVER_EXPLAINED_FAILURES.has(error._tag)
    ? error.message
    : undefined;
}

/**
 * The server keeps transcribing after a cancel, so the abort settles immediately instead of
 * holding the shared transcription lane until the provider answers. The server deletes the
 * recording either way.
 */
function settleOnAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled."));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Transcribes on the environment, which holds the OpenAI key. */
export function createEnvironmentVoiceTranscriber<UE, RE, TE>(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly environmentId: EnvironmentId;
  /** Only drives transcript spacing; the provider detects the spoken language. */
  readonly locale: string;
  readonly createUploadUrl: AttachmentCreateUploadUrlCommand<UE>;
  readonly remove: AttachmentRemoveCommand<RE>;
  readonly transcribe: VoiceTranscribeCommand<TE>;
  readonly resolveUploadUrl: (relativeUrl: string) => string | null;
  readonly readRecording: (uri: string) => Promise<VoiceRecordingUpload>;
}): VoiceTranscriber {
  const transcribe = async (uri: string, { signal }: { readonly signal: AbortSignal }) => {
    throwIfVoiceTranscriptionAborted(signal);
    const recording = await input.readRecording(uri);
    throwIfVoiceTranscriptionAborted(signal);

    let abortTransfer: (() => void) | null = null;
    const onAbort = () => abortTransfer?.();
    signal.addEventListener("abort", onAbort, { once: true });
    const upload = await runAttachmentUploadCycle({
      registry: input.registry,
      createUploadUrl: input.createUploadUrl,
      remove: input.remove,
      environmentId: input.environmentId,
      upload: {
        type: "file",
        name: recording.name,
        mimeType: recording.mimeType,
        sizeBytes: recording.sizeBytes,
      },
      resolveUploadUrl: input.resolveUploadUrl,
      transport: recording.transport,
      onMinted: () => (signal.aborted ? "cancel" : "continue"),
      onTransferStart: (abort) => {
        abortTransfer = abort;
        if (signal.aborted) abort();
      },
    }).finally(() => signal.removeEventListener("abort", onAbort));

    if (upload.status !== "uploaded") {
      if (upload.status === "failed" && upload.attachmentId) {
        deletePendingAttachmentUpload({
          registry: input.registry,
          remove: input.remove,
          environmentId: input.environmentId,
          attachmentId: upload.attachmentId,
        });
      }
      throwIfVoiceTranscriptionAborted(signal);
      throw new VoiceTranscriptionError(
        "transcription-failed",
        "Could not upload the voice recording.",
        {
          cause: upload.status === "failed" ? upload.error : undefined,
          userMessage: "Could not upload the recording.",
        },
      );
    }

    const result = await settleOnAbort(
      runAtomCommand(
        input.registry,
        input.transcribe,
        { environmentId: input.environmentId, input: { attachmentId: upload.attachmentId } },
        { reportFailure: false },
      ),
      signal,
    );
    if (result._tag === "Success") return result.value.text;
    throwIfVoiceTranscriptionAborted(signal);
    const error = squashAtomCommandFailure(result);
    const userMessage = serverFailureMessage(error);
    throw new VoiceTranscriptionError("transcription-failed", "Voice transcription failed.", {
      cause: error,
      ...(userMessage ? { userMessage } : {}),
    });
  };

  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      return { locale: input.locale, transcribe };
    },
  };
}

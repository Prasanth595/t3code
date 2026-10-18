import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  createEnvironmentVoiceTranscriber,
  createVoiceInputEnvironmentAtoms,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { requestHeadersRecord } from "../connection/requestHeaders";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { attachmentEnvironment } from "./attachments";
import { serverEnvironment } from "./server";
import { environmentSession } from "./session";

export const voiceInputEnvironment = createVoiceInputEnvironmentAtoms(connectionAtomRuntime);

const RECORDING_MIME_TYPES: Readonly<Record<string, string>> = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  "3gp": "audio/3gpp",
  webm: "audio/webm",
  wav: "audio/wav",
};

/** Clients receive the key redacted, so a non-empty value only says one is saved. */
export function environmentTranscribesVoice(environmentId: EnvironmentId): boolean {
  const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
  return (config?.settings.voiceTranscriptionOpenAiApiKey ?? "") !== "";
}

export function createMobileVoiceTranscriber(environmentId: EnvironmentId): VoiceTranscriber {
  return createEnvironmentVoiceTranscriber({
    registry: appAtomRegistry,
    environmentId,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    transcribe: voiceInputEnvironment.transcribe,
    resolveUploadUrl: (relativeUrl) => {
      const connection = appAtomRegistry.get(
        environmentSession.preparedConnectionValueAtom(environmentId),
      );
      return Option.isNone(connection)
        ? null
        : resolveAssetUrl(connection.value.httpBaseUrl, relativeUrl);
    },
    readRecording: async (uri) => {
      const { File, UploadType } = await import("expo-file-system");
      const file = new File(uri);
      const extension = (file.extension.replace(/^\./, "") || "m4a").toLowerCase();
      const mimeType = RECORDING_MIME_TYPES[extension] ?? "audio/mp4";
      return {
        name: `dictation.${extension}`,
        mimeType,
        sizeBytes: file.size,
        transport: (url) => {
          const controller = new AbortController();
          const done = file
            .upload(url, {
              httpMethod: "POST",
              uploadType: UploadType.BINARY_CONTENT,
              headers: { "Content-Type": mimeType, ...requestHeadersRecord(url) },
              signal: controller.signal,
            })
            .then((result) => {
              if (result.status < 200 || result.status >= 300) {
                throw new Error(`Recording upload failed (${result.status}).`);
              }
            });
          return { done, abort: () => controller.abort() };
        },
      };
    },
  });
}

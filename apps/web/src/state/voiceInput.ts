import type { EnvironmentId } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  createEnvironmentVoiceTranscriber,
  createVoiceInputEnvironmentAtoms,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";

import { connectionAtomRuntime } from "../connection/runtime";
import { uploadBytes } from "../lib/attachmentUploadQueue";
import { recordingFileExtension } from "../lib/webVoiceRecorder";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { attachmentEnvironment } from "./attachments";
import { readPreparedConnection } from "./session";

const voiceInputEnvironment = createVoiceInputEnvironmentAtoms(connectionAtomRuntime);

export function createWebVoiceTranscriber(environmentId: EnvironmentId): VoiceTranscriber {
  return createEnvironmentVoiceTranscriber({
    registry: appAtomRegistry,
    environmentId,
    locale: navigator.language || "en",
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    transcribe: voiceInputEnvironment.transcribe,
    resolveUploadUrl: (relativeUrl) => {
      const connection = readPreparedConnection(environmentId);
      return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
    },
    readRecording: async (uri) => {
      const blob = await fetch(uri).then((response) => response.blob());
      const mimeType = blob.type.split(";")[0] || "audio/webm";
      return {
        name: `dictation.${recordingFileExtension(mimeType)}`,
        mimeType,
        sizeBytes: blob.size,
        transport: (url) => uploadBytes({ url, file: blob, mimeType, onProgress: () => {} }),
      };
    },
  });
}

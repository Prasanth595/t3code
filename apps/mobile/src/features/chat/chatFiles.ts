import { SAAS_CHAT_MAX_ATTACHMENT_BYTES } from "@t3tools/contracts/saas";
import { File } from "expo-file-system";

import {
  pickComposerFiles,
  pickComposerMedia,
  type DraftComposerAttachment,
} from "../../lib/composerImages";

/** A picked photo or document, ready to upload. */
export interface ChatFileToSend {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly previewUri: string | null;
  readonly body: () => BodyInit;
}

const dataUrlBytes = (dataUrl: string) => {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const toSend = (attachment: DraftComposerAttachment): ChatFileToSend | null => {
  if (attachment.type === "file") {
    return {
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      previewUri: null,
      body: () => new File(attachment.fileUri),
    };
  }
  const { fileUri, dataUrl } = attachment;
  if (fileUri === undefined && dataUrl === undefined) return null;
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    previewUri: attachment.previewUri,
    body: () => (fileUri !== undefined ? new File(fileUri) : dataUrlBytes(dataUrl!)),
  };
};

const sendable = (attachments: ReadonlyArray<DraftComposerAttachment>) =>
  attachments.flatMap((attachment) => {
    const file = toSend(attachment);
    return file === null ? [] : [file];
  });

export async function pickChatPhotos(existingCount: number) {
  const result = await pickComposerMedia({ existingCount });
  return { files: sendable(result.attachments), error: result.error };
}

export async function pickChatDocuments(existingCount: number) {
  const result = await pickComposerFiles({
    existingCount,
    maxBytes: SAAS_CHAT_MAX_ATTACHMENT_BYTES,
  });
  return { files: sendable(result.files), error: result.error };
}

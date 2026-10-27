import { SAAS_CHAT_MAX_ATTACHMENT_BYTES } from "@t3tools/contracts/saas";
import { File } from "expo-file-system";

import {
  pickComposerFiles,
  pickComposerMedia,
  type DraftComposerAttachment,
} from "../../lib/composerImages";

const dataUrlBytes = (dataUrl: string) => {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/** The bytes to upload for a picked photo or document; null when it has none on the device. */
export const chatFileBody = (attachment: DraftComposerAttachment): BodyInit | null => {
  if (attachment.type === "file") return new File(attachment.fileUri);
  if (attachment.fileUri !== undefined) return new File(attachment.fileUri);
  return attachment.dataUrl === undefined ? null : dataUrlBytes(attachment.dataUrl);
};

export async function pickChatPhotos(existingCount: number) {
  const result = await pickComposerMedia({ existingCount });
  return { attachments: result.attachments, error: result.error };
}

export async function pickChatDocuments(existingCount: number) {
  const result = await pickComposerFiles({
    existingCount,
    maxBytes: SAAS_CHAT_MAX_ATTACHMENT_BYTES,
  });
  return { attachments: result.files, error: result.error };
}

import {
  SAAS_CHAT_DEVICE_HEADER,
  SAAS_CHAT_DOCUMENT_EXTENSIONS,
  SAAS_CHAT_FILE_NAME_HEADER,
  SAAS_CHAT_IMAGE_TYPES,
  SAAS_CHAT_MAX_ATTACHMENT_BYTES,
  SaasChatAttachment,
  type SaasChatAttachmentKind,
} from "@t3tools/contracts/saas";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type ChatUploadResult =
  | { readonly ok: true; readonly attachment: SaasChatAttachment }
  | { readonly ok: false; readonly message: string };

const decodeAttachment = Schema.decodeUnknownOption(Schema.fromJsonString(SaasChatAttachment));
const decodeError = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ message: Schema.String }) })),
);

/** Whether a file can go into a chat, judged before uploading it. */
const chatAttachmentKind = (name: string, mimeType: string): SaasChatAttachmentKind | undefined => {
  if (SAAS_CHAT_IMAGE_TYPES.includes(mimeType)) return "image";
  const extension = name.toLowerCase().split(".").pop() ?? "";
  return SAAS_CHAT_DOCUMENT_EXTENSIONS.includes(extension) ? "document" : undefined;
};

export const chatAttachmentProblem = (input: {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}): string | null => {
  if (chatAttachmentKind(input.name, input.mimeType) === undefined) {
    return `Mira cannot read ${input.name}. Send photos, PDF, Word, Excel, PowerPoint, text or CSV files.`;
  }
  if (input.sizeBytes > SAAS_CHAT_MAX_ATTACHMENT_BYTES) {
    return `${input.name} is larger than 20 MB.`;
  }
  return null;
};

/** Where a stored photo or document can be read back; the id is its only key. */
export const chatAttachmentUrl = (relayUrl: string, attachmentId: string) =>
  `${relayUrl.replace(/\/+$/, "")}/v1/chat/attachments/${encodeURIComponent(attachmentId)}`;

/** Stores a photo or document on the relay so a chat message can carry it. */
export async function uploadChatAttachment(input: {
  readonly relayUrl: string;
  readonly clerkToken: string | null;
  readonly deviceId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly body: BodyInit;
  readonly fetch?: typeof globalThis.fetch;
}): Promise<ChatUploadResult> {
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(
      `${input.relayUrl.replace(/\/+$/, "")}/v1/chat/attachments`,
      {
        method: "POST",
        headers: {
          "content-type": input.mimeType || "application/octet-stream",
          [SAAS_CHAT_FILE_NAME_HEADER]: encodeURIComponent(input.name),
          [SAAS_CHAT_DEVICE_HEADER]: input.deviceId,
          ...(input.clerkToken ? { authorization: `Bearer ${input.clerkToken}` } : {}),
        },
        body: input.body,
      },
    );
  } catch {
    return { ok: false, message: "Could not reach Mira. Check your internet connection." };
  }
  const text = await response.text().catch(() => "");
  if (response.ok) {
    return Option.match(decodeAttachment(text), {
      onNone: () => ({ ok: false, message: `Could not send ${input.name}. Try again.` }),
      onSome: (attachment) => ({ ok: true, attachment }),
    });
  }
  return {
    ok: false,
    message: Option.match(decodeError(text), {
      onNone: () => `Could not send ${input.name}. Try again.`,
      onSome: ({ error }) => error.message,
    }),
  };
}

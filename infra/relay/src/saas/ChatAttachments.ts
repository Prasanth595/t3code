import {
  SAAS_CHAT_FILE_NAME_HEADER,
  SAAS_CHAT_IMAGE_TYPES,
  SAAS_CHAT_MAX_ATTACHMENT_BYTES,
  type SaasChatAttachment,
  type SaasChatErrorCode,
} from "@t3tools/contracts/saas";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { documentKind, extractDocumentText } from "./documentText.ts";

export class ChatAttachmentStoreError extends Data.TaggedError("ChatAttachmentStoreError")<{
  readonly cause: unknown;
}> {}

/** Where chat photos and documents live: R2 in the Worker, a map in tests. */
export class ChatAttachmentStore extends Context.Service<
  ChatAttachmentStore,
  {
    readonly put: (
      key: string,
      bytes: Uint8Array,
      contentType: string,
    ) => Effect.Effect<void, ChatAttachmentStoreError>;
    readonly get: (
      key: string,
    ) => Effect.Effect<
      Option.Option<{ readonly bytes: Uint8Array; readonly contentType: string }>,
      ChatAttachmentStoreError
    >;
  }
>()("t3code-relay/saas/ChatAttachments/ChatAttachmentStore") {}

// Older photos are named instead of re-sent, so a long chat does not resend every image.
const IMAGE_MESSAGES_SENT = 3;

const fileKey = (id: string) => `chat/${id}`;
const textKey = (id: string) => `chat/${id}.txt`;

const randomId = () =>
  Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
};

const chatError = (status: number, code: SaasChatErrorCode, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: { code, message } }, { status });

const readFileName = (request: HttpServerRequest.HttpServerRequest) => {
  const raw = request.headers[SAAS_CHAT_FILE_NAME_HEADER] ?? "";
  try {
    return decodeURIComponent(raw).trim().slice(0, 200) || "file";
  } catch {
    return "file";
  }
};

type ModelContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image_url"; readonly image_url: { readonly url: string } };

export interface ModelMessage {
  readonly role: "user" | "assistant";
  readonly content: string | ReadonlyArray<ModelContentPart>;
}

export class ChatAttachments extends Context.Service<
  ChatAttachments,
  {
    /** Stores an upload; the caller has already checked who is sending it. */
    readonly upload: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
    readonly download: (
      attachmentId: string,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
    /** Messages as the model reads them: documents inlined as text, recent photos attached. */
    readonly toModelMessages: (
      messages: ReadonlyArray<{
        readonly role: "user" | "assistant";
        readonly content: string;
        readonly attachments?: ReadonlyArray<SaasChatAttachment>;
      }>,
    ) => Effect.Effect<ReadonlyArray<ModelMessage>>;
  }
>()("t3code-relay/saas/ChatAttachments") {}

export const make = Effect.gen(function* () {
  const store = yield* ChatAttachmentStore;

  const upload = Effect.fn("relay.chat.attachments.upload")(
    function* (request: HttpServerRequest.HttpServerRequest) {
      const declaredSize = Number(request.headers["content-length"] ?? "0");
      if (declaredSize > SAAS_CHAT_MAX_ATTACHMENT_BYTES) {
        return chatError(413, "invalid_request", "Files can be up to 20 MB.");
      }

      const name = readFileName(request);
      const contentType = (request.headers["content-type"] ?? "").split(";")[0]!.trim();
      const image = SAAS_CHAT_IMAGE_TYPES.includes(contentType);
      const document = image ? undefined : documentKind(name);
      if (!image && document === undefined) {
        return chatError(
          415,
          "invalid_request",
          "Mira reads photos, PDF, Word, Excel, PowerPoint, text and CSV files. Save older Office files as .docx, .xlsx or .pptx.",
        );
      }
      const bytes = new Uint8Array(yield* request.arrayBuffer);
      if (bytes.length === 0) return chatError(400, "invalid_request", "This file is empty.");
      if (bytes.length > SAAS_CHAT_MAX_ATTACHMENT_BYTES) {
        return chatError(413, "invalid_request", "Files can be up to 20 MB.");
      }

      const id = randomId();
      if (document !== undefined) {
        const text = yield* Effect.tryPromise(() => extractDocumentText(document, bytes)).pipe(
          Effect.option,
        );
        if (Option.isNone(text) || text.value === "") {
          return chatError(
            422,
            "invalid_request",
            "Mira could not read text in this document. Scanned pages need to be sent as photos.",
          );
        }
        yield* store.put(textKey(id), new TextEncoder().encode(text.value), "text/plain");
      }
      const storedType = contentType || "application/octet-stream";
      yield* store.put(fileKey(id), bytes, storedType);
      const attachment: SaasChatAttachment = {
        id,
        kind: image ? "image" : "document",
        name,
        mimeType: storedType,
        sizeBytes: bytes.length,
      };
      return HttpServerResponse.jsonUnsafe(attachment);
    },
    Effect.catch((error) =>
      Effect.logError("Chat attachment upload failed", { error }).pipe(
        Effect.as(chatError(502, "upstream_unavailable", "Could not save this file. Try again.")),
      ),
    ),
  );

  const download = Effect.fn("relay.chat.attachments.download")(
    function* (attachmentId: string) {
      const file = yield* store.get(fileKey(attachmentId));
      if (Option.isNone(file)) return HttpServerResponse.empty({ status: 404 });
      return HttpServerResponse.uint8Array(file.value.bytes, {
        contentType: file.value.contentType,
        // Ids never change content, so devices keep their copy.
        headers: { "cache-control": "private, max-age=31536000, immutable" },
      });
    },
    Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 502 }))),
  );

  const readText = (attachment: SaasChatAttachment) =>
    store.get(textKey(attachment.id)).pipe(
      Effect.map(Option.map((file) => new TextDecoder().decode(file.bytes))),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  const readImage = (attachment: SaasChatAttachment) =>
    store.get(fileKey(attachment.id)).pipe(
      Effect.map(Option.map((file) => `data:${file.contentType};base64,${base64(file.bytes)}`)),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  const toModelMessages = Effect.fn("relay.chat.attachments.model_messages")(function* (
    messages: ReadonlyArray<{
      readonly role: "user" | "assistant";
      readonly content: string;
      readonly attachments?: ReadonlyArray<SaasChatAttachment>;
    }>,
  ) {
    const withImages = messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.attachments?.some((file) => file.kind === "image"))
      .slice(-IMAGE_MESSAGES_SENT)
      .map(({ index }) => index);

    return yield* Effect.forEach(
      messages,
      Effect.fnUntraced(function* (message, index): Effect.fn.Return<ModelMessage> {
        const attachments = message.attachments ?? [];
        if (message.role !== "user" || attachments.length === 0) {
          return { role: message.role, content: message.content };
        }
        const notes: Array<string> = [];
        const images: Array<ModelContentPart> = [];
        for (const attachment of attachments) {
          if (attachment.kind === "document") {
            const text = yield* readText(attachment);
            notes.push(
              Option.isSome(text)
                ? `<document name="${attachment.name}">\n${text.value}\n</document>`
                : `[The document ${attachment.name} is no longer available.]`,
            );
          } else if (withImages.includes(index)) {
            const url = yield* readImage(attachment);
            if (Option.isSome(url)) {
              images.push({ type: "image_url", image_url: { url: url.value } });
            } else notes.push(`[The photo ${attachment.name} is no longer available.]`);
          } else {
            notes.push(`[Earlier photo: ${attachment.name}]`);
          }
        }
        const text = [...notes, message.content].filter((part) => part !== "").join("\n\n");
        return images.length === 0
          ? { role: "user", content: text }
          : { role: "user", content: [{ type: "text", text }, ...images] };
      }),
      { concurrency: 4 },
    );
  });

  return ChatAttachments.of({ upload, download, toModelMessages });
});

export const layer = Layer.effect(ChatAttachments, make);

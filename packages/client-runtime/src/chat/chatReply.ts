import {
  SAAS_CHAT_DEVICE_HEADER,
  SaasChatErrorCode,
  type SaasChatAttachment,
  type SaasChatRole,
} from "@t3tools/contracts/saas";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type ChatReplyErrorCode = SaasChatErrorCode | "network";

export type ChatReplyResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: ChatReplyErrorCode; readonly message: string };

export interface ChatReplyRequest {
  readonly relayUrl: string;
  /** Null for someone without an account; the device id then counts their free messages. */
  readonly clerkToken: string | null;
  readonly deviceId: string;
  readonly messages: ReadonlyArray<{
    readonly role: SaasChatRole;
    readonly content: string;
    readonly attachments?: ReadonlyArray<SaasChatAttachment>;
  }>;
  readonly onText: (text: string) => void;
  /** The relay is searching the web before it writes more of the reply. */
  readonly onSearching?: () => void;
  readonly signal?: AbortSignal;
  /** React Native passes `expo/fetch`, whose responses stream. */
  readonly fetch?: typeof globalThis.fetch;
}

const decodeChunk = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      mira: Schema.optionalKey(Schema.Struct({ status: Schema.String })),
      choices: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            delta: Schema.optionalKey(
              Schema.Struct({ content: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
            ),
          }),
        ),
      ),
    }),
  ),
);

const decodeError = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ error: Schema.Struct({ code: SaasChatErrorCode, message: Schema.String }) }),
  ),
);

/** Collects the reply text from an OpenAI SSE body that arrives in arbitrary chunks. */
export class ChatSseDecoder {
  private buffer = "";
  text = "";
  /** Set while the relay searches; cleared when more text arrives. */
  searching = false;
  /** The relay's closing `[DONE]` arrived, so the reply is whole. */
  done = false;

  /** Returns whether the text grew. */
  push(chunk: string): boolean {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    const before = this.text.length;
    const wasSearching = this.searching;
    for (const line of lines) this.readLine(line);
    return this.text.length !== before || this.searching !== wasSearching;
  }

  finish(): boolean {
    const before = this.text.length;
    this.readLine(this.buffer);
    this.buffer = "";
    return this.text.length !== before;
  }

  private readLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice("data:".length).trim();
    if (data === "[DONE]") this.done = true;
    if (data === "" || data === "[DONE]") return;
    const chunk = decodeChunk(data);
    if (Option.isNone(chunk)) return;
    if (chunk.value.mira?.status === "searching") this.searching = true;
    for (const choice of chunk.value.choices ?? []) {
      const content = choice.delta?.content ?? "";
      if (content === "") continue;
      this.text += content;
      this.searching = false;
    }
  }
}

const failure = (code: ChatReplyErrorCode, message: string): ChatReplyResult => ({
  ok: false,
  code,
  message,
});

/** Streams a chat-mode reply from the relay, reporting the text so far as it grows. */
export async function requestChatReply(request: ChatReplyRequest): Promise<ChatReplyResult> {
  let response: Response;
  try {
    response = await (request.fetch ?? fetch)(
      `${request.relayUrl.replace(/\/+$/, "")}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SAAS_CHAT_DEVICE_HEADER]: request.deviceId,
          ...(request.clerkToken ? { authorization: `Bearer ${request.clerkToken}` } : {}),
        },
        body: JSON.stringify({ messages: request.messages }),
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );
  } catch {
    return failure("network", "Could not reach Mira. Check your internet connection.");
  }
  if (!response.ok || response.body === null) {
    const body = await response.text().catch(() => "");
    return Option.match(decodeError(body), {
      onNone: () => failure("upstream_unavailable", "Mira could not answer. Try again."),
      onSome: ({ error }) => failure(error.code, error.message),
    });
  }
  const decoder = new ChatSseDecoder();
  const reader = response.body.getReader();
  const utf8 = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (decoder.push(utf8.decode(value, { stream: true }))) {
        if (decoder.searching) request.onSearching?.();
        else request.onText(decoder.text);
      }
    }
    if (decoder.finish()) request.onText(decoder.text);
  } catch {
    decoder.done = false;
  }
  if (!decoder.done) {
    // Half a reply would be saved as if it were whole; retrying asks for all of it again.
    return failure("network", "The answer was cut off. Try again.");
  }
  return { ok: true, text: decoder.text };
}

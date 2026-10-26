import {
  SAAS_CHAT_DEVICE_HEADER,
  SaasChatErrorCode,
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
  readonly messages: ReadonlyArray<{ readonly role: SaasChatRole; readonly content: string }>;
  readonly onText: (text: string) => void;
  readonly signal?: AbortSignal;
  /** React Native passes `expo/fetch`, whose responses stream. */
  readonly fetch?: typeof globalThis.fetch;
}

const decodeChunk = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      choices: Schema.Array(
        Schema.Struct({
          delta: Schema.optionalKey(
            Schema.Struct({ content: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
          ),
        }),
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

  /** Returns whether the text grew. */
  push(chunk: string): boolean {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    const before = this.text.length;
    for (const line of lines) this.readLine(line);
    return this.text.length !== before;
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
    if (data === "" || data === "[DONE]") return;
    const chunk = decodeChunk(data);
    if (Option.isNone(chunk)) return;
    for (const choice of chunk.value.choices) this.text += choice.delta?.content ?? "";
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
      if (decoder.push(utf8.decode(value, { stream: true }))) request.onText(decoder.text);
    }
    if (decoder.finish()) request.onText(decoder.text);
  } catch {
    if (decoder.text === "") {
      return failure("network", "The answer was cut off. Try again.");
    }
  }
  return { ok: true, text: decoder.text };
}

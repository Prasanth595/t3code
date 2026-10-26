import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
/** Model turns that may search before the reply must be written without more searching. */
export const MAX_SEARCH_ROUNDS = 3;
const SEARCH_RESULT_COUNT = 6;
const MAX_QUERY_LENGTH = 128;

export const WEB_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web. Use it for recent events, prices, schedules, facts you are unsure of, or whenever the user asks to look something up. Cite the pages you use.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for, as a short search query." },
      },
      required: ["query"],
    },
  },
} as const;

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encoder = new TextEncoder();

/** An SSE event of the relay's own stream, in the OpenAI chunk format clients already read. */
export const contentEvent = (content: string) =>
  encoder.encode(`data: ${toJson({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
/** Tells clients Mira is searching, so they can say so instead of "Thinking". */
export const searchingEvent = () =>
  encoder.encode(`data: ${toJson({ mira: { status: "searching" } })}\n\n`);
export const doneEvent = () => encoder.encode("data: [DONE]\n\n");

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Reads one streamed model turn: passes its text on as it arrives, and collects its reasoning,
 * tool calls and usage for the next turn.
 */
export class ModelTurnReader {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private readonly calls = new Map<number, { id: string; name: string; arguments: string }>();
  content = "";
  reasoning = "";
  inputTokens = 0;
  outputTokens = 0;

  /** The text that arrived in this chunk. */
  push(chunk: Uint8Array): string {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.map((line) => this.readLine(line)).join("");
  }

  finish(): string {
    this.buffer += this.decoder.decode();
    const text = this.readLine(this.buffer);
    this.buffer = "";
    return text;
  }

  get toolCalls(): ReadonlyArray<ToolCall> {
    return [...this.calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => call)
      .filter((call) => call.name !== "");
  }

  private readLine(line: string): string {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return "";
    const data = trimmed.slice("data:".length).trim();
    if (data === "" || data === "[DONE]") return "";
    const chunk = record(Option.getOrUndefined(parseJson(data)));
    if (chunk === undefined) return "";
    const usage = record(chunk.usage);
    if (usage) {
      this.inputTokens += typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
      this.outputTokens +=
        typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
    }
    let text = "";
    for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
      const delta = record(record(choice)?.delta);
      if (!delta) continue;
      if (typeof delta.content === "string") text += delta.content;
      if (typeof delta.reasoning_content === "string") this.reasoning += delta.reasoning_content;
      for (const raw of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const call = record(raw);
        const fn = record(call?.function);
        const index = typeof call?.index === "number" ? call.index : 0;
        const current = this.calls.get(index) ?? { id: "", name: "", arguments: "" };
        if (typeof call?.id === "string") current.id = call.id;
        if (typeof fn?.name === "string") current.name += fn.name;
        if (typeof fn?.arguments === "string") current.arguments += fn.arguments;
        this.calls.set(index, current);
      }
    }
    this.content += text;
    return text;
  }
}

/** The query a `web_search` call asked for; none when its arguments are not valid. */
export const searchQuery = (call: ToolCall): string | undefined => {
  const args = record(Option.getOrUndefined(parseJson(call.arguments)));
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  return query === "" ? undefined : query.slice(0, MAX_QUERY_LENGTH);
};

export const searchRequestBody = (query: string) => ({ query, count: SEARCH_RESULT_COUNT });

/** Search results as compact text for the model. */
export const formatSearchResults = (payload: unknown): string => {
  const body = record(payload);
  const list = [body?.results, body?.data, record(body?.data)?.results].find(Array.isArray);
  const results = (list ?? []).flatMap((item, index) => {
    const result = record(item);
    if (!result) return [];
    const field = (name: string) => (typeof result[name] === "string" ? result[name] : "");
    const summary = field("summary") || field("snippet") || field("content").slice(0, 1200);
    return [`[${index + 1}] ${field("title")}\n${field("url")}\n${summary}`.trim()];
  });
  return results.length === 0 ? "No results." : results.join("\n\n");
};

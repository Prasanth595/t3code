import { CHAT_VISUAL_LANGUAGE } from "@t3tools/shared/htmlRender";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
/** Model turns that may search; later searches are refused so the model answers with what it found. */
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

export const SHOW_VISUAL_TOOL = {
  type: "function",
  function: {
    name: "show_visual",
    description:
      "Show the user a visual (chart, table, dashboard, timeline, diagram) inline in the reply. Pass one complete, self-contained HTML document.",
    parameters: {
      type: "object",
      properties: {
        html: { type: "string", description: "The complete HTML document to show." },
      },
      required: ["html"],
    },
  },
} as const;

// Longer than any fence the page itself is likely to contain, so its HTML cannot close the block.
const VISUAL_FENCE = "````";
/** What the model hears back from show_visual. */
export const VISUAL_SHOWN_RESULT =
  "Shown to the user in the reply. Continue without repeating what it shows.";
export const VISUAL_FAILED_RESULT =
  "The visual was not shown: its HTML was cut off or invalid. Call show_visual again with a smaller page, well under 15 KB.";

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
  /** The show_visual call whose fence is open in the streamed text. */
  private openVisual: { id: string; name: string; arguments: string } | undefined;
  private readonly openedVisuals = new Set<number>();
  /** Text the model writes while a visual is open, held until the fence closes. */
  private heldText = "";
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
    const text = this.readLine(this.buffer) + this.closeVisual();
    this.buffer = "";
    return text;
  }

  /** Streams a show_visual call as a visual fence: clients show a placeholder until it closes. */
  private closeVisual(): string {
    const call = this.openVisual;
    if (call === undefined) return "";
    this.openVisual = undefined;
    const held = this.heldText;
    this.heldText = "";
    // A cut-off page shows nothing; the model hears it failed and sends it again.
    return `${visualHtml(call) ?? ""}\n${VISUAL_FENCE}\n\n${held}`;
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
    let fences = "";
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
        if (current.name === SHOW_VISUAL_TOOL.function.name && !this.openedVisuals.has(index)) {
          this.openedVisuals.add(index);
          fences += `${this.closeVisual()}\n\n${VISUAL_FENCE}${CHAT_VISUAL_LANGUAGE}\n`;
          this.openVisual = current;
        }
      }
    }
    this.content += text;
    if (fences === "" && this.openVisual !== undefined) {
      this.heldText += text;
      return "";
    }
    return text + fences;
  }
}

/** The query a `web_search` call asked for; none when its arguments are not valid. */
export const searchQuery = (call: ToolCall): string | undefined => {
  const args = record(Option.getOrUndefined(parseJson(call.arguments)));
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  return query === "" ? undefined : query.slice(0, MAX_QUERY_LENGTH);
};

/** The page a show_visual call carries; none when its arguments were cut off or hold no HTML. */
export const visualHtml = (call: ToolCall): string | undefined => {
  const args = record(Option.getOrUndefined(parseJson(call.arguments)));
  const html = typeof args?.html === "string" ? args.html.trim() : "";
  // Models sometimes wrap the page in a markdown fence, which would show as text.
  const page = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(html)?.[1]?.trim() ?? html;
  return page === "" ? undefined : page;
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

import type { ProviderReplayEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as EffectAcpProtocol from "effect-acp/protocol";

interface JsonRpcMessage {
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface WireMessage {
  readonly direction: "incoming" | "outgoing";
  readonly message: JsonRpcMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function makeAcpWireRecorder() {
  const processes: Array<Array<WireMessage>> = [];
  const attachRuntime = () => {
    const wire: Array<WireMessage> = [];
    processes.push(wire);
    let incomingBuffer = "";
    const push = (direction: WireMessage["direction"], line: string) => {
      if (line.trim().length > 0) {
        wire.push({ direction, message: JSON.parse(line) as JsonRpcMessage });
      }
    };
    return {
      logIncoming: true,
      logOutgoing: true,
      logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
        Effect.sync(() => {
          if (event.stage !== "raw" || typeof event.payload !== "string") return;
          if (event.direction === "outgoing") {
            for (const line of event.payload.split("\n")) push("outgoing", line);
            return;
          }
          incomingBuffer += event.payload;
          const lines = incomingBuffer.split("\n");
          incomingBuffer = lines.pop() ?? "";
          for (const line of lines) push("incoming", line);
        }),
    };
  };
  return { processes, attachRuntime };
}

function frameLabel(kind: string, method: string, params: unknown) {
  const update = isRecord(params) && isRecord(params.update) ? params.update : undefined;
  return `${kind}:${method}${typeof update?.sessionUpdate === "string" ? `:${update.sessionUpdate}` : ""}`;
}

function processEntries(wire: ReadonlyArray<WireMessage>): Array<ProviderReplayEntry> {
  const entries: Array<ProviderReplayEntry> = [];
  const t3Requests = new Map<string, string>();
  const agentRequests = new Map<string, string>();
  for (const { direction, message } of wire) {
    const type = direction === "outgoing" ? "expect_outbound" : "emit_inbound";
    if (typeof message.method === "string") {
      const isRequest = message.id !== undefined && message.id !== null;
      if (isRequest) {
        (direction === "outgoing" ? t3Requests : agentRequests).set(
          String(message.id),
          message.method,
        );
      }
      const kind = isRequest ? "request" : "notification";
      entries.push({
        type,
        label: frameLabel(kind, message.method, message.params),
        frame: {
          kind,
          method: message.method,
          ...(message.params === undefined ? {} : { params: message.params }),
        },
      });
      continue;
    }
    const pending = direction === "outgoing" ? agentRequests : t3Requests;
    const method = pending.get(String(message.id));
    if (method === undefined) {
      throw new Error(`ACP recording received a response without a request: ${String(message.id)}`);
    }
    pending.delete(String(message.id));
    entries.push({
      type,
      label: `response:${method}`,
      frame: {
        kind: "response",
        method,
        ...(message.result === undefined ? {} : { result: message.result }),
        ...(message.error === undefined ? {} : { error: message.error }),
      },
    });
  }
  return entries;
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, map));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, mapStrings(entry, map)]),
  );
}

export function recordedAcpEntries(input: {
  readonly processes: ReadonlyArray<ReadonlyArray<WireMessage>>;
  readonly workspace: string;
  readonly home: string;
  readonly runtimeInstructions: string;
  readonly secret?: string;
}): Array<ProviderReplayEntry> {
  const entries = input.processes.flatMap((wire) => {
    const recorded = processEntries(wire);
    const closed = recorded.some(
      (entry) =>
        entry.type === "expect_outbound" &&
        isRecord(entry.frame) &&
        entry.frame.method === "session/close",
    );
    return [
      ...recorded,
      { type: "runtime_exit", status: closed ? "success" : "cancelled" } as const,
    ];
  });
  const sessionIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "runtime_exit" || !isRecord(entry.frame)) continue;
    for (const value of [entry.frame.params, entry.frame.result]) {
      if (isRecord(value) && typeof value.sessionId === "string") sessionIds.add(value.sessionId);
    }
  }
  const replacements: Array<readonly [string, string]> = [
    ...[...sessionIds].map(
      (id, index) =>
        [id, `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`] as const,
    ),
    [input.workspace, "<workspace>"],
    [encodeURIComponent(input.workspace), "%3Cworkspace%3E"],
    [input.home, "/home/acp-replay"],
    ...(input.secret ? ([[input.secret, "<credential>"]] as const) : []),
  ];
  const replaceAll = (text: string) =>
    replacements.reduce(
      (current, [from, to]) => (from.length > 0 ? current.replaceAll(from, to) : current),
      text,
    );
  return entries.map((entry) => {
    if (entry.type === "runtime_exit" || !isRecord(entry.frame)) return entry;
    let frame = entry.frame;
    if (entry.type === "expect_outbound" && isRecord(frame.params)) {
      const params = frame.params;
      if (frame.method === "initialize") {
        frame = {
          ...frame,
          params: { ...params, clientInfo: "<any>" },
        };
      } else if (["session/new", "session/load", "session/resume"].includes(String(frame.method))) {
        frame = { ...frame, params: { ...params, mcpServers: "<any>" } };
      } else if (frame.method === "session/prompt" && Array.isArray(params.prompt)) {
        frame = {
          ...frame,
          params: {
            ...params,
            prompt: params.prompt
              .filter(
                (part) =>
                  !(
                    isRecord(part) &&
                    part.type === "text" &&
                    part.text === input.runtimeInstructions
                  ),
              )
              .map((part) =>
                isRecord(part) && typeof part.text === "string"
                  ? {
                      ...part,
                      text: part.text.replace(
                        /<t3_code_instructions>\n[\s\S]*?\n<\/t3_code_instructions>/u,
                        "<t3_code_instructions>\n<any>\n</t3_code_instructions>",
                      ),
                    }
                  : part,
              ),
          },
        };
      }
    }
    return { ...entry, frame: mapStrings(frame, replaceAll) };
  });
}

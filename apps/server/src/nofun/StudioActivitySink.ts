// HTTP boundary for structural activity snapshots and owner-scoped list_events readback.
import { z } from "zod";
import {
  ActivityConflictError,
  canonicalActivityJson,
  type ActivityAcknowledgement,
  type StudioActivitySink,
} from "./StudioActivityPublisher.ts";

export const STUDIO_ACTIVITY_BRIDGE_URL_ENV = "NOFUN_STUDIO_BRIDGE_URL" as const;
export const STUDIO_ACTIVITY_BRIDGE_TOKEN_ENV = "NOFUN_STUDIO_BRIDGE_TOKEN" as const;
export const STUDIO_ACTIVITY_PRODUCERS_PATH = "/api/studio/producers" as const;
export const STUDIO_ACTIVITY_SEND_TIMEOUT_MS = 5_000;
const BODY_LIMIT = 256 * 1024;
const EXCERPT_LIMIT = 1024;

export interface StudioActivityBridgeConfig {
  readonly baseUrl: string;
  readonly token: string;
}
export type StudioActivityFetch = (url: string, init: RequestInit) => Promise<Response>;

export class StudioActivityTransportError extends Error {
  readonly kind: "http" | "network" | "timeout" | "ack_invalid" | "body_too_large";
  readonly status: number | null;
  readonly bodyExcerpt: string;
  constructor(
    kind: "http" | "network" | "timeout" | "ack_invalid" | "body_too_large",
    status: number | null = null,
    bodyExcerpt = "",
  ) {
    super(`studio_activity_${kind}${status === null ? "" : `_${status}`}`);
    this.kind = kind;
    this.status = status;
    this.bodyExcerpt = bodyExcerpt;
  }
}

const stampSchema = z.object({
  producer_id: z.string().min(1).max(200),
  epoch: z.string().min(1).max(200),
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  emitted_at: z.iso.datetime({ offset: true }),
});
const receiptSchema = z.object({
  eventId: z.string().min(1).max(200),
  verdict: z.enum(["accept", "replay_duplicate"]),
  stamp: stampSchema,
  payloadHash: z.string().min(1).max(64),
});
const conflictSchema = z.object({
  verdict: z.enum(["reject_stale", "reject_conflict", "reject_epoch_reset_required"]),
  stamp: stampSchema,
  payloadHash: z.string().min(1).max(64),
});
const watermarkSchema = receiptSchema.omit({ verdict: true });
const pageSchema = z.object({
  cursor: z.string().max(4096).nullable(),
  has_more: z.boolean(),
  watermark: watermarkSchema.nullable(),
  events: z
    .array(
      z.object({
        eventId: z.string().min(1).max(200),
        name: z.literal("studio.producer.accepted"),
        data: z.object({
          partition_id: z.literal("t3.activity"),
          stamp: stampSchema,
          payloadHash: z.string().min(1).max(64),
        }),
      }),
    )
    .max(100),
});

export function readStudioActivityBridgeConfig(
  env: Readonly<Record<string, string | undefined>>,
): StudioActivityBridgeConfig | null {
  const baseUrl = (env[STUDIO_ACTIVITY_BRIDGE_URL_ENV] ?? "").trim().replace(/\/+$/, "");
  const token = (env[STUDIO_ACTIVITY_BRIDGE_TOKEN_ENV] ?? "").trim();
  return baseUrl && token ? { baseUrl, token } : null;
}
export function studioActivityProducersUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${STUDIO_ACTIVITY_PRODUCERS_PATH}`;
}

export function makeStudioActivityHttpSink(options: {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchFn?: StudioActivityFetch | undefined;
  readonly timeoutMs?: number | undefined;
}): StudioActivitySink {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? STUDIO_ACTIVITY_SEND_TIMEOUT_MS;
  const url = studioActivityProducersUrl(options.baseUrl);
  // An error excerpt is returned to the caller but never logged by this boundary.
  const excerpt = (text: string) =>
    text
      .replaceAll(options.token, "[redacted]")
      .split("")
      .map((character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? " " : character,
      )
      .join("")
      .slice(0, EXCERPT_LIMIT);

  const request = async (
    target: string,
    init: RequestInit,
    allowConflict = false,
  ): Promise<{ value: unknown; status: number; text: string }> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let status: number | null = null;
    let text = "";
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new StudioActivityTransportError("timeout", status, excerpt(text)));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        deadline,
        (async () => {
          const response = await fetchFn(target, {
            ...init,
            headers: {
              Authorization: `Bearer ${options.token}`,
              "Content-Type": "application/json",
            },
            signal: controller.signal,
          });
          status = response.status;
          const parseBody = response.ok || (allowConflict && response.status === 409);
          const reader = response.body?.getReader();
          activeReader = reader;
          const decoder = new TextDecoder();
          let bytes = 0;
          try {
            if (reader)
              for (;;) {
                const part = await reader.read();
                if (part.done) break;
                bytes += part.value.byteLength;
                const limit = parseBody ? BODY_LIMIT : EXCERPT_LIMIT;
                text += decoder.decode(
                  part.value.subarray(0, Math.max(0, limit - (bytes - part.value.byteLength))),
                  { stream: true },
                );
                if (bytes >= limit) {
                  if (parseBody)
                    throw new StudioActivityTransportError("body_too_large", status, excerpt(text));
                  break;
                }
              }
            text += decoder.decode();
          } finally {
            if (reader) void reader.cancel().catch(() => {});
          }
          if (!parseBody) throw new StudioActivityTransportError("http", status, excerpt(text));
          let value: unknown;
          try {
            value = JSON.parse(text);
          } catch {
            throw new StudioActivityTransportError("ack_invalid", status, excerpt(text));
          }
          return { value, status, text };
        })(),
      ]);
    } catch (error) {
      if (error instanceof StudioActivityTransportError) throw error;
      throw new StudioActivityTransportError(
        controller.signal.aborted ? "timeout" : "network",
        status,
        excerpt(text),
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (activeReader) void activeReader.cancel().catch(() => {});
    }
  };
  return {
    send: async (input) => {
      const response = await request(url, { method: "POST", body: JSON.stringify(input) }, true);
      if (response.status === 409) {
        const conflict = conflictSchema.safeParse(response.value);
        if (!conflict.success)
          throw new StudioActivityTransportError(
            "ack_invalid",
            response.status,
            excerpt(response.text),
          );
        throw new ActivityConflictError(conflict.data.stamp, conflict.data.payloadHash);
      }
      const parsed = receiptSchema.safeParse(response.value);
      if (
        !parsed.success ||
        canonicalActivityJson(parsed.data.stamp) !== canonicalActivityJson(input.stamp) ||
        parsed.data.payloadHash !== input.payloadHash
      )
        throw new StudioActivityTransportError(
          "ack_invalid",
          response.status,
          excerpt(response.text),
        );
      return parsed.data;
    },
    readEvents: async (cursor, producerId) => {
      const query = new URLSearchParams({
        partition_id: "t3.activity",
        producer_id: producerId,
        limit: "100",
      });
      if (cursor !== null) query.set("cursor", cursor);
      const response = await request(`${url}?${query}`, { method: "GET" });
      const parsed = pageSchema.safeParse(response.value);
      if (!parsed.success)
        throw new StudioActivityTransportError(
          "ack_invalid",
          response.status,
          excerpt(response.text),
        );
      const receipt = (watermark: z.infer<typeof watermarkSchema>): ActivityAcknowledgement => ({
        ...watermark,
        verdict: "accept",
      });
      return {
        cursor: parsed.data.cursor,
        has_more: parsed.data.has_more,
        watermark: parsed.data.watermark ? receipt(parsed.data.watermark) : null,
        events: parsed.data.events.map((event) =>
          receipt({ eventId: event.eventId, ...event.data }),
        ),
      };
    },
  };
}

export const STUDIO_ACTIVITY_NOOP_SINK: StudioActivitySink = { send: () => {} };
export function makeStudioActivitySink(options: {
  readonly config: StudioActivityBridgeConfig | null;
  readonly fetchFn?: StudioActivityFetch | undefined;
  readonly timeoutMs?: number | undefined;
}): StudioActivitySink {
  return options.config
    ? makeStudioActivityHttpSink({
        ...options.config,
        fetchFn: options.fetchFn,
        timeoutMs: options.timeoutMs,
      })
    : STUDIO_ACTIVITY_NOOP_SINK;
}

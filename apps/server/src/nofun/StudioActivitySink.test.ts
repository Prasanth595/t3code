import { describe, expect, it } from "@effect/vitest";

import type { ActivityProducerInput } from "./StudioActivityPublisher.ts";
import {
  makeStudioActivitySink,
  readStudioActivityBridgeConfig,
  STUDIO_ACTIVITY_PRODUCERS_PATH,
  type StudioActivityFetch,
} from "./StudioActivitySink.ts";

const BASE_URL = "https://bridge.example";
const TOKEN = "tok-123-secret";

const NOW = "2026-10-12T00:00:00.000Z";

function envelope(): ActivityProducerInput {
  return {
    partition_id: "t3.activity",
    status: "online",
    stamp: {
      producer_id: "t3.activity-publisher",
      epoch: "epoch-test",
      sequence: 1,
      emitted_at: NOW,
    },
    payloadHash: "hash-1",
    observed_at: NOW,
    heartbeat_at: NOW,
    records: [],
    partial: false,
  };
}

describe("readStudioActivityBridgeConfig", () => {
  it("returns null unless both vars are set", () => {
    expect(readStudioActivityBridgeConfig({})).toBeNull();
    expect(readStudioActivityBridgeConfig({ NOFUN_STUDIO_BRIDGE_URL: BASE_URL })).toBeNull();
    expect(readStudioActivityBridgeConfig({ NOFUN_STUDIO_BRIDGE_TOKEN: TOKEN })).toBeNull();
    expect(
      readStudioActivityBridgeConfig({
        NOFUN_STUDIO_BRIDGE_URL: "   ",
        NOFUN_STUDIO_BRIDGE_TOKEN: TOKEN,
      }),
    ).toBeNull();
  });

  it("reads baseUrl and token from env only, with no default URL", () => {
    expect(
      readStudioActivityBridgeConfig({
        NOFUN_STUDIO_BRIDGE_URL: BASE_URL,
        NOFUN_STUDIO_BRIDGE_TOKEN: TOKEN,
      }),
    ).toEqual({ baseUrl: BASE_URL, token: TOKEN });
  });
});

describe("studio activity HTTP sink", () => {
  it("POSTs the envelope once with the bearer header", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn: StudioActivityFetch = async (url, init) => {
      calls.push({ url, init });
      return Response.json({
        verdict: "accept",
        eventId: "evt_one",
        stamp: envelope().stamp,
        payloadHash: "hash-1",
      });
    };
    const sink = makeStudioActivitySink({
      config: { baseUrl: BASE_URL, token: TOKEN },
      fetchFn,
    });
    const body = envelope();
    await sink.send(body);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE_URL}${STUDIO_ACTIVITY_PRODUCERS_PATH}`);
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(JSON.parse(JSON.stringify(body)));
    // The token travels in the header only, never in the body bytes.
    expect(String(calls[0]!.init.body)).not.toContain(TOKEN);
  });

  it("tolerates a trailing slash on the base URL", async () => {
    const seen: string[] = [];
    const sink = makeStudioActivitySink({
      config: { baseUrl: `${BASE_URL}//`, token: TOKEN },
      fetchFn: async (url) => {
        seen.push(url);
        return Response.json({
          verdict: "accept",
          eventId: "evt_one",
          stamp: envelope().stamp,
          payloadHash: "hash-1",
        });
      },
    });
    await sink.send(envelope());
    expect(seen).toEqual([`${BASE_URL}${STUDIO_ACTIVITY_PRODUCERS_PATH}`]);
  });

  it("is a no-op with zero fetch calls when unconfigured", async () => {
    let calls = 0;
    const sink = makeStudioActivitySink({
      config: null,
      fetchFn: async () => {
        calls += 1;
        return Response.json({
          verdict: "accept",
          eventId: "evt_one",
          stamp: envelope().stamp,
          payloadHash: "hash-1",
        });
      },
    });
    await sink.send(envelope());
    expect(calls).toBe(0);
  });

  it("reports non-2xx with a bounded response excerpt", async () => {
    const sink = makeStudioActivitySink({
      config: { baseUrl: BASE_URL, token: TOKEN },
      fetchFn: async () => new Response("overloaded " + "x".repeat(4000), { status: 503 }),
    });
    await expect(sink.send(envelope())).rejects.toMatchObject({
      kind: "http",
      status: 503,
      bodyExcerpt: expect.stringMatching(/^overloaded /),
    });
    try {
      await sink.send(envelope());
    } catch (error) {
      expect((error as { bodyExcerpt: string }).bodyExcerpt.length).toBeLessThanOrEqual(1024);
    }
  });

  it("surfaces network errors and enforces a deadline even for a stuck fetch", async () => {
    for (const [fetchFn, kind] of [
      [
        async () => {
          throw new Error("network down");
        },
        "network",
      ],
      [() => new Promise<Response>(() => {}), "timeout"],
    ] as const) {
      const sink = makeStudioActivitySink({
        config: { baseUrl: BASE_URL, token: TOKEN },
        fetchFn,
        timeoutMs: 10,
      });
      await expect(sink.send(envelope())).rejects.toMatchObject({ kind });
    }
  });

  it("requires observed bridge acceptance, including the event ID and exact stamp/hash", async () => {
    for (const body of [
      {},
      { verdict: "accept", stamp: envelope().stamp, payloadHash: "hash-1" },
      {
        verdict: "accept",
        eventId: "evt_one",
        stamp: { ...envelope().stamp, sequence: 2 },
        payloadHash: "hash-1",
      },
    ]) {
      const sink = makeStudioActivitySink({
        config: { baseUrl: BASE_URL, token: TOKEN },
        fetchFn: async () => Response.json(body),
      });
      await expect(sink.send(envelope())).rejects.toMatchObject({ kind: "ack_invalid" });
    }
  });
  it("bounds body reads and times out after headers while releasing the stream", async () => {
    let cancelled = false;
    const sink = makeStudioActivitySink({
      config: { baseUrl: BASE_URL, token: TOKEN },
      timeoutMs: 10,
      fetchFn: async () =>
        new Response(
          new ReadableStream({
            cancel: () => {
              cancelled = true;
            },
          }),
        ),
    });
    await expect(sink.send(envelope())).rejects.toMatchObject({ kind: "timeout", status: 200 });
    expect(cancelled).toBe(true);
  });

  it("redacts the configured credential from failure excerpts", async () => {
    const sink = makeStudioActivitySink({
      config: { baseUrl: BASE_URL, token: TOKEN },
      fetchFn: async () => new Response(`bad ${TOKEN}`, { status: 401 }),
    });
    await expect(sink.send(envelope())).rejects.toMatchObject({
      kind: "http",
      status: 401,
      bodyExcerpt: "bad [redacted]",
    });
  });

  it("passes the opaque cursor through readback and decodes acceptance metadata", async () => {
    let target = "";
    const sink = makeStudioActivitySink({
      config: { baseUrl: BASE_URL, token: TOKEN },
      fetchFn: async (url) => {
        target = url;
        return Response.json({
          cursor: "next",
          has_more: true,
          watermark: { eventId: "evt_current", stamp: envelope().stamp, payloadHash: "hash-1" },
          events: [
            {
              eventId: "evt_first",
              name: "studio.producer.accepted",
              data: { partition_id: "t3.activity", stamp: envelope().stamp, payloadHash: "hash-1" },
            },
          ],
        });
      },
    });
    const page = await sink.readEvents!("opaque+/=", "t3.activity-publisher");
    expect(new URL(target).searchParams.get("cursor")).toBe("opaque+/=");
    expect(page).toMatchObject({
      cursor: "next",
      has_more: true,
      watermark: { eventId: "evt_current" },
      events: [{ eventId: "evt_first", verdict: "accept" }],
    });
  });
});

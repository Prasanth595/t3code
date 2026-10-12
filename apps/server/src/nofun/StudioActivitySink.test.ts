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
  it("releases the unused response body before completing delivery", async () => {
    let cancelled = false;
    const sink = makeStudioActivitySink({
      config: { baseUrl: BASE_URL, token: TOKEN },
      fetchFn: async () =>
        new Response(
          new ReadableStream({
            cancel: () => {
              cancelled = true;
            },
          }),
        ),
    });
    await sink.send(envelope());
    expect(cancelled).toBe(true);
  });

  it("POSTs the envelope once with the bearer header", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn: StudioActivityFetch = async (url, init) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
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
        return new Response("{}", { status: 200 });
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
        return new Response("{}", { status: 200 });
      },
    });
    await sink.send(envelope());
    expect(calls).toBe(0);
  });

  it("swallows network failures, non-2xx and timeouts", async () => {
    const hanging: StudioActivityFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    const failing: StudioActivityFetch = async () => {
      throw new Error("network down");
    };
    const serverError: StudioActivityFetch = async () => new Response("boom", { status: 500 });
    for (const fetchFn of [hanging, failing, serverError]) {
      const sink = makeStudioActivitySink({
        config: { baseUrl: BASE_URL, token: TOKEN },
        fetchFn,
        timeoutMs: 50,
      });
      await sink.send(envelope());
    }
  });
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import {
  DrainClient,
  type AdmissionDrainStatus,
  type DrainRequestError,
  type DrainTimeoutError,
} from "./DrainClient.ts";

interface RecordedCall {
  method: string;
  url: string;
  authorization: string | null;
}

type ScriptedBody = AdmissionDrainStatus | { status: number; body: unknown };

const idle: AdmissionDrainStatus = { draining: true, running: 0, queued: 0 };
const reopened: AdmissionDrainStatus = { draining: false, running: 0, queued: 2 };

/** Scripted in-process fake server: answers requests in order and records them. */
const scriptedLayer = (script: ScriptedBody[], recorded: RecordedCall[]) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        recorded.push({
          method: request.method,
          url: new URL(request.url).pathname,
          authorization:
            request.headers["authorization"] ?? request.headers["Authorization"] ?? null,
        });
        const next = script.shift();
        if (next === undefined) throw new Error(`Unexpected request to ${request.url}`);
        const [status, body] = "status" in next ? [next.status, next.body] : [200, next];
        return HttpClientResponse.fromWeb(request, Response.json(body, { status }));
      })
    ),
  );

const scripted = (script: ScriptedBody[], recorded: RecordedCall[]) =>
  scriptedLayer(script, recorded);

const recordedCalls = (recorded: RecordedCall[]): string[] =>
  recorded.map((call) => `${call.method} ${call.url}`);

function expectDrainTimeout(
  failure: DrainRequestError | DrainTimeoutError,
): asserts failure is DrainTimeoutError {
  if (failure._tag !== "DrainTimeoutError") assert.fail(`expected DrainTimeoutError, got ${failure._tag}`);
}

function expectDrainRequest(
  failure: DrainRequestError | DrainTimeoutError,
): asserts failure is DrainRequestError {
  if (failure._tag !== "DrainRequestError") assert.fail(`expected DrainRequestError, got ${failure._tag}`);
}

it.live("drains, polls running 2→1→0, resolves, then resumes", () =>
  Effect.gen(function* () {
    const recorded: RecordedCall[] = [];
    const script: ScriptedBody[] = [
      { draining: false, running: 2, queued: 1 },
      { draining: true, running: 2, queued: 1 },
      { draining: true, running: 2, queued: 1 },
      { draining: true, running: 1, queued: 1 },
      { draining: true, running: 0, queued: 2 },
      reopened,
    ];
    const client = new DrainClient({
      baseUrl: "http://127.0.0.1:4317",
      getToken: Effect.succeed("operator-token"),
    });
    assert.deepStrictEqual(
      yield* client
        .drainAndWait({ timeoutMs: 10_000, pollMs: 1 })
        .pipe(Effect.provide(scripted(script, recorded))),
      { draining: true, running: 0, queued: 2 },
    );
    assert.deepStrictEqual(recordedCalls(recorded), [
      "GET /api/local/admission/status",
      "POST /api/local/admission/drain",
      "GET /api/local/admission/status",
      "GET /api/local/admission/status",
      "GET /api/local/admission/status",
    ]);
    assert.isTrue(recorded.every((call) => call.authorization === "Bearer operator-token"));

    const resumed = yield* client.resume().pipe(Effect.provide(scripted([reopened], recorded)));
    assert.deepStrictEqual(resumed, reopened);
    assert.deepStrictEqual(recorded.at(-1), {
      method: "POST",
      url: "/api/local/admission/resume",
      authorization: "Bearer operator-token",
    });
  }));

it.live("resumes after a timeout, then raises a typed error", () =>
  Effect.gen(function* () {
    const recorded: RecordedCall[] = [];
    const script: ScriptedBody[] = [
      { draining: false, running: 1, queued: 0 },
      { draining: true, running: 1, queued: 0 },
      ...Array.from({ length: 60 }, () => ({ ...idle, running: 1 })),
      { draining: false, running: 1, queued: 0 },
    ];
    const client = new DrainClient({ baseUrl: "http://127.0.0.1:4317/" });
    const failure = yield* client
      .drainAndWait({ timeoutMs: 120, pollMs: 5 })
      .pipe(Effect.provide(scripted(script, recorded)), Effect.flip);
    expectDrainTimeout(failure);
    assert.deepStrictEqual(failure.lastStatus, { draining: true, running: 1, queued: 0 });
    assert.deepStrictEqual(recorded.at(-1), {
      method: "POST",
      url: "/api/local/admission/resume",
      authorization: null,
    });
  }));

it.live("surfaces a rejected drain as an error without resume", () =>
  Effect.gen(function* () {
    const recorded: RecordedCall[] = [];
    const script: ScriptedBody[] = [
      { draining: false, running: 0, queued: 0 },
      { status: 403, body: { code: "loopback_required" } },
    ];
    const client = new DrainClient({ baseUrl: "http://127.0.0.1:4317" });
    const failure = yield* client
      .drainAndWait({ timeoutMs: 1_000 })
      .pipe(Effect.provide(scripted(script, recorded)), Effect.flip);
    expectDrainRequest(failure);
    assert.strictEqual(failure.reason, "rejected");
    assert.strictEqual(failure.status, 403);
    assert.strictEqual(failure.code, "loopback_required");
    assert.deepStrictEqual(recordedCalls(recorded), [
      "GET /api/local/admission/status",
      "POST /api/local/admission/drain",
    ]);
  }));

it.live("keeps waiting while status is not draining", () =>
  Effect.gen(function* () {
    const recorded: RecordedCall[] = [];
    const script: ScriptedBody[] = [
      { draining: false, running: 3, queued: 0 },
      { draining: false, running: 3, queued: 0 },
      { draining: false, running: 2, queued: 0 },
      idle,
    ];
    const client = new DrainClient({ baseUrl: "http://127.0.0.1:4317" });
    assert.deepStrictEqual(
      yield* client
        .waitIdle({ timeoutMs: 10_000, pollMs: 1 })
        .pipe(Effect.provide(scripted(script, recorded))),
      idle,
    );
    assert.strictEqual(recorded.length, 4);
  }));

it.live("does not resume another owner's drain on timeout", () =>
  Effect.gen(function* () {
    const recorded: RecordedCall[] = [];
    const script: ScriptedBody[] = [
      { draining: true, running: 1, queued: 0 },
      { draining: true, running: 1, queued: 0 },
      ...Array.from({ length: 60 }, () => ({ ...idle, running: 1 })),
    ];
    const client = new DrainClient({ baseUrl: "http://127.0.0.1:4317" });
    const failure = yield* client
      .drainAndWait({ timeoutMs: 80, pollMs: 5 })
      .pipe(Effect.provide(scripted(script, recorded)), Effect.flip);
    expectDrainTimeout(failure);
    assert.notInclude(recordedCalls(recorded), "POST /api/local/admission/resume");
  }));

it.live("treats resume as idempotent", () =>
  Effect.gen(function* () {
    const recorded: RecordedCall[] = [];
    const script: ScriptedBody[] = [reopened, reopened];
    const client = new DrainClient({ baseUrl: "http://127.0.0.1:4317" });
    assert.deepStrictEqual(
      yield* client.resume().pipe(Effect.provide(scripted(script, recorded))),
      reopened,
    );
    assert.deepStrictEqual(
      yield* client.resume().pipe(Effect.provide(scripted(script, recorded))),
      reopened,
    );
    assert.deepStrictEqual(recordedCalls(recorded), [
      "POST /api/local/admission/resume",
      "POST /api/local/admission/resume",
    ]);
  }));

it.live("rejects a malformed status shape as a typed error", () =>
  Effect.gen(function* () {
    const recorded: RecordedCall[] = [];
    const script: ScriptedBody[] = [
      { status: 200, body: { draining: true, running: "zero", queued: 0 } },
    ];
    const client = new DrainClient({ baseUrl: "http://127.0.0.1:4317" });
    const failure = yield* client
      .status()
      .pipe(Effect.provide(scripted(script, recorded)), Effect.flip);
    expectDrainRequest(failure);
    assert.strictEqual(failure.reason, "response");
  }));

it.live("refuses a non-loopback base URL before sending anything", () =>
  Effect.gen(function* () {
    let sends = 0;
    const probing = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() =>
        Effect.sync(() => {
          sends += 1;
          throw new Error("must not send");
        })
      ),
    );
    const client = new DrainClient({
      baseUrl: "https://example.com",
      getToken: Effect.succeed("must-never-be-sent"),
    });
    const failure = yield* client.drain().pipe(Effect.provide(probing), Effect.flip);
    expectDrainRequest(failure);
    assert.strictEqual(failure.reason, "config");
    assert.strictEqual(sends, 0);
  }));

import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import { codexSupportsRealtimeVoice, makeCodexRealtimeVoice } from "./CodexRealtimeVoice.ts";

const instanceId = ProviderInstanceId.make("codex");
const fixtures = `${import.meta.dirname}/testFixtures`;
const provider = (auth: ServerProvider["auth"]) => ({ auth }) as ServerProvider;

const setup = Effect.fn("CodexRealtimeVoice.test.setup")(function* (
  accountType: string,
  options: {
    readonly voice?: string;
    readonly instructions?: string;
    readonly enabled?: boolean;
  } = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codex-realtime-" });
  const logPath = path.join(dir, "requests.ndjson");
  yield* fileSystem.writeFileString(logPath, "");
  const voiceScope = yield* Scope.make();
  const voice = yield* makeCodexRealtimeVoice({
    instanceId,
    launch: {
      binaryPath: `${fixtures}/codexRealtimeMockPeer.sh`,
      environment: { T3_CODEX_REALTIME_LOG: logPath, T3_CODEX_REALTIME_ACCOUNT: accountType },
    },
    launchArgs: "",
    enabled: options.enabled ?? true,
    voice: options.voice ?? "",
    instructions: options.instructions ?? "",
  }).pipe(Scope.provide(voiceScope));
  const requests = () =>
    fileSystem.readFileString(logPath).pipe(
      Effect.map((text) =>
        text
          .split("\n")
          .filter(Boolean)
          .map(
            (line) =>
              JSON.parse(line) as {
                method: string;
                params: Record<string, unknown>;
                args: string[];
              },
          ),
      ),
    );
  return { voice, requests, voiceScope };
});

describe("CodexRealtimeVoice", () => {
  it.effect(
    "relays the offer over WebRTC on a read-only ephemeral thread and returns the answer",
    () =>
      Effect.gen(function* () {
        const { voice, requests } = yield* setup("chatgpt");
        const { sessionId, answerSdp } = yield* voice.start({ sdp: "offer-sdp", cwd: "/tmp" });
        expect(answerSdp).toBe("answer-for:offer-sdp");

        const received = yield* requests();
        expect(received.find((r) => r.method === "initialize")?.args).toEqual([
          "--enable",
          "realtime_conversation",
          "-c",
          "forced_login_method=chatgpt",
        ]);
        expect(received.find((r) => r.method === "thread/start")?.params).toMatchObject({
          ephemeral: true,
          sandbox: "read-only",
          approvalPolicy: "never",
        });
        expect(received.find((r) => r.method === "thread/realtime/start")?.params).toMatchObject({
          threadId: "voice-thread",
          outputModality: "audio",
          version: "v3",
          transport: { type: "webrtc", sdp: "offer-sdp" },
        });
        expect(sessionId).not.toBe("");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "gives the voice agent the thread's MCP server and releases it when the call ends",
    () =>
      Effect.gen(function* () {
        const { voice, requests, voiceScope } = yield* setup("chatgpt");
        let released = 0;
        yield* voice.start({
          sdp: "offer-sdp",
          thread: {
            instructions: "speak for the thread",
            mcp: { endpoint: "http://127.0.0.1/mcp", authorizationHeader: "Bearer secret" },
            tools: ["t3_thread_read"],
            transcript: () => Effect.void,
            release: Effect.sync(() => void released++),
          },
        });
        const received = yield* requests();
        expect(received.find((r) => r.method === "thread/start")?.params).toMatchObject({
          config: {
            "mcp_servers.t3-code": {
              url: "http://127.0.0.1/mcp",
              http_headers: { Authorization: "Bearer secret" },
            },
          },
        });
        expect(received.find((r) => r.method === "thread/realtime/start")?.params).toMatchObject({
          realtimeStartInstructions: "speak for the thread",
        });
        expect(released).toBe(0);
        yield* Scope.close(voiceScope, Exit.void);
        expect(released).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("passes spoken lines on as they stream and again when finished", () =>
    Effect.gen(function* () {
      const { voice } = yield* setup("chatgpt");
      const lines = yield* Queue.unbounded<{ role: string; text: string; final: boolean }>();
      yield* voice.start({
        sdp: "offer-sdp",
        thread: {
          instructions: "",
          mcp: { endpoint: "http://127.0.0.1/mcp", authorizationHeader: "Bearer secret" },
          tools: [],
          transcript: (line) => Queue.offer(lines, line),
          release: Effect.void,
        },
      });
      expect(yield* Effect.forEach([1, 2, 3, 4], () => Queue.take(lines))).toEqual([
        { role: "user", text: "hel", final: false },
        { role: "user", text: "lo", final: false },
        { role: "user", text: "hello", final: true },
        { role: "assistant", text: "hi there", final: true },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("applies the instance's voice and instructions to the call", () =>
    Effect.gen(function* () {
      const { voice, requests } = yield* setup("chatgpt", {
        voice: "sol",
        instructions: "Answer in Portuguese.",
      });
      yield* voice.start({
        sdp: "offer-sdp",
        thread: {
          instructions: "speak for the thread",
          mcp: { endpoint: "http://127.0.0.1/mcp", authorizationHeader: "Bearer secret" },
          tools: ["t3_thread_read"],
          transcript: () => Effect.void,
          release: Effect.void,
        },
      });
      const start = (yield* requests()).find((r) => r.method === "thread/realtime/start");
      expect(start?.params).toMatchObject({
        voice: "sol",
        realtimeStartInstructions: "speak for the thread\n\nAnswer in Portuguese.",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lets a call pick its own voice over the instance's", () =>
    Effect.gen(function* () {
      const { voice, requests } = yield* setup("chatgpt", { voice: "sol" });
      yield* voice.start({ sdp: "offer-sdp", voice: "cove" });
      const start = (yield* requests()).find((r) => r.method === "thread/realtime/start");
      expect(start?.params).toMatchObject({ voice: "cove" });
      expect(voice.voices).toContain("cove");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("stops the provider session when the voice service shuts down", () =>
    Effect.gen(function* () {
      const { voice, requests, voiceScope } = yield* setup("chatgpt");
      yield* voice.start({ sdp: "offer-sdp" });
      yield* Scope.close(voiceScope, Exit.void);
      expect((yield* requests()).map((r) => r.method)).toContain("thread/realtime/stop");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses accounts that are not signed in with ChatGPT", () =>
    Effect.gen(function* () {
      const { voice } = yield* setup("apiKey");
      const exit = yield* Effect.exit(voice.start({ sdp: "offer-sdp" }));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain("signed in with a ChatGPT subscription");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses calls on instances that turned voice calls off", () =>
    Effect.gen(function* () {
      const { voice } = yield* setup("chatgpt", { enabled: false });
      const exit = yield* Effect.exit(voice.start({ sdp: "offer-sdp" }));
      expect(String(exit)).toContain("This provider is disabled");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("limits concurrent calls per instance", () =>
    Effect.gen(function* () {
      const { voice } = yield* setup("chatgpt");
      yield* voice.start({ sdp: "first" });
      yield* voice.start({ sdp: "second" });
      const exit = yield* Effect.exit(voice.start({ sdp: "third" }));
      expect(String(exit)).toContain("Too many voice calls");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("offers calls only on instances that have voice calls turned on", () =>
    Effect.gen(function* () {
      const chatgpt = provider({ status: "authenticated", type: "chatgpt" });
      expect((yield* setup("chatgpt")).voice.supports(chatgpt)).toBe(true);
      expect((yield* setup("chatgpt", { enabled: false })).voice.supports(chatgpt)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("supports only authenticated ChatGPT accounts", () => {
    expect(codexSupportsRealtimeVoice(provider({ status: "authenticated", type: "chatgpt" }))).toBe(
      true,
    );
    expect(codexSupportsRealtimeVoice(provider({ status: "authenticated", type: "apiKey" }))).toBe(
      false,
    );
    expect(codexSupportsRealtimeVoice(provider({ status: "unauthenticated" }))).toBe(false);
  });
});

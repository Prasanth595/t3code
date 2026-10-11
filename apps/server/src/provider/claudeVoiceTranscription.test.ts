import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Socket from "effect/socket/Socket";
import { describe, expect } from "vite-plus/test";

import { transcribeClaudeAudio } from "./claudeVoiceTranscription.ts";

type Reply = { readonly text?: Array<string>; readonly frame?: string; readonly close?: number };

/** Answers like Anthropic's socket: nothing until `CloseStream`, then the scripted reply. */
class FakeVoiceSocket extends EventTarget {
  readyState = 0;
  readonly sent: Array<string | Uint8Array> = [];
  readonly url: string;
  readonly headers: Readonly<Record<string, string>> | undefined;
  private readonly reply: Reply;

  constructor(url: string, headers: Readonly<Record<string, string>> | undefined, reply: Reply) {
    super();
    this.url = url;
    this.headers = headers;
    this.reply = reply;
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data: string | Uint8Array) {
    this.sent.push(data);
    if (data !== '{"type":"CloseStream"}') return;
    queueMicrotask(() => {
      for (const text of this.reply.text ?? []) {
        this.message(JSON.stringify({ type: "TranscriptText", data: text }));
      }
      if (this.reply.frame) this.message(this.reply.frame);
      if (this.reply.close) this.close(this.reply.close);
      else this.message('{"type": "TranscriptEndpoint"}');
    });
  }

  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason: "" }));
  }

  private message(data: string) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

const withLogin = (credentials: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(path.join(directory, ".credentials.json"), credentials);
    return directory;
  });

const transcribe = (configDir: string, reply: Reply, audio = new Uint8Array(8_000)) => {
  const sockets: Array<FakeVoiceSocket> = [];
  return transcribeClaudeAudio({ configDir, version: "2.1.0", audio, language: "en" }).pipe(
    Effect.provideService(Socket.WebSocketConstructor, (url, options) => {
      const headers =
        typeof options === "object" && !Array.isArray(options) ? options.headers : undefined;
      const socket = new FakeVoiceSocket(url, headers, reply);
      sockets.push(socket);
      return socket;
    }),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.map((text) => ({ text, sockets })),
  );
};

const LOGIN = '{"claudeAiOauth":{"accessToken":"oauth-token"}}';

effectIt.layer(NodeServices.layer)("transcribeClaudeAudio", (it) => {
  describe("transcribeClaudeAudio", () => {
    it.effect("streams the recording in 100 ms frames with the CLI's login", () =>
      Effect.gen(function* () {
        const configDir = yield* withLogin(LOGIN);
        const { text, sockets } = yield* transcribe(configDir, {
          text: ["Hello there.", " Ship it. "],
        });

        expect(text).toBe("Hello there. Ship it.");
        const [socket] = sockets;
        const url = new URL(socket!.url);
        expect(url.origin + url.pathname).toBe(
          "wss://api.anthropic.com/api/ws/speech_to_text/voice_stream",
        );
        expect(Object.fromEntries(url.searchParams)).toMatchObject({
          encoding: "linear16",
          sample_rate: "16000",
          channels: "1",
          language: "en",
        });
        expect(socket!.headers?.authorization).toBe("Bearer oauth-token");
        expect(socket!.sent[0]).toBe('{"type":"KeepAlive"}');
        expect(socket!.sent.at(-1)).toBe('{"type":"CloseStream"}');
        // 8,000 bytes is 250 ms of audio: two full frames and a half frame.
        expect(socket!.sent.slice(1, -1).map((frame) => frame.length)).toEqual([
          3_200, 3_200, 1_600,
        ]);
      }).pipe(Effect.scoped),
    );

    it.effect("keeps what arrived when Claude closes without an endpoint", () =>
      Effect.gen(function* () {
        const configDir = yield* withLogin(LOGIN);
        const { text } = yield* transcribe(configDir, { text: ["Partial"], close: 1000 });
        expect(text).toBe("Partial");
      }).pipe(Effect.scoped),
    );

    it.effect("fails on a transcription error or an abnormal close", () =>
      Effect.gen(function* () {
        const configDir = yield* withLogin(LOGIN);
        const errorFrame = yield* transcribe(configDir, {
          frame: '{"type":"TranscriptError","description":"bad audio"}',
        }).pipe(Effect.flip);
        expect(errorFrame.reason).toBe("requestFailed");
        const dropped = yield* transcribe(configDir, { text: ["Lost"], close: 1011 }).pipe(
          Effect.flip,
        );
        expect(dropped.reason).toBe("requestFailed");
      }).pipe(Effect.scoped),
    );

    it.effect("asks for a Claude login without dialing when none is stored", () =>
      Effect.gen(function* () {
        const configDir = yield* withLogin("{}");
        const error = yield* transcribeClaudeAudio({
          configDir,
          version: "2.1.0",
          audio: new Uint8Array(3_200),
          language: "en",
        }).pipe(
          Effect.provideService(Socket.WebSocketConstructor, () => {
            throw new Error("must not dial");
          }),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.flip,
        );
        expect(error.reason).toBe("signedOut");
      }).pipe(Effect.scoped),
    );
  });
});

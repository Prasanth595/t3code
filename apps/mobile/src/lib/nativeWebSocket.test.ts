import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";
import { vi } from "vite-plus/test";

// Stands in for URLSessionWebSocketTask: it opens on connect, echoes every
// frame and acknowledges a close, as a server would.
const native = vi.hoisted(() => {
  type Payload = Record<string, unknown> & { readonly id: number };
  const listeners = new Map<string, (payload: Payload) => void>();
  const state = { connected: true, lastId: 0, dialed: [] as Array<string> };
  const emit = (event: string, payload: Payload) => listeners.get(event)?.(payload);
  return {
    state,
    emit,
    setup() {
      state.connected = true;
      state.dialed = [];
    },
    module: {
      connect(id: number, url: string) {
        state.lastId = id;
        state.dialed.push(url);
        if (state.connected) emit("onOpen", { id });
      },
      sendText(id: number, text: string) {
        emit("onMessage", { id, data: text, binary: false });
      },
      sendBinary(id: number, base64: string) {
        emit("onMessage", { id, data: base64, binary: true });
      },
      close(id: number, code: number, reason: string) {
        if (state.connected) emit("onClose", { id, code, reason });
      },
      addListener(event: string, listener: (payload: Payload) => void) {
        listeners.set(event, listener);
        return { remove: () => listeners.delete(event) };
      },
    },
  };
});

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo", () => ({
  requireOptionalNativeModule: (name: string) => (name === "T3WebSocket" ? native.module : null),
}));

import { layerWebSocketConstructor } from "./nativeWebSocket";

describe("iOS WebSocket constructor", () => {
  it.effect("dials through URLSession and round-trips text and binary frames", () =>
    Effect.gen(function* () {
      native.setup();
      const socket = yield* Socket.makeWebSocket("wss://host.test/ws");
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;

      yield* writer.write("ping");
      yield* writer.write(new Uint8Array([1, 2, 3]));
      const frames: Array<string | Uint8Array> = [];
      while (frames.length < 2) frames.push(...(yield* reader.pull));

      expect(native.state.dialed).toEqual(["wss://host.test/ws"]);
      expect(frames[0]).toBe("ping");
      expect([...(frames[1] as Uint8Array)]).toEqual([1, 2, 3]);
    }).pipe(Effect.scoped, Effect.provide(layerWebSocketConstructor)),
  );

  it.effect("passes a server close code to Effect", () =>
    Effect.gen(function* () {
      native.setup();
      const socket = yield* Socket.makeWebSocket("wss://host.test/ws");
      const reader = yield* socket.reader;

      native.emit("onClose", { id: native.state.lastId, code: 4001, reason: "bye" });
      const error = yield* Effect.flip(reader.pull);

      expect(error.reason).toMatchObject({ _tag: "SocketCloseError", code: 4001 });
    }).pipe(Effect.scoped, Effect.provide(layerWebSocketConstructor)),
  );

  it.effect("ignores a native open that lands after close", () =>
    Effect.gen(function* () {
      native.setup();
      native.state.connected = false;
      const makeWebSocket = yield* Socket.WebSocketConstructor;
      const socket = makeWebSocket("wss://host.test/ws");
      const opened: Array<unknown> = [];
      socket.addEventListener("open", (event) => opened.push(event));

      // Effect closes a socket that is still connecting on open timeout or
      // scope teardown, and URLSession can still report the open afterwards.
      socket.close(1000);
      native.emit("onOpen", { id: native.state.lastId });

      expect(opened).toEqual([]);
      expect(socket.readyState).toBe(2);
    }).pipe(Effect.provide(layerWebSocketConstructor)),
  );
});

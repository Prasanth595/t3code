import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

const { channels } = vi.hoisted(() => ({
  channels: [] as Array<{
    reply: (data: string) => void;
    released: Array<unknown>;
    closed: boolean;
  }>,
}));

vi.mock("electron", () => ({
  MessageChannelMain: class {
    port1;
    port2 = {};
    constructor() {
      let listener: (event: { data: string }) => void = () => undefined;
      const channel = {
        reply: (data: string) => listener({ data }),
        released: [] as Array<unknown>,
        closed: false,
      };
      channels.push(channel);
      this.port1 = {
        on: (_event: string, handle: typeof listener) => {
          listener = handle;
        },
        start: () => undefined,
        postMessage: (value: unknown) => channel.released.push(value),
        close: () => {
          channel.closed = true;
        },
      };
    }
  },
}));

import { prepareGuestCapture } from "./prepareGuestCapture.ts";

const fixture = () => {
  let requested: ((tabId: string) => void) | undefined;
  const request = new Promise<string>((resolve) => {
    requested = resolve;
  });
  const guest = {
    hostWebContents: {
      isDestroyed: () => false,
      postMessage: (_channel: string, tabId: string) => requested?.(tabId),
    },
  } as unknown as Electron.WebContents;
  return { guest, request };
};

describe("prepareGuestCapture", () => {
  it.effect("holds the renderer's activity until the capture releases it", () =>
    Effect.gen(function* () {
      const { guest, request } = fixture();
      const preparing = yield* prepareGuestCapture(guest, "background-tab").pipe(Effect.forkScoped);
      expect(yield* Effect.promise(() => request)).toBe("background-tab");
      const channel = channels.at(-1)!;
      expect(channel.released).toEqual([]);
      channel.reply("ready");
      const release = yield* Fiber.join(preparing);
      expect(channel.closed).toBe(false);
      release();
      expect(channel.released).toEqual(["release"]);
      expect(channel.closed).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("releases a request when its renderer does not acknowledge it", () =>
    Effect.gen(function* () {
      const { guest, request } = fixture();
      const preparing = yield* prepareGuestCapture(guest, "background-tab").pipe(
        Effect.result,
        Effect.forkScoped,
      );
      yield* Effect.promise(() => request);
      const channel = channels.at(-1)!;
      yield* TestClock.adjust(2_000);
      expect((yield* Fiber.join(preparing))._tag).toBe("Failure");
      expect(channel.released).toEqual(["release"]);
      expect(channel.closed).toBe(true);
    }).pipe(Effect.scoped),
  );
});

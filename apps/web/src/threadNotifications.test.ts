import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const SOUND_SECONDS = 0.6;

const audio = { currentTime: 0, started: 0 };

class FakeAudioContext {
  state = "running";
  destination = {};
  get currentTime() {
    return audio.currentTime;
  }
  resume() {
    return Promise.resolve();
  }
  decodeAudioData() {
    return Promise.resolve({ duration: SOUND_SECONDS });
  }
  createBufferSource() {
    return {
      buffer: null,
      connect() {},
      start() {
        audio.started += 1;
      },
    };
  }
}

async function loadUnlocked() {
  const notifications = await import("./threadNotifications");
  notifications.unlockNotificationAudio();
  return notifications;
}

beforeEach(() => {
  vi.resetModules();
  audio.currentTime = 0;
  audio.started = 0;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(0) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("playNotificationSound", () => {
  it("plays one sound for threads that complete together", async () => {
    const { playNotificationSound } = await loadUnlocked();

    // All four are waiting on the first decode when the sound becomes playable.
    await Promise.all(
      Array.from({ length: 4 }, () => playNotificationSound("completion", () => true)),
    );

    expect(audio.started).toBe(1);
  });

  it("skips a completion that lands while the sound is still playing", async () => {
    const { playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", () => true);

    audio.currentTime = SOUND_SECONDS / 2;
    await playNotificationSound("completion", () => true);

    expect(audio.started).toBe(1);
  });

  it("plays again once the previous sound has ended", async () => {
    const { playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", () => true);

    audio.currentTime = SOUND_SECONDS;
    await playNotificationSound("completion", () => true);

    expect(audio.started).toBe(2);
  });

  it("still plays an input alert over a completion sound", async () => {
    const { playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", () => true);

    await playNotificationSound("input", () => true);

    expect(audio.started).toBe(2);
  });

  it("leaves the slot free when a sound is turned off before it plays", async () => {
    const { playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", () => false);

    await playNotificationSound("completion", () => true);

    expect(audio.started).toBe(1);
  });
});

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { threadNotificationTag } from "./threadNotifications";

const environmentId = "fd6fff30-f90b-4ee7-9812-4cf497791b90" as EnvironmentId;
const otherEnvironmentId = "25b62992-b996-4ee3-8d82-d988840e45c1" as EnvironmentId;
const threadId = "a8395a98-a186-4fe7-9d4c-fb8ba63b7588" as ThreadId;
const otherThreadId = "257598ad-ae4f-4422-a073-e03f4b4f5f0d" as ThreadId;

describe("threadNotificationTag", () => {
  it("returns a stable tag within the platform budget", () => {
    const tag = threadNotificationTag(environmentId, threadId);
    expect(tag).toMatch(/^[0-9a-f]{16}$/);
    expect(threadNotificationTag(environmentId, threadId)).toBe(tag);
  });

  it("separates environments and threads", () => {
    const tag = threadNotificationTag(environmentId, threadId);
    expect(threadNotificationTag(otherEnvironmentId, threadId)).not.toBe(tag);
    expect(threadNotificationTag(environmentId, otherThreadId)).not.toBe(tag);
  });
});

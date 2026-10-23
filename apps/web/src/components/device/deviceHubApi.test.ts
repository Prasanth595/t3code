import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { subscribeDeviceForeground } from "./deviceHubApi";

describe("foreground app events", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const androidTarget = {
    platform: "android" as const,
    deviceId: "physical:5555",
    access: {
      httpBase: "https://remote.test/api/device-hub",
      wsBase: "wss://remote.test/api/device-hub",
      query: { hostId: "remote", wsTicket: "test-ticket" },
      credentials: true,
    },
  };

  it("refreshes Android foreground apps and clears stale state after errors or no focused app", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ ok: true, app: { packageName: "com.example.first", pid: 42 } }),
      )
      .mockResolvedValueOnce(
        Response.json({ ok: true, app: { packageName: "com.example.second", label: "Second" } }),
      )
      .mockRejectedValueOnce(new Error("disconnected"))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ ok: true, app: { packageName: null } }));
    vi.stubGlobal("fetch", fetch);
    const onChange = vi.fn();
    const onUnauthorized = vi.fn();
    const stop = subscribeDeviceForeground(androidTarget, onChange, onUnauthorized);
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fetch).toHaveBeenCalledWith(
        "https://remote.test/api/device-hub/vendor/serve-emu/api/foreground?device=physical%3A5555&hostId=remote&wsTicket=test-ticket",
        expect.objectContaining({ credentials: "include", signal: expect.any(AbortSignal) }),
      );
      expect(onChange.mock.calls.map(([app]) => app)).toEqual([
        { id: "com.example.first", pid: 42 },
        { id: "com.example.second", label: "Second" },
        null,
        null,
        null,
      ]);
      expect(onUnauthorized).not.toHaveBeenCalled();
    } finally {
      stop();
    }
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it.each([200, 401])(
    "never overlaps Android reads or handles a late %s after the panel closes",
    async (status) => {
      vi.useFakeTimers();
      let resolve!: (response: Response) => void;
      const response = new Promise<Response>((done) => {
        resolve = done;
      });
      const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(response);
      vi.stubGlobal("fetch", fetch);
      const onChange = vi.fn();
      const onUnauthorized = vi.fn();
      const stop = subscribeDeviceForeground(androidTarget, onChange, onUnauthorized);
      try {
        await vi.advanceTimersByTimeAsync(10_000);
        expect(fetch).toHaveBeenCalledOnce();
      } finally {
        stop();
      }
      expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
      resolve(Response.json({ ok: true, app: { packageName: "old.app" } }, { status }));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onChange).not.toHaveBeenCalled();
      expect(onUnauthorized).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("aborts a stalled Android read before scheduling the next one", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason));
          }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true, app: { packageName: "current.app" } }));
    vi.stubGlobal("fetch", fetch);
    const onChange = vi.fn();
    const stop = subscribeDeviceForeground(androidTarget, onChange);
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
      expect(onChange).toHaveBeenLastCalledWith(null);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(onChange).toHaveBeenLastCalledWith({ id: "current.app" });
    } finally {
      stop();
    }
  });

  it("renews expired access once, stops polling the old ticket, and resumes on new access", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true, app: { packageName: "old.app" } }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ ok: true, app: { packageName: "current.app" } }));
    vi.stubGlobal("fetch", fetch);
    const onChange = vi.fn();
    const onUnauthorized = vi.fn();
    const stopOld = subscribeDeviceForeground(androidTarget, onChange, onUnauthorized);
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(onUnauthorized).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(onChange.mock.calls.map(([app]) => app)).toEqual([{ id: "old.app" }, null]);
    } finally {
      stopOld();
    }
    const stopNew = subscribeDeviceForeground(
      {
        ...androidTarget,
        access: {
          ...androidTarget.access,
          query: { hostId: "remote", wsTicket: "renewed-ticket" },
        },
      },
      onChange,
      onUnauthorized,
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch.mock.calls[2]![0]).toContain("wsTicket=renewed-ticket");
      expect(onChange).toHaveBeenLastCalledWith({ id: "current.app" });
    } finally {
      stopNew();
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("stops unauthorized cookie sessions without trying to renew a nonexistent ticket", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    const onChange = vi.fn();
    const onUnauthorized = vi.fn();
    const stop = subscribeDeviceForeground(
      { ...androidTarget, access: { ...androidTarget.access, query: { hostId: "remote" } } },
      onChange,
      onUnauthorized,
    );
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fetch).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledWith(null);
      expect(onUnauthorized).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("clears the last app when it exits and ignores malformed events", () => {
    let source: FakeEventSource;
    class FakeEventSource {
      onmessage: ((event: { data: string }) => void) | null = null;
      addEventListener(_type: string, listener: (event: { data: string }) => void) {
        this.onmessage = listener;
      }
      close = vi.fn();
      constructor() {
        source = this;
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const onChange = vi.fn();
    const stop = subscribeDeviceForeground(
      {
        platform: "ios",
        deviceId: "test",
        access: { httpBase: "http://test", wsBase: "ws://test", query: {}, credentials: true },
      },
      onChange,
    );
    const emit = (data: unknown) => source.onmessage?.({ data: JSON.stringify(data) });
    emit({ bundleId: "com.example.app", pid: 123 });
    emit({ bundleId: null });
    emit({ bundleId: "com.example.other" });
    emit({ bundleId: "" });
    emit({ other: "not app state" });
    expect(onChange.mock.calls.map(([app]) => app)).toEqual([
      { id: "com.example.app", pid: 123 },
      null,
      { id: "com.example.other" },
      null,
    ]);
    stop();
    expect(source!.close).toHaveBeenCalledOnce();
  });
});

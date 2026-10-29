import * as NodeEvents from "node:events";

import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type Cookie,
} from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ServerBrowserContexts } from "./ServerBrowserContexts.ts";

const launches = vi.hoisted(() => ({
  launch: vi.fn<BrowserType["launch"]>(),
  persistent: vi.fn<BrowserType["launchPersistentContext"]>(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));
vi.spyOn(chromium, "launch").mockImplementation(launches.launch);
vi.spyOn(chromium, "launchPersistentContext").mockImplementation(launches.persistent);
vi.mock("node:fs/promises", () => ({ mkdir: launches.mkdir, rm: launches.rm }));

const makePage = (detach: () => void) => {
  const page = Object.assign(new NodeEvents.EventEmitter(), {
    closed: false,
    isClosed: (): boolean => page.closed,
    close: async (): Promise<void> => {
      if (page.closed) return;
      page.closed = true;
      detach();
      page.emit("close", page);
    },
  });
  return page;
};

const makeContext = () => {
  const pages: ReturnType<typeof makePage>[] = [];
  const context = Object.assign(new NodeEvents.EventEmitter(), {
    closed: false,
    pages: vi.fn(() => [...pages]),
    cookies: vi.fn(async (): Promise<Cookie[]> => []),
    addCookies: vi.fn(async (_cookies: Cookie[]) => {}),
    newPage: vi.fn(async () => {
      const page = makePage(() => pages.splice(pages.indexOf(page), 1));
      pages.push(page);
      context.emit("page", page);
      return page;
    }),
    close: vi.fn(async (): Promise<void> => {
      if (context.closed) return;
      context.closed = true;
      while (pages[0]) await pages[0].close();
      context.emit("close", context);
    }),
  });
  return context;
};

const makeBrowser = () => {
  const events = new NodeEvents.EventEmitter();
  const opened: ReturnType<typeof makeContext>[] = [];
  return {
    opened,
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    contexts: vi.fn(() => opened.filter((context) => !context.closed)),
    newContext: vi.fn(async () => {
      const context = makeContext();
      opened.push(context);
      return context as unknown as BrowserContext;
    }),
    close: vi.fn(async () => {
      for (const context of opened) await context.close();
      events.emit("disconnected");
    }),
  };
};

const options = () => ({
  profilesDir: "/test/profiles",
  executable: vi.fn(async () => "/test/chromium"),
  env: {},
});

beforeEach(() => {
  launches.launch.mockReset();
  launches.persistent.mockReset();
  launches.mkdir.mockClear();
  launches.rm.mockClear();
});

describe("ServerBrowserContexts", () => {
  it("lazily shares one browser across concurrent isolated sessions and reuses each context", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    launches.launch.mockReturnValue(launch.promise);
    const configuration = options();
    const pool = new ServerBrowserContexts(configuration);
    expect(configuration.executable).not.toHaveBeenCalled();
    const first = pool.contextFor("default", "agent-a");
    const again = pool.contextFor("default", "agent-a");
    const second = pool.contextFor("default", "agent-b");
    const incognito = pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    launch.resolve(browser as unknown as Browser);
    const [a, reused, b, privateContext] = await Promise.all([first, again, second, incognito]);
    expect(a).toBe(reused);
    expect(new Set([a, b, privateContext]).size).toBe(3);
    expect(launches.launch).toHaveBeenCalledTimes(1);
    expect(launches.persistent).not.toHaveBeenCalled();
    expect(browser.newContext).toHaveBeenCalledWith({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    for (const context of browser.opened) expect(context.close).toHaveBeenCalled();
  });

  it("keeps human profiles persistent without sharing their storage with agents", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    const persistent = await pool.contextFor("work/team");
    expect(await pool.contextFor("work/team")).toBe(persistent);
    expect(await pool.contextFor("work/team", "agent")).not.toBe(persistent);
    expect(launches.persistent).toHaveBeenCalledExactlyOnceWith(
      "/test/profiles/work%2Fteam",
      expect.objectContaining({ chromiumSandbox: true, executablePath: "/test/chromium" }),
    );
    expect(launches.mkdir).toHaveBeenCalledWith("/test/profiles/work%2Fteam", { recursive: true });
    await pool.close();
    expect(human.close).toHaveBeenCalledTimes(1);
  });

  it("clears a profile by closing its open context before deleting its storage", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const onContextClose = vi.fn();
    const pool = new ServerBrowserContexts({ ...options(), onContextClose });
    const persistent = await pool.contextFor("work/team");
    const agent = await pool.contextFor("work/team", "agent");
    launches.rm.mockImplementationOnce(async () => {
      expect(human.close).toHaveBeenCalledTimes(1);
    });
    await pool.clearProfile("work/team");
    expect(onContextClose).toHaveBeenCalledExactlyOnceWith(persistent);
    expect(launches.rm).toHaveBeenCalledExactlyOnceWith("/test/profiles/work%2Fteam", {
      recursive: true,
      force: true,
    });
    expect(await pool.contextFor("work/team", "agent")).toBe(agent);
    expect(browser.opened[0]?.close).not.toHaveBeenCalled();
    launches.persistent.mockResolvedValue(makeContext() as unknown as BrowserContext);
    expect(await pool.contextFor("work/team")).not.toBe(persistent);
    await pool.clearProfile("never-opened");
    expect(launches.rm).toHaveBeenLastCalledWith("/test/profiles/never-opened", {
      recursive: true,
      force: true,
    });
    await pool.close();
  });

  it("opens a profile requested during its clear only after the storage is deleted", async () => {
    launches.persistent.mockImplementation(async () => makeContext() as unknown as BrowserContext);
    const configuration = options();
    const pool = new ServerBrowserContexts(configuration);
    await pool.contextFor("work/team");
    const removing = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    let deleted = false;
    launches.rm.mockImplementationOnce(async () => {
      removing.resolve();
      await removed.promise;
      deleted = true;
    });
    const launchedAfterDelete: Array<boolean> = [];
    configuration.executable.mockImplementation(async () => {
      launchedAfterDelete.push(deleted);
      return "/test/chromium";
    });
    const clearing = pool.clearProfile("work/team");
    const reopening = pool.contextFor("work/team");
    await removing.promise;
    removed.resolve();
    await Promise.all([clearing, reopening]);
    expect(launchedAfterDelete).toEqual([true]);
    await pool.close();
  });

  it.each([undefined, "default"])(
    "never retries a failed %s launch with the sandbox disabled",
    async (profile) => {
      const launch = profile ? launches.persistent : launches.launch;
      launch.mockRejectedValue(new Error("sandbox unavailable"));
      const pool = new ServerBrowserContexts(options());
      await expect(pool.contextFor(profile ?? INCOGNITO_BROWSER_PROFILE_ID)).rejects.toThrow(
        "sandbox unavailable",
      );
      expect(launch).toHaveBeenCalledTimes(1);
      expect(
        profile ? launches.persistent.mock.calls[0]?.[1] : launches.launch.mock.calls[0]?.[0],
      ).toMatchObject({ chromiumSandbox: true });
      await pool.close();
    },
  );

  it("allows only an explicit sandbox opt-out", async () => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts({
      ...options(),
      env: { T3CODE_SERVER_BROWSER_SANDBOX: "0" },
    });
    await pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    expect(launches.launch).toHaveBeenCalledWith(
      expect.objectContaining({ chromiumSandbox: false }),
    );
    await pool.close();
  });

  it("retries a failed startup on a later request with sandboxing still enabled", async () => {
    const browser = makeBrowser();
    launches.launch
      .mockRejectedValueOnce(new Error("executable unavailable"))
      .mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    await expect(pool.contextFor("default", "agent")).rejects.toThrow("executable unavailable");
    await pool.contextFor("default", "agent");
    expect(launches.launch).toHaveBeenCalledTimes(2);
    expect(launches.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({ chromiumSandbox: true }),
    );
    await pool.close();
  });

  it("cleans up a browser whose launch finishes during shutdown and rejects future work", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    launches.launch.mockReturnValue(launch.promise);
    const pool = new ServerBrowserContexts(options());
    const opening = expect(pool.contextFor("default", "agent")).rejects.toThrow("closed");
    const closing = pool.close();
    launch.resolve(browser as unknown as Browser);
    await Promise.all([opening, closing]);
    await expect(pool.contextFor("default", "agent")).rejects.toThrow("closed");
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.opened[0]?.close).toHaveBeenCalled();
  });

  it("closes a profile's browser once it has had no open pages for the idle grace", async () => {
    vi.useFakeTimers();
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    const idle = makeContext();
    const fresh = makeContext();
    launches.persistent
      .mockResolvedValueOnce(idle as unknown as BrowserContext)
      .mockResolvedValueOnce(fresh as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    await (await (await pool.contextFor("default")).newPage()).close();
    await vi.advanceTimersByTimeAsync(30_000);
    const page = await (await pool.contextFor("default")).newPage();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(idle.close, "closed a profile with an open page").not.toHaveBeenCalled();
    await page.close();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(idle.close, "closed a profile before the idle grace").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(idle.close, "profile browser outlived its last page").toHaveBeenCalledTimes(1);
    expect(await pool.contextFor("default")).toBe(fresh);
    expect(launches.persistent).toHaveBeenCalledTimes(2);
    await pool.close();
  });

  it("closes the shared browser once it has had no contexts for the idle grace", async () => {
    vi.useFakeTimers();
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    const idle = makeBrowser();
    const fresh = makeBrowser();
    launches.launch
      .mockResolvedValueOnce(idle as unknown as Browser)
      .mockResolvedValueOnce(fresh as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    const agent = await pool.contextFor("default", "agent");
    const scratch = await pool.scratchPage();
    await agent.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(idle.close, "closed the shared browser with an open context").not.toHaveBeenCalled();
    await scratch.close();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(idle.close, "closed the shared browser before the idle grace").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(idle.close, "shared browser outlived its last context").toHaveBeenCalledTimes(1);
    await pool.contextFor("default", "agent");
    expect(launches.launch).toHaveBeenCalledTimes(2);
    expect(fresh.newContext).toHaveBeenCalledTimes(1);
    await pool.close();
  });

  it("keeps a profile's session cookies across an idle close until the profile is cleared", async () => {
    vi.useFakeTimers();
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    const session: Cookie = {
      name: "sess",
      value: "1",
      domain: "127.0.0.1",
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    };
    const [idle, reopened, cleared] = [makeContext(), makeContext(), makeContext()];
    idle.cookies.mockResolvedValue([session, { ...session, name: "persist", expires: 4e9 }]);
    reopened.cookies.mockResolvedValue([session]);
    for (const context of [idle, reopened, cleared]) {
      launches.persistent.mockResolvedValueOnce(context as unknown as BrowserContext);
    }
    const pool = new ServerBrowserContexts(options());
    await pool.contextFor("default");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pool.contextFor("default")).toBe(reopened);
    expect(reopened.addCookies).toHaveBeenCalledExactlyOnceWith([session]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reopened.close).toHaveBeenCalledTimes(1);
    await pool.clearProfile("default");
    expect(await pool.contextFor("default")).toBe(cleared);
    expect(cleared.addCookies).not.toHaveBeenCalled();
    await pool.close();
  });

  it("relaunches an idle-closed profile only after its previous browser has exited", async () => {
    vi.useFakeTimers();
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    const idle = makeContext();
    const exited = Promise.withResolvers<void>();
    idle.close.mockImplementationOnce(() => exited.promise);
    launches.persistent
      .mockResolvedValueOnce(idle as unknown as BrowserContext)
      .mockResolvedValueOnce(makeContext() as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    await pool.contextFor("default");
    await vi.advanceTimersByTimeAsync(60_000);
    const reopening = pool.contextFor("default");
    await vi.advanceTimersByTimeAsync(0);
    expect(launches.persistent).toHaveBeenCalledTimes(1);
    exited.resolve();
    await reopening;
    expect(launches.persistent).toHaveBeenCalledTimes(2);
    await pool.close();
  });

  it("finishes shutdown only after an idle shared browser has exited", async () => {
    vi.useFakeTimers();
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    const browser = makeBrowser();
    const exited = Promise.withResolvers<void>();
    browser.close.mockImplementationOnce(() => exited.promise);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    await (await pool.contextFor("default", "agent")).close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(browser.close).toHaveBeenCalledTimes(1);
    let closed = false;
    const closing = pool.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed, "shutdown resolved while the shared browser was exiting").toBe(false);
    exited.resolve();
    await closing;
  });
});

// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Owns Playwright resources outside the Effect runtime.
import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { constVoid } from "effect/Function";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  CDPSession,
  Cookie,
} from "playwright-core";

import { sandboxDisabled } from "./PreviewBrowserHost.ts";

// Playwright needs its files on disk. createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

interface Options {
  readonly profilesDir: string;
  readonly executable: () => Promise<string>;
  readonly diagnose?: (executable: string, cause: unknown) => Promise<unknown>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onContextClose?: (context: BrowserContext) => void;
}

const UA_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

/** Change user agent and Sec-CH-UA together; sites block mismatches. */
const chromeIdentity = (
  headlessUserAgent: string,
  host: { readonly platform: NodeJS.Platform; readonly arch: string; readonly release: string },
) => {
  const version = /HeadlessChrome\/((\d+)[\d.]*)/.exec(headlessUserAgent);
  const fullVersion = version?.[1];
  const major = version?.[2];
  if (!version || !fullVersion || !major) return null;
  const brands = (names: (version: string) => string) => [
    { brand: "Chromium", version: names(major) },
    { brand: "Google Chrome", version: names(major) },
    { brand: "Not A(Brand", version: names("99") },
  ];
  return {
    userAgent: headlessUserAgent.replace(version[0], `Chrome/${major}.0.0.0`),
    userAgentMetadata: {
      brands: brands((value) => value),
      fullVersionList: brands((value) => (value === major ? fullVersion : `${value}.0.0.0`)),
      platform: UA_PLATFORMS[host.platform] ?? "Unknown",
      platformVersion: host.platform === "linux" ? host.release : "",
      architecture: host.arch.startsWith("arm") ? "arm" : "x86",
      bitness: host.arch.endsWith("64") ? "64" : "32",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
};

export const presentAsChrome = async (
  cdp: CDPSession,
  host: { readonly platform: NodeJS.Platform; readonly arch: string },
) => {
  const { userAgent } = await cdp.send("Browser.getVersion");
  const identity = chromeIdentity(userAgent, { ...host, release: NodeOS.release() });
  if (identity) await cdp.send("Emulation.setUserAgentOverride", identity);
};

const HOST_IDLE_GRACE_MS = 60_000;

/** Calls `close` once a host has stayed idle for a whole grace; each `touch` restarts the wait. */
const idleCloser = (isIdle: () => boolean, close: () => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  return {
    touch: () => {
      clearTimeout(timer);
      if (stopped) return;
      timer = setTimeout(() => {
        if (isIdle()) close();
      }, HOST_IDLE_GRACE_MS);
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
};
type IdleCloser = ReturnType<typeof idleCloser>;

export class ServerBrowserContexts {
  private readonly options: Options;
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  private readonly clearing = new Map<string, Promise<void>>();
  private readonly idle = new Map<string, IdleCloser>();
  /** Session cookies of idle-closed profiles, re-added on relaunch; a server restart drops them. */
  private readonly sessionCookies = new Map<string, Cookie[]>();
  private browser: Promise<{ readonly browser: Browser; readonly idle: IdleCloser }> | undefined;
  private sharedClosing: Promise<void> | undefined;
  private closing: Promise<void> | undefined;

  constructor(options: Options) {
    this.options = options;
  }

  private async launchOptions() {
    const executablePath = await this.options.executable();
    const env = this.options.env ?? process.env;
    return {
      executablePath,
      env,
      args: [
        "--disable-gpu",
        "--force-device-scale-factor=2",
        "--disable-blink-features=AutomationControlled",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
      headless: true,
      // Only an explicit operator opt-out disables sandboxing. Launch errors never do.
      chromiumSandbox: !sandboxDisabled(env),
    };
  }

  private async launch<A>(options: { readonly executablePath: string }, start: () => Promise<A>) {
    try {
      return await start();
    } catch (cause) {
      throw (await this.options.diagnose?.(options.executablePath, cause)) ?? cause;
    }
  }

  private sharedBrowser() {
    if (!this.browser) {
      const launched = this.launchOptions().then(async (options) => {
        const { chromium } = loadPlaywright();
        const browser = await this.launch(options, () => chromium.launch(options));
        const idle = idleCloser(
          () => browser.contexts().length === 0,
          () => {
            if (this.browser === launched) this.browser = undefined;
            this.sharedClosing = browser.close().catch(constVoid);
          },
        );
        browser.on("disconnected", () => {
          idle.stop();
          if (this.browser === launched) this.browser = undefined;
        });
        return { browser, idle };
      });
      this.browser = launched;
      void launched.catch(() => {
        if (this.browser === launched) this.browser = undefined;
      });
    }
    return this.browser;
  }

  private async sharedContext(options?: BrowserContextOptions) {
    const { browser, idle } = await this.sharedBrowser();
    idle.touch();
    const context = await browser.newContext(options);
    context.on("close", idle.touch);
    return context;
  }

  contextFor(profileId: string, isolationKey?: string): Promise<BrowserContext> {
    if (this.closing) return Promise.reject(new Error("The preview browser is closed."));
    const key = JSON.stringify([profileId, isolationKey ?? null]);
    const cached = this.contexts.get(key);
    if (cached) {
      this.idle.get(key)?.touch();
      return cached;
    }
    const persistent = isolationKey === undefined && profileId !== INCOGNITO_BROWSER_PROFILE_ID;
    const cleared = this.clearing.get(key)?.catch(constVoid) ?? Promise.resolve();
    const pending = cleared
      .then(() => this.createContext(profileId, persistent))
      .then(async (context) => {
        context.on("close", () => {
          if (this.contexts.get(key) === pending) this.contexts.delete(key);
          this.options.onContextClose?.(context);
        });
        for (const page of context.pages()) await page.close().catch(constVoid);
        const cookies = this.sessionCookies.get(key);
        this.sessionCookies.delete(key);
        if (cookies) await context.addCookies(cookies).catch(constVoid);
        if (this.closing) {
          await context.close().catch(constVoid);
          throw new Error("The preview browser is closed.");
        }
        if (persistent) this.closeWhenIdle(key, pending, context);
        return context;
      });
    this.contexts.set(key, pending);
    void pending.catch(() => {
      if (this.contexts.get(key) === pending) this.contexts.delete(key);
    });
    return pending;
  }

  private closeWhenIdle(key: string, pending: Promise<BrowserContext>, context: BrowserContext) {
    const idle = idleCloser(
      () => context.pages().length === 0,
      () => {
        if (this.contexts.get(key) !== pending) return;
        void this.retire(key, {
          before: async () => {
            const cookies = await context.cookies().catch(() => []);
            const session = cookies.filter((cookie) => cookie.expires === -1);
            if (session.length > 0) this.sessionCookies.set(key, session);
          },
        }).catch(constVoid);
      },
    );
    this.idle.set(key, idle);
    context.on("page", (page) => page.on("close", idle.touch));
    context.on("close", () => {
      idle.stop();
      if (this.idle.get(key) === idle) this.idle.delete(key);
    });
    idle.touch();
  }

  private async createContext(profileId: string, persistent: boolean) {
    const contextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
    if (!persistent) return this.sharedContext(contextOptions);
    const directory = this.profileDirectory(profileId);
    const options = await this.launchOptions();
    const { chromium } = loadPlaywright();
    await NodeFSP.mkdir(directory, { recursive: true });
    return this.launch(options, () =>
      chromium.launchPersistentContext(directory, { ...options, ...contextOptions }),
    );
  }

  private profileDirectory(profileId: string) {
    const encoded = encodeURIComponent(profileId);
    return NodePath.join(
      this.options.profilesDir,
      profileId === "." || profileId === ".." ? encoded.replaceAll(".", "%2E") : encoded,
    );
  }

  async scratchPage() {
    if (this.closing) throw new Error("The preview browser is closed.");
    const context = await this.sharedContext();
    const page = await context.newPage();
    page.once("close", () => void context.close().catch(constVoid));
    return page;
  }

  async connectDesktopPage(endpoint: string) {
    const { chromium } = loadPlaywright();
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) {
      await browser.close().catch(constVoid);
      throw new Error("The desktop tab has no page.");
    }
    return { browser, page };
  }

  async clearProfile(profileId: string) {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return;
    const key = JSON.stringify([profileId, null]);
    await this.retire(key, {
      after: async () => {
        this.sessionCookies.delete(key);
        await NodeFSP.rm(this.profileDirectory(profileId), { recursive: true, force: true });
      },
    });
  }

  /** Runs `before`, closes the profile's context, runs `after`; a reopen waits for all of it. */
  private retire(
    key: string,
    steps: { readonly before?: () => Promise<void>; readonly after?: () => Promise<void> } = {},
  ) {
    const previous = this.clearing.get(key)?.catch(constVoid);
    const pending = this.contexts.get(key);
    this.contexts.delete(key);
    const retiring = (async () => {
      await previous;
      const context = await pending?.catch(() => undefined);
      await steps.before?.();
      await context?.close();
      await steps.after?.();
    })();
    this.clearing.set(key, retiring);
    void retiring.catch(constVoid).finally(() => {
      if (this.clearing.get(key) === retiring) this.clearing.delete(key);
    });
    return retiring;
  }

  close() {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose() {
    for (const idle of this.idle.values()) idle.stop();
    await Promise.allSettled([
      ...[...this.contexts.values()].map(async (pending) => (await pending).close()),
      ...this.clearing.values(),
      this.sharedClosing,
    ]);
    const shared = await this.browser?.catch(() => undefined);
    shared?.idle.stop();
    await shared?.browser.close().catch(constVoid);
    this.contexts.clear();
  }
}

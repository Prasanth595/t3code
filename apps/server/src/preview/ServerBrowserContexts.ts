// @effect-diagnostics nodeBuiltinImport:off - Owns Playwright resources outside the Effect runtime.
import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { constVoid } from "effect/Function";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core";

import { sandboxDisabled } from "./PreviewBrowserHost.ts";

// Playwright needs its files on disk. createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

interface Options {
  readonly profilesDir: string;
  /** Where the recorder extension is written for profiles to load. */
  readonly recorderDir: string;
  readonly executable: () => Promise<string>;
  readonly diagnose?: (executable: string, cause: unknown) => Promise<unknown>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onContextClose?: (context: BrowserContext) => void;
}

// The fixed key gives the unpacked extension a fixed ID, which --allowlisted-extension-id needs for tabCapture.
const RECORDER_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3RehY8yJ5xemVONdHDb++CtAr/Wg+0v/4aVjMACNjAUeDPUHj++V2cmzZ594xmmlL8O9eb9/FwH9t/3da7tlnAT7lVqI/fC0gLvbhaBu4YvYAAc+clRIEMSTDfxYfQzNXyizRMavf1gV7AjIfHJdsjnxRkHoPTHG8zjncWqByl+4A97maierxc5Y9iFfy3RkPXjBQUbec80BmD1V9MRKf4Zk4ZKbHFPptj59wP1eoOmFOdkiv0AUtM5+uTfvAFG+5Yyq4R2P242gOWcoIVz1z1u/ByuTvBPLbsKCPjsXSg/T+fC6NthTunSSCu3pDuIlCrkRIjaIfNE0DWVNywRSKQIDAQAB";
const RECORDER_ID = [
  ...NodeCrypto.createHash("sha256").update(Buffer.from(RECORDER_KEY, "base64")).digest("hex"),
]
  .slice(0, 32)
  .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
  .join("");
const RECORDER_FILES = {
  "manifest.json": JSON.stringify({
    manifest_version: 3,
    name: "T3 Code recorder",
    version: "1",
    key: RECORDER_KEY,
    // debugger only for getTargets, which maps a CDP target to its tab.
    permissions: ["tabCapture", "debugger"],
  }),
  "recorder.html": "<!doctype html><title>T3 Code recorder</title>",
};
const RECORDER_PAGE_URL = `chrome-extension://${RECORDER_ID}/recorder.html`;

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

export class ServerBrowserContexts {
  private readonly options: Options;
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  private readonly clearing = new Map<string, Promise<void>>();
  private browser: Promise<Browser> | undefined;
  private closing: Promise<void> | undefined;
  private recorder: Promise<string> | undefined;
  // Extensions do not run in off-the-record contexts, so only persistent profiles can record their tabs.
  private readonly recordable = new WeakSet<BrowserContext>();

  constructor(options: Options) {
    this.options = options;
  }

  private recorderExtension() {
    this.recorder ??= (async () => {
      const directory = this.options.recorderDir;
      await NodeFSP.mkdir(directory, { recursive: true });
      for (const [name, contents] of Object.entries(RECORDER_FILES)) {
        await NodeFSP.writeFile(NodePath.join(directory, name), contents);
      }
      return directory;
    })();
    void this.recorder.catch(() => {
      this.recorder = undefined;
    });
    return this.recorder;
  }

  private async launchOptions(recorder?: string) {
    const executablePath = await this.options.executable();
    const env = this.options.env ?? process.env;
    return {
      executablePath,
      env,
      args: [
        "--disable-gpu",
        "--force-device-scale-factor=2",
        "--disable-blink-features=AutomationControlled",
        ...(recorder === undefined
          ? []
          : [
              `--disable-extensions-except=${recorder}`,
              `--load-extension=${recorder}`,
              `--allowlisted-extension-id=${RECORDER_ID}`,
            ]),
      ],
      ignoreDefaultArgs: [
        "--enable-automation",
        ...(recorder === undefined ? [] : ["--disable-extensions"]),
      ],
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
        browser.on("disconnected", () => {
          if (this.browser === launched) this.browser = undefined;
        });
        return browser;
      });
      this.browser = launched;
      void launched.catch(() => {
        if (this.browser === launched) this.browser = undefined;
      });
    }
    return this.browser;
  }

  contextFor(profileId: string, isolationKey?: string): Promise<BrowserContext> {
    if (this.closing) return Promise.reject(new Error("The preview browser is closed."));
    const key = JSON.stringify([profileId, isolationKey ?? null]);
    const cached = this.contexts.get(key);
    if (cached) return cached;
    const cleared = this.clearing.get(key)?.catch(constVoid) ?? Promise.resolve();
    const pending = cleared
      .then(() => this.createContext(profileId, isolationKey))
      .then(async (context) => {
        context.on("close", () => {
          if (this.contexts.get(key) === pending) this.contexts.delete(key);
          this.options.onContextClose?.(context);
        });
        for (const page of context.pages()) await page.close().catch(constVoid);
        if (this.closing) {
          await context.close().catch(constVoid);
          throw new Error("The preview browser is closed.");
        }
        return context;
      });
    this.contexts.set(key, pending);
    void pending.catch(() => {
      if (this.contexts.get(key) === pending) this.contexts.delete(key);
    });
    return pending;
  }

  private async createContext(profileId: string, isolationKey?: string) {
    const contextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
    if (isolationKey !== undefined || profileId === INCOGNITO_BROWSER_PROFILE_ID) {
      const browser = await this.sharedBrowser();
      return browser.newContext(contextOptions);
    }
    const directory = this.profileDirectory(profileId);
    const options = await this.launchOptions(await this.recorderExtension());
    const { chromium } = loadPlaywright();
    await NodeFSP.mkdir(directory, { recursive: true });
    const context = await this.launch(options, () =>
      chromium.launchPersistentContext(directory, { ...options, ...contextOptions }),
    );
    this.recordable.add(context);
    return context;
  }

  /** A page of the recorder extension beside the context's tabs, or null where tab capture is unavailable. */
  async recorderPage(context: BrowserContext): Promise<Page | null> {
    if (!this.recordable.has(context)) return null;
    const page = await context.newPage();
    try {
      await page.goto(RECORDER_PAGE_URL);
      return page;
    } catch (cause) {
      await page.close().catch(constVoid);
      throw cause;
    }
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
    const context = await (await this.sharedBrowser()).newContext();
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
    const clearing = (async () => {
      const pending = this.contexts.get(key);
      if (pending) {
        this.contexts.delete(key);
        const context = await pending.catch(() => undefined);
        await context?.close();
      }
      await NodeFSP.rm(this.profileDirectory(profileId), { recursive: true, force: true });
    })();
    this.clearing.set(key, clearing);
    try {
      await clearing;
    } finally {
      if (this.clearing.get(key) === clearing) this.clearing.delete(key);
    }
  }

  close() {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose() {
    await Promise.allSettled(
      [...this.contexts.values()].map(async (pending) => (await pending).close()),
    );
    const browser = await this.browser?.catch(() => undefined);
    await browser?.close().catch(constVoid);
    this.contexts.clear();
  }
}

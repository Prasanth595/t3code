// Which imagery a page actually loads. Blocks build image paths at runtime (`/brands/${brand}/…`,
// fixtures for many brands, srcsets), so a static scan over-collects. When a local Chrome is available
// the compiled page is rendered headless at desktop and phone width in both colour schemes (product
// colourways follow the ground), scrolled through, and every request for a checkout-served file is
// recorded, plus every srcset candidate (the viewer's pixel density picks one); exactly those are
// inlined. Without Chrome (or playwright-core) the caller falls back to the static scan. The probe
// also reports console errors.
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

const ORIGIN = "http://nofun-artifact.localhost";
const WIDTHS = [1440, 390];
const SCHEMES = ["dark", "light"] as const;
// Every srcset candidate and src in the rendered DOM, as same-origin paths.
const DOM_PATHS = `[...document.querySelectorAll("img,source,video")].flatMap((n) => [n.getAttribute("src"), n.getAttribute("poster"), ...(n.getAttribute("srcset") || "").split(",").map((p) => p.trim().split(/\\s+/)[0])]).filter((u) => u && u.startsWith("/") && !u.startsWith("//"))`;
const IDLE_CLOSE_MS = 60_000;

type Browser = {
  newPage(options: {
    viewport: { width: number; height: number };
    colorScheme: "dark" | "light";
  }): Promise<Page>;
  close(): Promise<void>;
};
type Route = {
  request(): { url(): string };
  fulfill(options: {
    status?: number;
    contentType?: string;
    body?: string | Buffer;
  }): Promise<void>;
};
type Page = {
  route(pattern: string, handler: (route: Route) => Promise<void>): Promise<void>;
  on(event: "console", handler: (message: { type(): string; text(): string }) => void): void;
  on(event: "pageerror", handler: (error: Error) => void): void;
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  waitForLoadState(state: string, options?: { timeout?: number }): Promise<void>;
  close(): Promise<void>;
};

let browserPromise: Promise<Browser | undefined> | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function chromeExecutable(chromium: { executablePath(): string }): string | undefined {
  const candidates = [
    process.env.NOFUN_ARTIFACT_CHROME,
    (() => {
      try {
        return chromium.executablePath();
      } catch {
        return undefined;
      }
    })(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  return candidates.find((file): file is string => Boolean(file && NodeFs.existsSync(file)));
}

function browser(): Promise<Browser | undefined> {
  browserPromise ??= (async () => {
    if (process.env.NOFUN_ARTIFACT_PROBE === "0") return undefined;
    try {
      const { chromium } = (await import("playwright-core")) as unknown as {
        chromium: {
          executablePath(): string;
          launch(options: { executablePath: string; headless: boolean }): Promise<Browser>;
        };
      };
      const executablePath = chromeExecutable(chromium);
      if (!executablePath) return undefined;
      return await chromium.launch({ executablePath, headless: true });
    } catch {
      return undefined;
    }
  })();
  return browserPromise;
}

function keepAlive() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const pending = browserPromise;
    browserPromise = undefined;
    void pending?.then((b) => b?.close()).catch(() => {});
  }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
}

export interface ProbeResult {
  /** Checkout-served paths the page requested ("/brands/x/a.jpg"). */
  readonly paths: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** Renders `html` and records the checkout files it requests; undefined when no browser is available. */
export async function probeAssets(dir: string, html: string): Promise<ProbeResult | undefined> {
  const instance = await browser();
  if (!instance) return undefined;
  keepAlive();
  const requested = new Set<string>();
  const errors = new Set<string>();
  const publicDir = NodePath.join(dir, "public");
  const isPublicImage = (path: string) => {
    const file = NodePath.join(publicDir, path);
    return (
      file.startsWith(publicDir + NodePath.sep) &&
      Boolean(CONTENT_TYPES[NodePath.extname(file).toLowerCase()]) &&
      NodeFs.existsSync(file)
    );
  };
  const renders = WIDTHS.flatMap((width) => SCHEMES.map((colorScheme) => ({ width, colorScheme })));
  for (const { width, colorScheme } of renders) {
    const page = await instance.newPage({ viewport: { width, height: 900 }, colorScheme });
    try {
      page.on("console", (message) => {
        if (message.type() === "error") errors.add(message.text().slice(0, 300));
      });
      page.on("pageerror", (error) => errors.add(error.message.slice(0, 300)));
      await page.route(`${ORIGIN}/**`, async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/") {
          await route.fulfill({ status: 200, contentType: "text/html", body: html });
          return;
        }
        let path = url.pathname;
        try {
          path = decodeURI(path);
        } catch {
          // keep encoded
        }
        if (isPublicImage(path)) {
          const file = NodePath.join(publicDir, path);
          requested.add(path);
          await route.fulfill({
            status: 200,
            contentType: CONTENT_TYPES[NodePath.extname(file).toLowerCase()]!,
            body: NodeFs.readFileSync(file),
          });
          return;
        }
        await route.fulfill({ status: 404, body: "" });
      });
      await page.goto(`${ORIGIN}/`, { waitUntil: "load", timeout: 20_000 });
      await page.waitForTimeout(300);
      // Walk the page so lazy images and scroll-triggered sections load.
      const height = await page.evaluate<number>("document.documentElement.scrollHeight");
      for (let y = 0; y < Math.min(height, 40_000); y += 700) {
        await page.evaluate("window.scrollBy(0, 700)");
        await page.waitForTimeout(60);
      }
      await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
      for (let path of await page.evaluate<string[]>(DOM_PATHS)) {
        path = path.split(/[?#]/)[0]!;
        try {
          path = decodeURI(path);
        } catch {
          // keep encoded
        }
        if (isPublicImage(path)) requested.add(path);
      }
    } catch (error) {
      errors.add(`probe: ${(error as Error).message.slice(0, 200)}`);
    } finally {
      await page.close().catch(() => {});
    }
  }
  keepAlive();
  return { paths: [...requested], errors: [...errors] };
}

/** For scripts: close the shared probe browser now. */
export async function closeProbe() {
  if (idleTimer) clearTimeout(idleTimer);
  const pending = browserPromise;
  browserPromise = undefined;
  await pending?.then((b) => b?.close()).catch(() => {});
}

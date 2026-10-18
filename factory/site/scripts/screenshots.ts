// Takes the docs screenshots in public/screenshots from a throwaway T3 home seeded with the
// fictional data in demo-data.ts. Run with `npm run screenshots` after `vp i` at the repo root.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { chromium, type Browser, type Locator, type Page } from "playwright";

import { demoRunId, seedDemoHome } from "./demo-data.ts";

const SITE = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = NodePath.resolve(SITE, "../..");
const OUT_DIR = NodePath.join(SITE, "public/screenshots");
/** The page as it was when a shot did not render, kept for the person rerunning; gitignored. */
const FAILURE_PNG = NodePath.join(SITE, "screenshot-failure.png");
const STARTUP_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 15_000;
/** Space kept around a shot of part of a page, in CSS pixels. */
const PART_MARGIN = 24;
/** Where the web client keeps its own settings (apps/web/src/clientPersistenceStorage.ts). */
const CLIENT_SETTINGS_KEY = "t3code:client-settings:v1";

interface Shot {
  readonly name: string;
  readonly path: string;
  /** Waits for what the shot is of; answers the part of the page to capture, or none for all of it. */
  readonly ready: (page: Page) => Promise<Locator | void>;
}

const SHOTS: ReadonlyArray<Shot> = [
  {
    name: "factory-page",
    path: "/factory",
    ready: async (page) => {
      await page.getByText("acme/storefront#57").first().waitFor();
    },
  },
  {
    name: "run-page",
    path: `/factory/${demoRunId("pr-open")}`,
    ready: async (page) => {
      await page.getByText("Last gate output").waitFor();
      await page.getByText("pr_opened").first().waitFor();
    },
  },
  {
    name: "run-needs-info",
    path: `/factory/${demoRunId("needs-info")}`,
    ready: async (page) => {
      await page.getByText("questions_posted").first().waitFor();
    },
  },
  {
    name: "needs-attention",
    path: "/factory",
    ready: async (page) => {
      const list = page.getByRole("region", { name: "Needs attention" });
      await list.getByText("acme/storefront#52").first().waitFor();
      return list;
    },
  },
  {
    name: "settings-factory",
    path: "/settings/factory",
    ready: async (page) => {
      await page.getByText("poll", { exact: false }).first().waitFor();
    },
  },
];

/** The server's environment: no GitHub credentials reach it, and no baked-in origins. */
const serverEnv = (ghConfigDir: string): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GH_HOST",
    "T3CODE_HOME",
    "T3CODE_PORT",
    "VITE_HTTP_URL",
    "VITE_WS_URL",
    "VITE_DEV_SERVER_URL",
  ]) {
    delete env[name];
  }
  env.GH_CONFIG_DIR = ghConfigDir;
  // In web mode the server would otherwise add the repo it runs from as a T3 project, which
  // the factory would then watch, and the sidebar would show.
  env.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD = "0";
  env.T3CODE_NO_BROWSER = "1";
  return env;
};

interface DevServer {
  readonly child: NodeChildProcess.ChildProcess;
  readonly webOrigin: string;
  readonly pairingUrl: string;
}

/** Starts `vp run dev` on `home` and waits for its web port and pairing URL. */
const startDevServer = (home: string, ghConfigDir: string, log: string): Promise<DevServer> =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("vp", ["run", "dev", "--home-dir", home], {
      cwd: REPO_ROOT,
      env: serverEnv(ghConfigDir),
      // Its own process group, so the stop reaches Vite and the server under it by this pid.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = NodeFS.openSync(log, "a");
    let webPort: string | null = null;
    let pairing: string | null = null;
    let buffer = "";
    const timer = setTimeout(
      () => fail(new Error(`the dev server did not start in time; see ${log}`)),
      STARTUP_TIMEOUT_MS,
    );
    const fail = (error: Error) => {
      clearTimeout(timer);
      reject(Object.assign(error, { child }));
    };
    const onData = (chunk: Buffer) => {
      NodeFS.writeSync(output, chunk);
      // Pretty logs colour their fields; the URL and port are read from the plain text.
      buffer += NodeUtil.stripVTControlCharacters(chunk.toString("utf8"));
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        webPort ??= /\[dev-runner\].*\bwebPort=(\d+)/.exec(line)?.[1] ?? null;
        pairing ??= /pairingUrl[:=]\s*"?(https?:\/\/[^\s"]+)/.exec(line)?.[1] ?? null;
      }
      if (webPort !== null && pairing !== null) {
        clearTimeout(timer);
        const webOrigin = `http://localhost:${webPort}`;
        const url = new URL(pairing);
        resolve({
          child,
          webOrigin,
          pairingUrl: `${webOrigin}${url.pathname}${url.search}${url.hash}`,
        });
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.once("error", fail);
    child.once("exit", (code, signal) =>
      fail(new Error(`the dev server exited (${signal ?? code}) before it was ready; see ${log}`)),
    );
  });

/** Stops the process group the script spawned, by its pid, and waits for it to go. */
const stopDevServer = async (child: NodeChildProcess.ChildProcess): Promise<void> => {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, signal);
    } catch {
      // The group is already gone.
    }
  };
  signalGroup("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STOP_TIMEOUT_MS)),
  ]);
  if (!stopped) {
    signalGroup("SIGKILL");
    await exited;
  }
};

const capture = async (browser: Browser, server: DevServer): Promise<void> => {
  NodeFS.mkdirSync(OUT_DIR, { recursive: true });
  // One context for both themes: the pairing URL's token works once.
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
  // A browser that has finished T3's first-run wizard, as anyone reading the docs has: with no
  // projects seeded, the app would otherwise open the wizard over every page.
  await context.addInitScript((key) => {
    if (window.localStorage.getItem(key) === null) {
      window.localStorage.setItem(
        key,
        JSON.stringify({ onboardingCompletedAt: new Date().toISOString() }),
      );
    }
  }, CLIENT_SETTINGS_KEY);
  const page = await context.newPage();
  await page.goto(server.pairingUrl);
  await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 60_000 });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const shot of SHOTS) {
      await page.goto(`${server.webOrigin}${shot.path}`);
      const part = await shot.ready(page).catch(async (error: unknown) => {
        await page.screenshot({ path: FAILURE_PNG }).catch(() => undefined);
        throw new Error(`${shot.name} (${theme}) did not render; the page is in ${FAILURE_PNG}`, {
          cause: error,
        });
      });
      // Let the last fetch and the fonts settle so no shot catches a loading state.
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => document.fonts.ready);
      const file = NodePath.join(OUT_DIR, `${shot.name}-${theme}.png`);
      const box = part ? await part.boundingBox() : null;
      await page.screenshot({
        path: file,
        ...(box === null
          ? {}
          : {
              clip: {
                x: Math.max(0, box.x - PART_MARGIN),
                y: Math.max(0, box.y - PART_MARGIN),
                width: box.width + 2 * PART_MARGIN,
                height: box.height + 2 * PART_MARGIN,
              },
            }),
      });
      console.log(`wrote ${NodePath.relative(SITE, file)}`);
    }
  }
  await context.close();
};

const main = async (): Promise<void> => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "factory-screenshots-"));
  const ghConfigDir = NodePath.join(home, "gh");
  NodeFS.mkdirSync(ghConfigDir);
  const log = NodePath.join(home, "dev-server.log");
  let child: NodeChildProcess.ChildProcess | null = null;
  let browser: Browser | null = null;
  const cleanUp = async () => {
    await browser?.close().catch(() => undefined);
    if (child !== null) await stopDevServer(child);
    NodeFS.rmSync(home, { recursive: true, force: true });
  };
  const interrupted = () => {
    void cleanUp().finally(() => process.exit(130));
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    seedDemoHome(home, Date.now());
    const server = await startDevServer(home, ghConfigDir, log).catch((error) => {
      child = (error as { child?: NodeChildProcess.ChildProcess }).child ?? null;
      throw error;
    });
    child = server.child;
    browser = await chromium.launch();
    await capture(browser, server);
  } catch (error) {
    if (NodeFS.existsSync(log)) {
      console.error(`--- dev server output ---\n${NodeFS.readFileSync(log, "utf8").slice(-4000)}`);
    }
    throw error;
  } finally {
    await cleanUp();
  }
};

await main();

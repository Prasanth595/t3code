// Shared browser helpers for the PR #22193 evidence drivers.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Playwright comes from apps/web's dev dependencies in this checkout.
const require = createRequire(join(here, "../../apps/web/package.json"));
export const { chromium } = require("playwright");

// Web origin from the newest [dev-runner] line of a dev server log.
export function webOriginFromLog(logFile) {
  const ports = [...readFileSync(logFile, "utf8").matchAll(/webPort=(\d+)/g)];
  if (ports.length === 0) throw new Error(`no [dev-runner] line in ${logFile}`);
  return `http://localhost:${ports.at(-1)[1]}`;
}

// Mints a short-lived pairing URL for the dev server that owns <worktree>/.t3.
// The token is never logged; the resulting session is cached in authFile.
export function mintPairingUrl(worktree) {
  const out = execFileSync(
    "node",
    [
      join(worktree, "apps/server/src/bin.ts"),
      "pair",
      "--base-dir",
      join(worktree, ".t3"),
      "--ttl",
      "10m",
    ],
    { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const match = out.match(/Pairing URL: (\S+)/);
  if (!match) throw new Error("pair command printed no URL");
  return match[1];
}

export async function openApp({
  worktree,
  authFile,
  webOrigin,
  width = 1440,
  height = 900,
  theme = "light",
  videoDir,
}) {
  const browser = await chromium.launch();
  const contextOptions = {
    viewport: { width, height },
    colorScheme: theme,
    deviceScaleFactor: 1,
    ...(videoDir ? { recordVideo: { dir: videoDir, size: { width, height } } } : {}),
  };
  let pairing = null;
  if (!existsSync(authFile)) {
    pairing = mintPairingUrl(worktree);
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    await page.goto(pairing);
    await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 30_000 });
    await context.storageState({ path: authFile });
    await context.close();
  }
  const context = await browser.newContext({ ...contextOptions, storageState: authFile });
  const page = await context.newPage();
  const origin = pairing ? new URL(pairing).origin : webOrigin;
  return { browser, context, page, origin };
}

// On-screen caption so recordings narrate themselves.
export async function caption(page, text) {
  await page.evaluate((value) => {
    let el = document.getElementById("__ev_caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "__ev_caption";
      el.style.cssText =
        "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;" +
        "background:rgba(0,0,0,.82);color:#fff;font:600 15px/1.35 system-ui,sans-serif;" +
        "padding:8px 14px;border-radius:8px;max-width:92vw;pointer-events:none;white-space:pre-wrap";
      document.body.appendChild(el);
    }
    el.textContent = value;
  }, text);
}

export async function gotoSettingsGeneral(page, origin) {
  await page.goto(`${origin}/settings/general`);
  await page.locator("#default-model").first().waitFor({ timeout: 30_000 });
  // Provider snapshots arrive after the first paint; give them up to 30s.
  await page
    .waitForFunction(
      () =>
        !document.querySelector("#default-model")?.textContent?.includes("No providers available"),
      null,
      { timeout: 30_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(2000);
}

export function modelRow(page) {
  return page.locator("#default-model").first();
}

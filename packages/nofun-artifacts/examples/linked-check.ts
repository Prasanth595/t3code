// Writes the linked-artifact check pages for a built runtime (pnpm runtime:build first):
// - examples/linked-out/index.html and spec.html: what Canvas loads (nofun-ui://runtime/<sha>/…),
// - examples/linked-check.html: the same tsx page with the scheme faked by a relative path into
//   dist/, for a plain browser or WKWebView with read access to the package folder.
// `--shot <png>` renders the check page in headless Chrome, fails on page errors and saves a screenshot.
//   node examples/linked-check.ts [<runtime sha>] [--shot <png>]
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compileLinked } from "../src/linked.ts";

const HERE = NodePath.dirname(fileURLToPath(import.meta.url));
const RUNTIMES = NodePath.join(HERE, "..", "dist", "nofun-ui-runtime");
const OUT = NodePath.join(HERE, "linked-out");
const args = process.argv.slice(2);
const shot = args.includes("--shot") ? args[args.indexOf("--shot") + 1] : undefined;
const sha =
  args.find((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--shot") ??
  NodeFs.readdirSync(RUNTIMES)
    .map((name) => ({ name, at: NodeFs.statSync(NodePath.join(RUNTIMES, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0]?.name;
if (!sha) throw new Error(`No runtime under ${RUNTIMES}; run pnpm runtime:build first.`);

const tsx = NodeFs.readFileSync(NodePath.join(HERE, "linked-check.tsx"), "utf8");
const spec = NodeFs.readFileSync(NodePath.join(HERE, "dashboard.spec.json"), "utf8");
const common = { theme: "kobra", size: { width: 1100, height: 900 }, runtimeSHA: sha };
const relative = `../dist/nofun-ui-runtime/${sha}/`;
const pages = [
  { file: NodePath.join(OUT, "index.html"), lane: "tsx", source: tsx },
  { file: NodePath.join(OUT, "spec.html"), lane: "spec", source: spec },
  { file: NodePath.join(HERE, "linked-check.html"), lane: "tsx", source: tsx, base: relative },
  { file: NodePath.join(OUT, "spec-check.html"), lane: "spec", source: spec, base: `../${relative}` },
] as const;

NodeFs.mkdirSync(OUT, { recursive: true });
for (const page of pages) {
  const linked = await compileLinked({
    ...common,
    lane: page.lane,
    source: page.source,
    title: `Linked ${page.lane} check`,
    runtimeBase: "base" in page ? page.base : undefined,
  });
  NodeFs.writeFileSync(page.file, linked.html);
  console.log(`${NodePath.relative(HERE, page.file)}: ${(linked.bytes / 1024).toFixed(1)} KiB (${page.lane}, runtime ${sha})`);
}

if (shot) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath:
      process.env.NOFUN_ARTIFACT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  try {
    for (const [file, expect, png] of [
      [NodePath.join(HERE, "linked-check.html"), ["Weekly revenue", "Print queue", "Refund rate"], shot],
      [NodePath.join(OUT, "spec-check.html"), [], shot.replace(/\.png$/, "-spec.png")],
    ] as const) {
      const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
      await page.waitForTimeout(2500);
      const text = await page.evaluate(() => document.body.innerText);
      const missing = expect.filter((needle) => !text.includes(needle));
      const info = await page.evaluate(() => ({
        brand: document.body.dataset.brand,
        components: Object.keys((window as unknown as { NoFunUI: { components: object } }).NoFunUI.components).length,
        blocks: document.querySelectorAll("#nf-root *").length,
      }));
      await page.screenshot({ path: png, fullPage: true });
      console.log(
        `${NodePath.basename(file)}: brand ${info.brand}, ${info.components} runtime components, ${info.blocks} elements rendered -> ${png}`,
      );
      if (errors.length > 0 || missing.length > 0 || info.blocks < 20) {
        console.error(`  failed: errors ${JSON.stringify(errors)} missing ${JSON.stringify(missing)}`);
        process.exitCode = 1;
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

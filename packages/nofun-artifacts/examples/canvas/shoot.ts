// Screenshots Canvas bundles the way the board shows them: the manifest size as the viewport, the
// board colour (23/24/26) behind a transparent page. Run: node examples/canvas/shoot.ts <bundle dir>... --out <dir>
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import { chromium } from "playwright-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BOARD = "rgb(23 24 26)";

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
if (outAt < 0 || !args[outAt + 1]) throw new Error("usage: shoot.ts <bundle dir>... --out <dir>");
const out = args[outAt + 1]!;
const bundles = args.filter((_, i) => i !== outAt && i !== outAt + 1);
NodeFs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  for (const dir of bundles) {
    const manifest = JSON.parse(
      NodeFs.readFileSync(NodePath.join(dir, "manifest.json"), "utf8"),
    ) as {
      size: { width: number; height: number };
      background: string;
    };
    const page = await browser.newPage({
      viewport: manifest.size,
      deviceScaleFactor: 2,
      colorScheme: "dark",
    });
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`file://${NodePath.resolve(dir, "index.html")}`);
    if (manifest.background === "transparent" || manifest.background === "match") {
      await page.addStyleTag({ content: `html{background:${BOARD}!important}` });
    }
    await page.waitForTimeout(600);
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - innerWidth,
      y: document.documentElement.scrollHeight - innerHeight,
    }));
    const file = NodePath.join(out, `${NodePath.basename(NodePath.resolve(dir))}.png`);
    await page.screenshot({ path: file });
    console.log(
      `${file} ${manifest.size.width}x${manifest.size.height} overflow=${overflow.x},${overflow.y}${errors.length ? ` errors=${JSON.stringify(errors)}` : ""}`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}

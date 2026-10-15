// Renders the examples in both No Fun themes to examples/out/*.html, prepared the way T3's html_render
// stores them (theme bootstrap injected), then screenshots each at 1440, 728 and 390 in T3 light and dark
// (728 is the T3 reply column) with a local Chrome. Run: node examples/render.ts [path to Chrome]
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import {
  htmlRenderTheme,
  htmlRenderThemeFragment,
  injectHtmlRenderBootstrap,
} from "@t3tools/shared/htmlRender";
import {
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
} from "@t3tools/shared/themePalettes";
import { chromium } from "playwright-core";

import { compileArtifact } from "../src/compiler.ts";

const HERE = NodePath.dirname(fileURLToPath(import.meta.url));
const OUT = NodePath.join(HERE, "out");
const CHROME = process.argv[2] ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const examples = [
  {
    name: "dashboard",
    input: {
      spec: JSON.parse(await NodeFs.readFile(NodePath.join(HERE, "dashboard.spec.json"), "utf8")),
    },
  },
  {
    name: "comparison",
    input: {
      tsx: await NodeFs.readFile(NodePath.join(HERE, "comparison.tsx"), "utf8"),
      title: "Print vendors (example data)",
    },
  },
  {
    name: "edges",
    input: {
      spec: JSON.parse(await NodeFs.readFile(NodePath.join(HERE, "edges.spec.json"), "utf8")),
    },
  },
] as const;
const themes = ["kobra", "mrch"] as const;
const widths = [1440, 728, 390] as const;
const appearances = ["light", "dark"] as const;

await NodeFs.mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report: string[] = [];
try {
  for (const example of examples) {
    for (const theme of themes) {
      const compiled = await compileArtifact({ ...example.input, theme });
      const file = NodePath.join(OUT, `${example.name}-${theme}.html`);
      await NodeFs.writeFile(file, injectHtmlRenderBootstrap(compiled.html));
      report.push(
        `${example.name}-${theme}.html ${compiled.lane} ${(compiled.bytes / 1024).toFixed(0)} KiB in ${compiled.compileMs} ms`,
      );
      for (const appearance of appearances) {
        const colors =
          appearance === "light" ? T3_CODE_LIGHT_THEME_COLORS : T3_CODE_DARK_THEME_COLORS;
        const fragment = htmlRenderThemeFragment(htmlRenderTheme(colors, appearance));
        for (const width of widths) {
          const page = await browser.newPage({
            viewport: { width, height: 900 },
            deviceScaleFactor: 1,
          });
          const errors: string[] = [];
          page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text());
          });
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`file://${file}${fragment}`);
          await page.waitForTimeout(150);
          const initial = NodePath.join(
            OUT,
            `${example.name}-${theme}-${appearance}-${width}-initial.png`,
          );
          await page.screenshot({ path: initial, fullPage: true });
          if (example.name === "comparison") {
            // Exercise the filter: DTG only, then search within it.
            await page.getByRole("button", { name: "DTG", exact: true }).click();
            await page.getByPlaceholder("Name or note").fill("drop");
          } else if (example.name === "dashboard") {
            // Sort the table by revenue, descending.
            await page.getByRole("button", { name: "Revenue", exact: true }).click();
            await page.getByRole("button", { name: "Revenue", exact: true }).click();
          }
          await page.waitForTimeout(100);
          const shot = NodePath.join(OUT, `${example.name}-${theme}-${appearance}-${width}.png`);
          await page.screenshot({ path: shot, fullPage: true });
          report.push(
            `  ${NodePath.basename(shot)}${errors.length ? ` ERRORS: ${errors.join(" | ")}` : ""}`,
          );
          await page.close();
        }
      }
    }
  }
} finally {
  await browser.close();
}
console.log(report.join("\n"));

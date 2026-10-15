// The page stylesheet, compiled the way nofun-components compiles its own: app/globals.css through the
// checkout's Tailwind v4, with the class candidates of exactly the sources the bundle pulled in. Only the
// page brand's sheet is included (each brand sheet carries its own @font-face rules), every url() is
// inlined, and the next/font families the root layout loads (Geist and the brand Google fonts) come
// from the checkout's last Next build, inlined as data URIs. Without a build, Geist comes from fonts/.
import { createRequire } from "node:module";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";

import * as esbuild from "esbuild";

import { dataUri, inlineCssUrls } from "./assets.ts";
import { perStamp } from "./source.ts";

export const CSS_TARGET = ["chrome111", "safari16.4", "firefox115"];

type TailwindModule = {
  compile: (
    css: string,
    options: {
      base: string;
      loadStylesheet: (
        id: string,
        base: string,
      ) => Promise<{ path: string; base: string; content: string }>;
      loadModule?: (
        id: string,
        base: string,
      ) => Promise<{ path: string; base: string; module: unknown }>;
    },
  ) => Promise<{ build: (candidates: string[]) => string }>;
};

const tailwindFor = perStamp(async (dir) => {
  const require = createRequire(NodePath.join(dir, "package.json"));
  const loaded = (await import(
    pathToFileURL(require.resolve("tailwindcss")).href
  )) as Partial<TailwindModule> & {
    default?: TailwindModule;
  };
  return typeof loaded.compile === "function" ? (loaded as TailwindModule) : loaded.default!;
});

function packageStylesheet(dir: string, id: string): string {
  const parts = id.split("/");
  const name = id.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  const sub = parts.slice(id.startsWith("@") ? 2 : 1).join("/");
  const root = NodePath.join(dir, "node_modules", name);
  const pkg = JSON.parse(NodeFs.readFileSync(NodePath.join(root, "package.json"), "utf8")) as {
    style?: string;
    exports?: Record<string, unknown>;
  };
  const key = sub ? `./${sub}` : ".";
  const entry = pkg.exports?.[key];
  const pick = (value: unknown): string | undefined =>
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? (pick((value as Record<string, unknown>).style) ??
          pick((value as Record<string, unknown>).import) ??
          pick((value as Record<string, unknown>).default))
        : undefined;
  const target = pick(entry) ?? (sub ? `./${sub}` : (pkg.style ?? "./index.css"));
  const file = NodePath.join(root, target);
  return file.endsWith(".css") || NodeFs.existsSync(file) ? file : `${file}.css`;
}

async function loadStylesheet(dir: string, id: string, base: string) {
  const file =
    id.startsWith(".") || id.startsWith("/")
      ? NodePath.resolve(base, id.endsWith(".css") ? id : `${id}.css`)
      : packageStylesheet(dir, id);
  return {
    path: file,
    base: NodePath.dirname(file),
    content: await NodeFs.promises.readFile(file, "utf8"),
  };
}

/** globals.css with the brand index swapped for one brand sheet (or none), plus the bundle's CSS imports. */
function stylesheetInput(dir: string, brand: string | null, cssImports: ReadonlyArray<string>) {
  const globals = NodeFs.readFileSync(NodePath.join(dir, "app", "globals.css"), "utf8");
  const brandFile = brand
    ? NodePath.join(dir, "registry", "nofun-ui", "themes", "brands", `${brand}.css`)
    : undefined;
  const brandImport =
    brandFile && NodeFs.existsSync(brandFile)
      ? `@import "../registry/nofun-ui/themes/brands/${brand}.css";`
      : "";
  const swapped = globals.replace(
    /@import\s+["'][^"']*themes\/brands\/index\.css["'];?/,
    brandImport,
  );
  const extra = [...cssImports]
    .sort()
    .map((file) => `@import ${JSON.stringify(file)};`)
    .join("\n");
  return `${swapped}\n${extra}`;
}

/** Whether a unicode-range reaches basic Latin (subset faces for other scripts are dropped). */
function coversLatin(block: string): boolean {
  const range = /unicode-range\s*:\s*([^;}]+)/i.exec(block)?.[1];
  if (!range) return true;
  return range.split(",").some((part) => {
    const [lo, hi] = part.trim().replace(/^U\+/i, "").split("-");
    if (!lo) return false;
    const start = Number.parseInt(lo.replace(/\?/g, "0"), 16);
    const end = Number.parseInt((hi ?? lo).replace(/\?/g, "f"), 16);
    return start <= 0x41 && end >= 0x41;
  });
}

const dropNonLatinFaces = (css: string) =>
  css.replace(/@font-face\s*\{[^}]*\}/g, (block) => (coversLatin(block) ? block : ""));

interface NextFonts {
  readonly vars: ReadonlyMap<string, string>;
  readonly faces: ReadonlyArray<{ family: string; block: string }>;
}

/** The next/font output of the checkout's last `next build`/`next dev` (absent: system fallbacks). */
const nextFonts = perStamp(async (dir): Promise<NextFonts> => {
  const chunks = NodePath.join(dir, ".next", "static", "chunks");
  let best: { file: string; size: number } | undefined;
  try {
    for (const name of NodeFs.readdirSync(chunks).sort()) {
      if (!name.endsWith(".css")) continue;
      const file = NodePath.join(chunks, name);
      const size = NodeFs.statSync(file).size;
      if (best && size >= best.size) continue;
      if (NodeFs.readFileSync(file, "utf8").includes("--font-geist-sans:")) best = { file, size };
    }
  } catch {
    return { vars: new Map(), faces: [] };
  }
  if (!best) return { vars: new Map(), faces: [] };
  const css = NodeFs.readFileSync(best.file, "utf8");
  const vars = new Map<string, string>();
  for (const match of css.matchAll(/\.[\w-]+\{(--font-[\w-]+):([^}]+)\}/g))
    vars.set(match[1]!, match[2]!);
  const faces: { family: string; block: string }[] = [];
  for (const match of css.matchAll(/@font-face\s*\{[^}]*\}/g)) {
    let block = match[0];
    if (!coversLatin(block)) continue;
    const family = /font-family\s*:\s*([^;}]+)/
      .exec(block)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, "");
    if (!family) continue;
    block = block.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (whole, _q: string, url: string) => {
      if (url.startsWith("data:")) return whole;
      const file = NodePath.resolve(NodePath.dirname(best!.file), url);
      const uri = dataUri(file);
      return uri ? `url("${uri}")` : whole;
    });
    faces.push({ family, block });
  }
  return { vars, faces };
});

const GEIST_DIR = NodePath.join(import.meta.dirname, "..", "..", "fonts");

/** Geist sans and mono (vendored from geist@1.7.2, OFL) for a checkout with no next/font build. */
function geistFallbackCss(): string {
  const face = (family: string, file: string) =>
    `@font-face{font-family:"${family}";src:url("${dataUri(NodePath.join(GEIST_DIR, file))}") format("woff2");font-weight:100 900;font-style:normal;font-display:block}`;
  return (
    `:root{--font-geist-sans:"Geist",ui-sans-serif,system-ui,sans-serif;--font-geist-mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace}` +
    face("Geist", "Geist-Variable.woff2") +
    face("Geist Mono", "GeistMono-Variable.woff2")
  );
}

async function nextFontCss(dir: string, sheet: string) {
  const fonts = await nextFonts();
  if (!fonts.vars.has("--font-geist-sans")) return geistFallbackCss();
  const decls: string[] = [];
  const families = new Set<string>();
  for (const [name, value] of fonts.vars) {
    if (
      name !== "--font-geist-sans" &&
      name !== "--font-geist-mono" &&
      !sheet.includes(`var(${name}`)
    )
      continue;
    decls.push(`${name}:${value}`);
    for (const family of value.split(",")) families.add(family.trim().replace(/^["']|["']$/g, ""));
  }
  const faces = fonts.faces.filter((face) => families.has(face.family)).map((face) => face.block);
  return decls.length === 0 ? "" : `:root{${decls.join(";")}}${faces.join("")}`;
}

export interface PageCssInput {
  readonly brand: string | null;
  readonly candidates: Iterable<string>;
  readonly cssImports: ReadonlyArray<string>;
  /** Page-frame rules appended after the checkout's sheets. */
  readonly extraCss?: string;
}

export async function buildCss(dir: string, input: PageCssInput): Promise<string> {
  const tailwind = await tailwindFor();
  const compiler = await tailwind.compile(
    `${stylesheetInput(dir, input.brand, input.cssImports)}\n${input.extraCss ?? ""}`,
    {
      base: NodePath.join(dir, "app"),
      loadStylesheet: (id, base) => loadStylesheet(dir, id, base),
      loadModule: async (id) => {
        throw new Error(`Tailwind plugin "${id}" is not supported in artifacts.`);
      },
    },
  );
  const tailwindCss = dropNonLatinFaces(compiler.build([...input.candidates].sort()));
  const fonts = await nextFontCss(dir, tailwindCss);
  const minified = await esbuild.transform(fonts + tailwindCss, {
    loader: "css",
    minify: true,
    charset: "utf8",
    target: CSS_TARGET,
    legalComments: "none",
    logLevel: "silent",
  });
  return inlineCssUrls(dir, minified.code);
}

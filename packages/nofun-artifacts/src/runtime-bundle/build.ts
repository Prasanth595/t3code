// Builds the shared No Fun UI runtime that Canvas ships once per nofun-components revision, so a linked
// artifact (src/linked.ts) only carries its own code:
//   dist/nofun-ui-runtime/<sha>/{runtime.js, runtime.css, brands/<id>.css, manifest.json}
// runtime.js is one IIFE with every registry block, component and lib (commerce included), each block's
// demo, every Kobra primitive, @nofun/artifacts and the shared packages, exposed as window.NoFunUI
// (client.jsx). runtime.css is Tailwind compiled once over all of those sources with no brand; each
// brand is its own sheet so a page loads one. Modules that do not bundle are left out and listed in
// the manifest with the reason.
//   pnpm runtime:build [--out <dir>] [--allow-dirty]
import { execFile } from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { promisify } from "node:util";

import * as esbuild from "esbuild";

import { dataUri, inlineCssUrls } from "../live/assets.ts";
import { BundleError, PACKAGE_SRC_DIR, bundle, candidatesOfFiles } from "../live/bundle.ts";
import { CSS_TARGET, buildCss } from "../live/css.ts";
import { brandIds, brandScheme, liveIndex, scanExports } from "../live/registry.ts";
import { assertComponentsDir, sourceStamp } from "../live/source.ts";

const run = promisify(execFile);
const MiB = 1024 * 1024;
/** What one page loads: runtime js + css + one brand sheet. */
export const RUNTIME_BUDGET_BYTES = 24 * MiB;
const PACKAGES = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@tabler/icons-react",
  "motion",
  "motion/react",
  "recharts",
];
const FRAME_CSS = `html{font-size:16px}body{margin:0}`;

const args = process.argv.slice(2);
const outArg = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
const allowDirty = args.includes("--allow-dirty");

interface RuntimeModule {
  readonly specifier: string;
  /** Registry name (or `kobra/<name>`) this module belongs to. */
  readonly owner: string;
  /** Key in NoFunUI.components and the export it maps to; absent for demos and modules without one. */
  readonly component?: { readonly name: string; readonly export: string };
}

const pascal = (name: string) =>
  name.replace(/(^|[-_/])([a-z0-9])/g, (_m, _sep: string, c: string) => c.toUpperCase());

function mainExport(exports: ReadonlyArray<string>, name: string, preferred?: string) {
  if (preferred && exports.includes(preferred)) return preferred;
  if (exports.includes(pascal(name))) return pascal(name);
  return exports.find((e) => /^[A-Z]/.test(e) && !/(Demo|Props|Variants)$/.test(e));
}

function listModules(dir: string, files: ReadonlyMap<string, { file: string }>): RuntimeModule[] {
  const registry = JSON.parse(NodeFs.readFileSync(NodePath.join(dir, "registry.json"), "utf8")) as {
    items: { name: string; type: string }[];
  };
  const ontology = (() => {
    try {
      return JSON.parse(
        NodeFs.readFileSync(NodePath.join(dir, "public", "r", "ontology.json"), "utf8"),
      ) as { items: { slug: string; mainComponent?: string }[] };
    } catch {
      return { items: [] };
    }
  })();
  const mains = new Map(ontology.items.map((item) => [item.slug, item.mainComponent]));
  const modules: RuntimeModule[] = [];
  const types = new Set(["registry:block", "registry:component", "registry:lib"]);
  for (const item of registry.items) {
    const file = files.get(item.name)?.file;
    if (!types.has(item.type) || !file) continue;
    const abs = NodePath.join(dir, file);
    const exports = scanExports(NodeFs.readFileSync(abs, "utf8"));
    const main =
      item.type === "registry:lib"
        ? undefined
        : mainExport(exports, item.name, mains.get(item.name));
    modules.push({
      specifier: `@nofun/ui/${item.name}`,
      owner: item.name,
      ...(main ? { component: { name: item.name, export: main } } : {}),
    });
    if (NodeFs.existsSync(NodePath.join(NodePath.dirname(abs), "demo.tsx"))) {
      modules.push({ specifier: `@nofun/ui/${item.name}/demo`, owner: item.name });
    }
  }
  const kobraDir = NodePath.join(dir, "components", "ui");
  for (const file of NodeFs.readdirSync(kobraDir).sort()) {
    if (!/\.tsx?$/.test(file)) continue;
    const name = file.replace(/\.tsx?$/, "");
    const main = mainExport(
      scanExports(NodeFs.readFileSync(NodePath.join(kobraDir, file), "utf8")),
      name,
    );
    modules.push({
      specifier: `@nofun/kobra/${name}`,
      owner: `kobra/${name}`,
      ...(main ? { component: { name: `kobra/${name}`, export: main } } : {}),
    });
  }
  modules.push({ specifier: "@nofun/artifacts", owner: "artifacts" });
  return modules;
}

function entryFor(modules: ReadonlyArray<RuntimeModule>, config: object) {
  return [
    `import { install } from "./runtime-bundle/client.jsx";`,
    `import packages from "./runtime-bundle/packages.js";`,
    ...modules.map((m, i) => `import * as m${i} from ${JSON.stringify(m.specifier)};`),
    `install({ ...${JSON.stringify(config)}, modules: { ...packages, ${modules
      .map((m, i) => `${JSON.stringify(m.specifier)}: m${i}`)
      .join(", ")} } });`,
  ].join("\n");
}

/** The modules that fail to bundle, found by bisecting (only run when the full build fails). */
async function failing(
  dir: string,
  index: Awaited<ReturnType<typeof liveIndex>>,
  modules: ReadonlyArray<RuntimeModule>,
): Promise<Map<string, string>> {
  const entry = modules
    .map(
      (m, i) =>
        `import * as m${i} from ${JSON.stringify(m.specifier)}; (globalThis as any).__nf${i} = m${i};`,
    )
    .join("\n");
  const issue = await bundle(dir, index, { entry, minify: false }).then(
    () => undefined,
    (error: unknown) =>
      (error instanceof BundleError ? error.issues[0] : (error as Error).message) ??
      "bundle failed",
  );
  if (issue === undefined) return new Map();
  if (modules.length === 1) return new Map([[modules[0]!.specifier, issue.slice(0, 300)]]);
  const half = Math.ceil(modules.length / 2);
  const [a, b] = await Promise.all([
    failing(dir, index, modules.slice(0, half)),
    failing(dir, index, modules.slice(half)),
  ]);
  return new Map([...a, ...b]);
}

interface NextFonts {
  readonly vars: ReadonlyMap<string, string>;
  readonly faces: ReadonlyArray<{ family: string; block: string }>;
}

/** Whether a face's unicode-range reaches basic Latin (subset faces for other scripts are dropped). */
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

/** The next/font families of the checkout's last Next build (the same source live/css.ts reads). */
function nextFonts(dir: string): NextFonts {
  const chunks = NodePath.join(dir, ".next", "static", "chunks");
  const file = (() => {
    try {
      return NodeFs.readdirSync(chunks)
        .filter((name) => name.endsWith(".css"))
        .map((name) => NodePath.join(chunks, name))
        .filter((path) => NodeFs.readFileSync(path, "utf8").includes("--font-geist-sans:"))
        .sort(
          (a, b) =>
            NodeFs.statSync(a).size - NodeFs.statSync(b).size || (a < b ? -1 : a > b ? 1 : 0),
        )[0];
    } catch {
      return undefined;
    }
  })();
  if (!file) return { vars: new Map(), faces: [] };
  const css = NodeFs.readFileSync(file, "utf8");
  const vars = new Map<string, string>();
  for (const match of css.matchAll(/\.[\w-]+\{(--font-[\w-]+):([^}]+)\}/g))
    vars.set(match[1]!, match[2]!);
  const faces: { family: string; block: string }[] = [];
  for (const match of css.matchAll(/@font-face\s*\{[^}]*\}/g)) {
    if (!coversLatin(match[0])) continue;
    const family = /font-family\s*:\s*([^;}]+)/
      .exec(match[0])?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, "");
    if (!family) continue;
    const block = match[0].replace(
      /url\(\s*(["']?)([^"')]+)\1\s*\)/g,
      (whole, _q: string, url: string) => {
        if (url.startsWith("data:")) return whole;
        const uri = dataUri(NodePath.resolve(NodePath.dirname(file), url));
        return uri ? `url("${uri}")` : whole;
      },
    );
    faces.push({ family, block });
  }
  return { vars, faces };
}

/** One brand's sheet plus the next/font families it names (Geist is already in runtime.css). */
async function brandCss(dir: string, brand: string, fonts: NextFonts): Promise<string> {
  const sheet = NodeFs.readFileSync(
    NodePath.join(dir, "registry", "nofun-ui", "themes", "brands", `${brand}.css`),
    "utf8",
  );
  const decls: string[] = [];
  const families = new Set<string>();
  for (const [name, value] of fonts.vars) {
    if (name.startsWith("--font-geist") || !sheet.includes(`var(${name}`)) continue;
    decls.push(`${name}:${value}`);
    for (const family of value.split(",")) families.add(family.trim().replace(/^["']|["']$/g, ""));
  }
  const faces = fonts.faces.filter((face) => families.has(face.family)).map((face) => face.block);
  const head = decls.length === 0 ? "" : `:root{${decls.join(";")}}${faces.join("")}`;
  const minified = await esbuild.transform(head + sheet, {
    loader: "css",
    minify: true,
    charset: "utf8",
    legalComments: "none",
    target: CSS_TARGET,
    logLevel: "silent",
  });
  return inlineCssUrls(dir, minified.code);
}

async function gitVersion(dir: string) {
  const git = (...a: string[]) => run("git", ["-C", dir, ...a]).then((r) => r.stdout.trim());
  const [commit, status] = await Promise.all([
    git("rev-parse", "HEAD").catch(() => ""),
    git("status", "--porcelain").catch(() => "unknown"),
  ]);
  if (commit && status === "") return { commit, sha: commit.slice(0, 12), dirty: false };
  if (!allowDirty) {
    throw new Error(
      `${dir} is not a clean git checkout; point NOFUN_COMPONENTS_DIR at a clean one or pass --allow-dirty.`,
    );
  }
  return { commit, sha: await sourceStamp(dir), dirty: true };
}

const started = performance.now();
const dir = assertComponentsDir();
const version = await gitVersion(dir);
const index = await liveIndex();
const out = NodePath.resolve(
  outArg ?? NodePath.join(PACKAGE_SRC_DIR, "..", "dist", "nofun-ui-runtime", version.sha),
);
const brands = Object.fromEntries(brandIds(dir).map((id) => [id, brandScheme(dir, id)]));

let modules = listModules(dir, index.files);
const excluded: { name: string; reason: string }[] = [];
const configFor = (list: ReadonlyArray<RuntimeModule>) => ({
  version: version.sha,
  brands,
  components: Object.fromEntries(
    list.flatMap((m) =>
      m.component ? [[m.component.name, [m.specifier, m.component.export]]] : [],
    ),
  ),
});

let built: Awaited<ReturnType<typeof bundle>>;
try {
  built = await bundle(dir, index, { entry: entryFor(modules, configFor(modules)) });
} catch (error) {
  if (!(error instanceof BundleError)) throw error;
  console.log(`full build failed (${error.issues[0]}); bisecting ${modules.length} modules`);
  const failures = await failing(dir, index, modules);
  for (const [specifier, reason] of failures) excluded.push({ name: specifier, reason });
  modules = modules.filter((m) => !failures.has(m.specifier));
  built = await bundle(dir, index, { entry: entryFor(modules, configFor(modules)) });
}
for (const item of index.files.keys()) {
  if (item.startsWith("design-system-")) continue;
  if (
    !modules.some((m) => m.owner === item) &&
    !excluded.some((e) => e.name === `@nofun/ui/${item}`)
  ) {
    excluded.push({ name: `@nofun/ui/${item}`, reason: "not a block, component or lib" });
  }
}
const css = await buildCss(dir, {
  brand: null,
  candidates: [...candidatesOfFiles(built.sourceFiles)],
  cssImports: built.cssImports,
  extraCss: FRAME_CSS,
});

NodeFs.rmSync(out, { recursive: true, force: true });
NodeFs.mkdirSync(NodePath.join(out, "brands"), { recursive: true });
NodeFs.writeFileSync(NodePath.join(out, "runtime.js"), built.js);
NodeFs.writeFileSync(NodePath.join(out, "runtime.css"), css);
const fonts = nextFonts(dir);
const brandBytes: Record<string, number> = {};
for (const id of Object.keys(brands)) {
  const sheet = await brandCss(dir, id, fonts);
  NodeFs.writeFileSync(NodePath.join(out, "brands", `${id}.css`), sheet);
  brandBytes[id] = Buffer.byteLength(sheet);
}

const config = configFor(modules);
const jsBytes = Buffer.byteLength(built.js);
const cssBytes = Buffer.byteLength(css);
const brandsTotal = Object.values(brandBytes).reduce((a, b) => a + b, 0);
const largestBrand = Math.max(0, ...Object.values(brandBytes));
const pageLoad = jsBytes + cssBytes + largestBrand;
const total = jsBytes + cssBytes + brandsTotal;
const manifest = {
  sha: version.sha,
  componentsCommit: version.commit,
  dirty: version.dirty,
  builtAt: new Date().toISOString(),
  itemCount: new Set(
    modules.filter((m) => m.specifier.startsWith("@nofun/ui/")).map((m) => m.owner),
  ).size,
  moduleCount: modules.length + PACKAGES.length,
  componentCount: Object.keys(config.components).length,
  sizes: {
    "runtime.js": jsBytes,
    "runtime.css": cssBytes,
    brands: brandsTotal,
    largestBrand,
    pageLoad,
    total,
  },
  budget: RUNTIME_BUDGET_BYTES,
  brands: Object.fromEntries(
    Object.entries(brands).map(([id, scheme]) => [id, { ...scheme, bytes: brandBytes[id] }]),
  ),
  excluded,
  modules: [...PACKAGES, ...modules.map((m) => m.specifier)],
  components: config.components,
};
NodeFs.writeFileSync(NodePath.join(out, "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);

const mib = (bytes: number) => `${(bytes / MiB).toFixed(2)} MiB`;
console.log(`runtime ${version.sha} -> ${out} in ${Math.round(performance.now() - started)} ms`);
console.log(
  `  ${manifest.itemCount} registry items, ${manifest.moduleCount} modules, ${manifest.componentCount} components, ${Object.keys(brands).length} brands, ${excluded.length} excluded`,
);
console.log(
  `  runtime.js ${mib(jsBytes)}, runtime.css ${mib(cssBytes)}, one brand <= ${mib(largestBrand)}: a page loads ${mib(pageLoad)} of ${mib(RUNTIME_BUDGET_BYTES)}; folder ${mib(total)} (all brands ${mib(brandsTotal)})`,
);
for (const item of excluded) console.log(`  excluded ${item.name}: ${item.reason}`);
if (pageLoad > RUNTIME_BUDGET_BYTES) {
  console.error(`over budget by ${mib(pageLoad - RUNTIME_BUDGET_BYTES)}`);
  process.exitCode = 1;
}

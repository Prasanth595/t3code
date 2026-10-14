// The No Fun artifact compiler. It compiles against the LIVE nofun-components checkout
// (NOFUN_COMPONENTS_DIR, default ~/Documents/GitHub/nofun-components): esbuild bundles the real blocks,
// Kobra primitives and their packages straight from the checkout, Tailwind v4 (the checkout's own)
// compiles app/globals.css plus the page brand over exactly the sources the bundle used, and fonts and
// imagery are inlined. The result is ONE self-contained HTML document. Three lanes:
// - spec: a catalog spec (catalog.ts) the semantic runtime renders,
// - tsx:  generated React importing real components ("@nofun/ui/<name>", "@nofun/kobra/<name>"),
// - page: a json-render page spec composed from the checkout's experiments/json-render catalog.
// Caches key on the checkout's HEAD plus its dirty state, so an edit or a new component shows up on the
// next compile. Nothing generated here runs on the server: esbuild only parses and bundles, and the
// page executes in T3's sandboxed HTML render frame.
import { createHash } from "node:crypto";

import { validateArtifactSpec, type ArtifactSpec } from "./catalog.ts";
import {
  ASSET_SCRIPT,
  STORAGE_SCRIPT,
  EMPTY_ASSETS,
  escapeLocalPaths,
  findAssetPaths,
  inlineAssets,
  type AssetMap,
} from "./live/assets.ts";
import { BundleError, bundle, candidatesOf, candidatesOfFiles } from "./live/bundle.ts";
import { buildCss } from "./live/css.ts";
import { pageCatalogGuide, pageSpecIssues } from "./live/page-catalog.ts";
import { brandScheme, liveIndex, searchIndex, type IndexEntry } from "./live/registry.ts";
import { probeAssets } from "./live/probe.ts";
import { readCompileReport } from "./live/report.ts";
import { assertComponentsDir, perStamp, perStampMap, sourceStamp } from "./live/source.ts";
import { DEFAULT_ARTIFACT_THEME, T3_THEME, isArtifactTheme, artifactThemeIds } from "./themes.ts";

export {
  ArtifactSpecError,
  artifactCatalogGuide,
  ARTIFACT_COMPONENT_NAMES,
  type ArtifactSpec,
} from "./catalog.ts";
export { artifactThemeGuide, artifactThemeIds, DEFAULT_ARTIFACT_THEME } from "./themes.ts";
export { pageCatalogGuide } from "./live/page-catalog.ts";
export { componentsDir, sourceStamp } from "./live/source.ts";
export type { IndexEntry } from "./live/registry.ts";
export { USER_PACKAGES as ARTIFACT_ALLOWED_PACKAGES } from "./live/bundle.ts";

const MAX_TSX_CHARS = 100_000;
/** Below HtmlRender's 25 MiB page cap. */
export const ARTIFACT_MAX_PAGE_BYTES = 24 * 1024 * 1024;

export class ArtifactCompileError extends Error {
  readonly issues: ReadonlyArray<string>;
  constructor(message: string, issues: ReadonlyArray<string> = []) {
    super(issues.length === 0 ? message : `${message}\n- ${issues.slice(0, 20).join("\n- ")}`);
    this.issues = issues;
  }
}

export interface ArtifactCompileInput {
  /** A catalog spec: `{ root: { component, props, children } }`, optionally with theme and title. */
  readonly spec?: unknown;
  /** Custom React TSX with a default-exported component. */
  readonly tsx?: string | undefined;
  readonly theme?: string | undefined;
  readonly title?: string | undefined;
}

export interface PageCompileInput {
  /** A json-render page spec: `{ root, elements }` over experiments/json-render/catalog.ts. */
  readonly spec: unknown;
  /** Brand id (design system) the page is themed and imaged with. */
  readonly brand: string;
  readonly title?: string | undefined;
  /** Defaults to the brand's default scheme. */
  readonly scheme?: "light" | "dark" | undefined;
}

export interface CompiledArtifact {
  readonly html: string;
  readonly title: string;
  readonly theme: string;
  readonly lane: "spec" | "tsx" | "page";
  readonly bytes: number;
  readonly compileMs: number;
  /** nofun-components revision the page was compiled from (HEAD + dirty-state hash). */
  readonly source: string;
  readonly assetBytes: number;
  /** Imagery left out to stay inside the budget. */
  readonly skippedAssets: ReadonlyArray<string>;
  /** Console errors from the headless asset probe, when it ran. */
  readonly warnings: ReadonlyArray<string>;
}

const escapeScript = (text: string) => text.replace(/<\/(script)/gi, "<\\/$1");
const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!,
  );
const jsonScript = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

// Follows T3's light/dark: T3's bootstrap sets `color-scheme` on :root (and rewrites it live), and No Fun
// keys its dark tokens off a `.dark` class. The class goes on <body>, next to the brand scope.
const MODE_SCRIPT = `(function(){var d=document.documentElement,b=document.body;function m(){var c=getComputedStyle(d).colorScheme||"";b.classList.toggle("dark",/dark/.test(c)&&!/light/.test(c))}m();var s=document.getElementById("t3-theme");if(s&&window.MutationObserver)new MutationObserver(m).observe(s,{childList:true,characterData:true,subtree:true});if(window.matchMedia)matchMedia("(prefers-color-scheme: dark)").addEventListener("change",m)})();`;

// The page frame. T3's base sheet sets a 14px root; No Fun sizes assume 16px rem.
const PAGE_FRAME_CSS = `html{font-size:16px}body{margin:0}`;
// Artifacts (spec/tsx) sit inside a reply: a pinned brand paints its own rounded canvas, and `t3`
// points the No Fun tokens at the variables T3 injects so the page follows the reader's app theme.
const ARTIFACT_FRAME_CSS = `${PAGE_FRAME_CSS}
body[data-brand],body[data-nf-theme="t3"]{padding:16px;border-radius:14px;background:var(--nf-canvas,var(--background));color:var(--nf-ink,var(--foreground));--font-weight-medium:400;--font-weight-semibold:700}
body[data-nf-theme="t3"]{--nf-canvas:var(--background);--nf-ink:var(--foreground);--nf-ink-muted:var(--muted-foreground);--nf-rule:var(--border);--nf-surface:var(--muted);--nf-surface-product:var(--card);--nf-accent:var(--accent);--nf-accent-foreground:var(--accent-foreground);--nf-accent-soft:var(--muted);--nf-accent-soft-foreground:var(--foreground);--nf-primary:var(--primary);--nf-primary-foreground:var(--primary-foreground);--nf-success:var(--success);--nf-warning:var(--warning);--nf-danger:var(--destructive);--nf-display:var(--font-sans);--nf-body:var(--font-sans);--nf-mono:var(--font-mono);--error:var(--destructive)}`;

function documentFor(input: {
  readonly title: string;
  readonly css: string;
  readonly bodyAttrs: string;
  readonly preScripts: ReadonlyArray<string>;
  readonly data: string;
  readonly js: string;
  readonly assets: AssetMap;
}) {
  return [
    `<!doctype html><html lang="en"><head>`,
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(input.title)}</title>`,
    `<style id="nf-style">${input.css.replace(/<\/(style)/gi, "<\\/$1")}</style>`,
    `</head><body${input.bodyAttrs}>`,
    `<script>${STORAGE_SCRIPT}</script>`,
    ...input.preScripts.map((script) => `<script>${script}</script>`),
    `<script type="application/json" id="nf-assets">${jsonScript(input.assets.map)}</script>`,
    `<script>${ASSET_SCRIPT}</script>`,
    `<div id="nf-root"></div>`,
    input.data,
    `<script>${escapeScript(escapeLocalPaths(input.js))}</script>`,
    `</body></html>`,
  ].join("");
}

function finish(
  html: string,
  started: number,
  rest: Omit<CompiledArtifact, "html" | "bytes" | "compileMs">,
): CompiledArtifact {
  const bytes = Buffer.byteLength(html);
  if (bytes > ARTIFACT_MAX_PAGE_BYTES) {
    throw new ArtifactCompileError(
      `The artifact is ${(bytes / 1024 / 1024).toFixed(1)} MiB; keep it under ${ARTIFACT_MAX_PAGE_BYTES / 1024 / 1024} MiB (use fewer image-heavy blocks or rows).`,
    );
  }
  return { html, bytes, compileMs: Math.round(performance.now() - started), ...rest };
}

const wrapBundleError = (error: unknown, what: string): never => {
  if (error instanceof BundleError) {
    const noDefault = error.issues.some((issue) => issue.includes('for import "default"'));
    throw new ArtifactCompileError(
      noDefault
        ? "The custom TSX must `export default` a React component."
        : error.rejected.length > 0
          ? `The ${what} imports a module artifacts cannot use.`
          : `The ${what} did not compile.`,
      error.issues,
    );
  }
  throw error;
};

// ---------------------------------------------------------------------------------------------
// Prebuilt bundles for the data lanes (spec, page): one JS bundle per checkout revision, CSS and
// imagery per brand.

interface LaneBundle {
  readonly js: string;
  readonly cssImports: ReadonlyArray<string>;
  readonly candidates: ReadonlyArray<string>;
}

const laneBundle = (entry: string) =>
  perStamp(async (dir): Promise<LaneBundle> => {
    const index = await liveIndex();
    const result = await bundle(dir, index, { entry }).catch((error: unknown) =>
      wrapBundleError(error, "runtime"),
    );
    return {
      js: result.js,
      cssImports: result.cssImports,
      candidates: [...candidatesOfFiles(result.sourceFiles)],
    };
  });

const specBundle = laneBundle(`import { mountSpec } from "./runtime/mount.tsx"; mountSpec();`);
const pageBundle = laneBundle(`import { mountPage } from "./runtime/page.tsx"; mountPage();`);

const laneCss = (lane: () => Promise<LaneBundle>) =>
  perStampMap(async (dir, _stamp, brand) => {
    const built = await lane();
    return buildCss(dir, {
      brand: brand === T3_THEME ? null : brand,
      candidates: built.candidates,
      cssImports: built.cssImports,
      extraCss: lane === pageBundle ? PAGE_FRAME_CSS : ARTIFACT_FRAME_CSS,
    });
  });

const specCss = laneCss(specBundle);
const pageCss = laneCss(pageBundle);

/**
 * The imagery a page uses: what a headless render of it requests (precise), else a static scan of
 * `texts` (over-collects), inlined brand-first within the budget.
 */
async function resolveAssets(
  dir: string,
  draft: string,
  texts: ReadonlyArray<string>,
  brand: string | null,
): Promise<{ assets: AssetMap; warnings: string[] }> {
  const probe = await probeAssets(dir, draft);
  const paths = probe ? probe.paths : findAssetPaths(dir, texts, brand);
  return { assets: inlineAssets(dir, paths, brand), warnings: [...(probe?.errors ?? [])] };
}

/** Page-lane imagery per brand and spec (the spec decides which blocks, and so which images, render). */
const pageAssets = perStampMap(async (dir, _stamp, key) => {
  const { draft, brand } = pendingDrafts.get(key)!;
  const built = await pageBundle();
  return resolveAssets(dir, draft, [built.js], brand);
});
const pendingDrafts = new Map<string, { draft: string; brand: string }>();

function brandBody(dir: string, theme: string): { attrs: string; scripts: string[] } {
  if (theme === T3_THEME) return { attrs: ` data-nf-theme="${T3_THEME}"`, scripts: [MODE_SCRIPT] };
  const { schemes } = brandScheme(dir, theme);
  if (schemes.length === 1) {
    const only = schemes[0]!;
    return {
      attrs: ` data-nf-theme="${theme}" data-brand="${theme}" data-nf-scheme="${only}"${only === "dark" ? ' class="dark" data-theme="dark"' : ""}`,
      scripts: [],
    };
  }
  return { attrs: ` data-nf-theme="${theme}" data-brand="${theme}"`, scripts: [MODE_SCRIPT] };
}

function resolveTheme(requested: string | undefined): string {
  const theme = requested ?? DEFAULT_ARTIFACT_THEME;
  if (!isArtifactTheme(theme)) {
    throw new ArtifactCompileError(
      `Unknown theme "${theme}". Use one of ${artifactThemeIds().join(", ")}.`,
    );
  }
  return theme;
}

/** Compiles one artifact (spec or tsx lane) to a self-contained HTML document. */
export async function compileArtifact(input: ArtifactCompileInput): Promise<CompiledArtifact> {
  const started = performance.now();
  const dir = assertComponentsDir();
  const hasSpec = input.spec !== undefined && input.spec !== null;
  const hasTsx = typeof input.tsx === "string" && input.tsx.trim() !== "";
  if (hasSpec === hasTsx) {
    throw new ArtifactCompileError(
      "Pass exactly one of `spec` (a catalog spec) or `tsx` (custom React).",
    );
  }
  let spec: ArtifactSpec | undefined;
  if (hasSpec) {
    const raw = typeof input.spec === "string" ? parseJson(input.spec) : input.spec;
    spec = validateArtifactSpec(raw);
  }
  const theme = resolveTheme(input.theme ?? spec?.theme);
  const title =
    (input.title ?? spec?.title ?? "No Fun artifact").trim().slice(0, 200) || "No Fun artifact";
  const source = await sourceStamp(dir);
  const body = brandBody(dir, theme);

  if (spec) {
    const [built, css] = await Promise.all([specBundle(), specCss(theme)]);
    const specJson = jsonScript({ root: spec.root });
    const assets = inlineAssets(
      dir,
      findAssetPaths(dir, [specJson], theme === T3_THEME ? null : theme),
      null,
    );
    const html = documentFor({
      title,
      css,
      bodyAttrs: body.attrs,
      preScripts: body.scripts,
      data: `<script type="application/json" id="nf-spec">${escapeLocalPaths(specJson)}</script>`,
      js: built.js,
      assets,
    });
    return finish(html, started, {
      title,
      theme,
      lane: "spec",
      source,
      assetBytes: assets.bytes,
      skippedAssets: assets.skipped,
      warnings: [],
    });
  }

  const tsx = input.tsx!;
  if (tsx.length > MAX_TSX_CHARS) {
    throw new ArtifactCompileError(
      `Custom TSX is ${tsx.length} characters; the limit is ${MAX_TSX_CHARS}.`,
    );
  }
  const index = await liveIndex();
  const built = await bundle(dir, index, {
    entry: `import App from "nf:user";\nimport { mountApp } from "./runtime/mount.tsx";\nmountApp(App);\n`,
    user: tsx,
  }).catch((error: unknown) => wrapBundleError(error, "custom TSX"));
  const brand = theme === T3_THEME ? null : theme;
  const candidates = candidatesOfFiles(built.sourceFiles);
  for (const token of candidatesOf(tsx)) candidates.add(token);
  const css = await buildCss(dir, {
    brand,
    candidates,
    cssImports: built.cssImports,
    extraCss: ARTIFACT_FRAME_CSS,
  });
  const page = (assets: AssetMap) =>
    documentFor({
      title,
      css,
      bodyAttrs: body.attrs,
      preScripts: body.scripts,
      data: "",
      js: built.js,
      assets,
    });
  const { assets, warnings } = await resolveAssets(dir, page(EMPTY_ASSETS), [built.js], brand);
  const html = page(assets);
  return finish(html, started, {
    title,
    theme,
    lane: "tsx",
    source,
    assetBytes: assets.bytes,
    skippedAssets: assets.skipped,
    warnings,
  });
}

/**
 * Compiles a json-render page spec (experiments/json-render catalog) for a brand into a full landing
 * page: the checkout's registry maps each element to the real block and BrandProvider supplies the
 * brand's products and imagery. Throws ArtifactCompileError naming each spec problem.
 */
export async function compilePage(input: PageCompileInput): Promise<CompiledArtifact> {
  const started = performance.now();
  const dir = assertComponentsDir();
  const spec = typeof input.spec === "string" ? parseJson(input.spec) : input.spec;
  const brand = input.brand;
  if (brand === T3_THEME || !isArtifactTheme(brand)) {
    throw new ArtifactCompileError(
      `Unknown brand "${brand}". Use one of ${artifactThemeIds()
        .filter((id) => id !== T3_THEME)
        .join(", ")}.`,
    );
  }
  const issues = await pageSpecIssues(spec);
  if (issues.length > 0)
    throw new ArtifactCompileError("The page spec does not match the page catalog.", issues);
  const { schemes, defaultScheme } = brandScheme(dir, brand);
  const scheme = input.scheme && schemes.includes(input.scheme) ? input.scheme : defaultScheme;
  const title = (input.title ?? "No Fun page").trim().slice(0, 200) || "No Fun page";
  const source = await sourceStamp(dir);
  const [built, css] = await Promise.all([pageBundle(), pageCss(brand)]);
  const data = jsonScript({ spec, brand, scheme, schemes });
  const page = (assets: AssetMap) =>
    documentFor({
      title,
      css,
      bodyAttrs: ` data-nf-theme="${brand}"`,
      preScripts: [],
      data: `<script type="application/json" id="nf-page">${escapeLocalPaths(data)}</script>`,
      js: built.js,
      assets,
    });
  const key = `${brand}:${createHash("sha256").update(data).digest("hex")}`;
  pendingDrafts.set(key, { draft: page(EMPTY_ASSETS), brand });
  const { assets, warnings } = await pageAssets(key).finally(() => pendingDrafts.delete(key));
  const html = page(assets);
  return finish(html, started, {
    title,
    theme: brand,
    lane: "page",
    source,
    assetBytes: assets.bytes,
    skippedAssets: assets.skipped,
    warnings,
  });
}

/** The page catalog's validation problems for a spec, without compiling (empty when valid). */
export async function validatePageSpec(spec: unknown): Promise<string[]> {
  return pageSpecIssues(typeof spec === "string" ? parseJson(spec) : spec);
}

export interface ComponentMatch {
  readonly name: string;
  readonly kind: IndexEntry["kind"];
  readonly category: string;
  readonly title: string;
  readonly description: string;
  readonly import?: string;
  readonly snippet?: string;
  readonly demo?: string;
  readonly style: ReadonlyArray<string>;
  readonly props: ReadonlyArray<string>;
  readonly brand?: string;
}

/** Ranked components for a query, as import snippets and prop hints (never the whole index). */
export async function searchComponents(input: {
  readonly query: string;
  readonly category?: string | undefined;
  readonly limit?: number | undefined;
}): Promise<ComponentMatch[]> {
  const index = await liveIndex();
  const failing = failingComponents();
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 20);
  return searchIndex(index.entries, input.query, {
    category: input.category,
    limit,
    exclude: failing,
  }).map((entry) => {
    const named =
      entry.mainComponent && entry.exports.includes(entry.mainComponent)
        ? [entry.mainComponent, ...entry.exports.filter((name) => name !== entry.mainComponent)]
        : entry.exports;
    // Every part: a block's plot or legend is often past the sixth export, and an agent cannot import what it never sees.
    const parts = named.filter((name) => /^[A-Z]/.test(name)).slice(0, 16);
    return {
      name: entry.name,
      kind: entry.kind,
      category: entry.category,
      title: entry.title,
      description: entry.description.slice(0, 500),
      ...(entry.import ? { import: entry.import } : {}),
      ...(entry.import && parts.length > 0
        ? { snippet: `import { ${parts.join(", ")} } from "${entry.import}";` }
        : {}),
      ...(entry.demo
        ? {
            demo: `import { ${entry.demo.export} } from "${entry.demo.import}"; // a working example; render <${entry.demo.export} />`,
          }
        : {}),
      style: entry.style,
      props: entry.props.map(
        (prop) =>
          `${prop.name}${prop.type ? `: ${prop.type}` : ""}${prop.default ? ` = ${prop.default}` : ""}${prop.description ? ` (${prop.description.slice(0, 120)})` : ""}`,
      ),
      ...(entry.brand ? { brand: entry.brand } : {}),
    };
  });
}

/** Components the last `sync` found failing to compile in isolation (left out of search). */
function failingComponents(): ReadonlySet<string> {
  const report = readCompileReport();
  return new Set(report?.failures.map((failure) => failure.name) ?? []);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ArtifactCompileError(`The spec is not valid JSON: ${(error as Error).message}`);
  }
}

/** Builds the spec-lane runtime and stylesheet ahead of the first artifact. */
export async function warmArtifactCompiler() {
  await specCss(DEFAULT_ARTIFACT_THEME);
}

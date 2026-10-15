// Assets for a self-contained page. nofun-components serves its imagery and fonts from public/ by
// absolute path ("/brands/hoopla/media/x.jpg", url("/fonts/...")). An artifact has no server, so:
// - CSS url()s are inlined as data URIs,
// - image/video paths the bundle names are inlined into an asset map (`#nf-assets`) that a tiny
//   runtime applies to <img>, <video>, srcset and inline styles as React renders them,
// - every remaining absolute image path in the page is escaped ("\/brands/...", same string at
//   runtime) so T3's HtmlRender does not try to inline it from the host disk.
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  mp4: "video/mp4",
  webm: "video/webm",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
};

const ASSET_EXT = "png|jpe?g|gif|webp|avif|svg|mp4|webm";

/** Encoded (data URI) bytes of imagery a page may inline when the caller has no tighter room. */
export const ASSET_BUDGET_BYTES = 20 * 1024 * 1024;
const MAX_ONE_ASSET_BYTES = 6 * 1024 * 1024;

export function dataUri(file: string): string | undefined {
  const ext = NodePath.extname(file).slice(1).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return undefined;
  try {
    return `data:${mime};base64,${NodeFs.readFileSync(file).toString("base64")}`;
  } catch {
    return undefined;
  }
}

function publicFile(dir: string, urlPath: string): string | undefined {
  let clean = urlPath.split(/[?#]/)[0]!;
  try {
    clean = decodeURI(clean);
  } catch {
    // keep as is
  }
  const file = NodePath.join(dir, "public", clean);
  if (!file.startsWith(NodePath.join(dir, "public") + NodePath.sep)) return undefined;
  try {
    return NodeFs.statSync(file).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

const CSS_URL = /url\(\s*(["']?)(\/(?!\/)[^"')\s]+)\1\s*\)/g;

/** Inlines checkout-served url()s in a stylesheet; unknown local ones become empty. */
export function inlineCssUrls(dir: string, css: string): string {
  return css.replace(CSS_URL, (_match, _quote: string, path: string) => {
    const file = publicFile(dir, path);
    const uri = file ? dataUri(file) : undefined;
    return uri ? `url("${uri}")` : `url("data:,")`;
  });
}

const ABSOLUTE_REF = new RegExp(
  String.raw`(?<![\w.:/])\/(?!\/)[A-Za-z0-9_@%+\-][A-Za-z0-9_@%+\-./]*\.(?:${ASSET_EXT})(?![\w])`,
  "gi",
);
const RELATIVE_REF = new RegExp(
  String.raw`["'\x60]([A-Za-z0-9_\-][A-Za-z0-9_\-./]*\.(?:${ASSET_EXT}))["'\x60]`,
  "gi",
);

export interface AssetMap {
  /** Keyed by path without the leading slash ("brands/x/a.jpg"). */
  readonly map: Record<string, string>;
  readonly bytes: number;
  readonly skipped: ReadonlyArray<string>;
}

/**
 * Static scan for the public files a bundle may use: whole absolute paths, plus relative names
 * (`media/a.jpg`) found under the page brand's folder (blocks often build `/brands/${brand}/${path}`).
 * Over-collects (fixtures name many brands); the browser probe is the precise path.
 */
export function findAssetPaths(
  dir: string,
  texts: ReadonlyArray<string>,
  brand: string | null,
): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(ABSOLUTE_REF)) {
      if (!found.has(match[0]) && publicFile(dir, match[0])) found.add(match[0]);
    }
    if (brand) {
      for (const match of text.matchAll(RELATIVE_REF)) {
        const path = `/brands/${brand}/${match[1]!}`;
        if (!found.has(path) && publicFile(dir, path)) found.add(path);
      }
    }
  }
  return [...found];
}

/** Inlines public files as data URIs: the page brand's first, then shared ones, then other brands', up to `budget` encoded bytes. */
export function inlineAssets(
  dir: string,
  paths: Iterable<string>,
  brand: string | null,
  budget = ASSET_BUDGET_BYTES,
): AssetMap {
  const rank = (path: string) =>
    brand && path.startsWith(`/brands/${brand}/`) ? 0 : path.startsWith("/brands/") ? 2 : 1;
  const ordered = [...new Set(paths)].sort(
    (a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0),
  );
  const map: Record<string, string> = {};
  const skipped: string[] = [];
  let bytes = 0;
  for (const path of ordered) {
    const file = publicFile(dir, path);
    if (!file) continue;
    if (NodeFs.statSync(file).size > MAX_ONE_ASSET_BYTES) {
      skipped.push(path);
      continue;
    }
    const uri = dataUri(file);
    if (!uri) continue;
    if (bytes + uri.length > budget) {
      skipped.push(path);
      continue;
    }
    map[path.slice(1)] = uri;
    bytes += uri.length;
  }
  return { map, bytes, skipped };
}

export const EMPTY_ASSETS: AssetMap = { map: {}, bytes: 0, skipped: [] };

const STAGE_IMAGE = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;

export interface StageAssetFile {
  /** Posix path in the bundle, always under `assets/`. */
  readonly bundlePath: string;
  readonly bytes: Buffer;
  /** `#nf-assets` key. The runtime strips a leading slash, so this has none. */
  readonly mapKey: string;
  /** Set when the data URI still fits in the inline budget. The file is copied either way. */
  readonly dataUri: string | undefined;
}

export interface StagedAssets {
  readonly text: string;
  readonly files: readonly StageAssetFile[];
  /** Copied, but left out of `#nf-assets` because the inline budget was full. */
  readonly skippedInline: readonly string[];
}

function assertAssetDir(dir: string): string {
  const resolved = NodePath.resolve(dir);
  let stat: NodeFs.Stats;
  try {
    stat = NodeFs.lstatSync(resolved);
  } catch {
    throw new Error(`--asset-dir ${resolved} does not exist.`);
  }
  if (stat.isSymbolicLink()) throw new Error(`--asset-dir ${resolved} is a symlink.`);
  if (!stat.isDirectory()) throw new Error(`--asset-dir ${resolved} is not a directory.`);
  return resolved;
}

function containedFile(root: string, file: string): string | undefined {
  let stat: NodeFs.Stats;
  try {
    stat = NodeFs.lstatSync(file);
  } catch {
    return undefined;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
  const realRoot = NodeFs.realpathSync(root);
  const realFile = NodeFs.realpathSync(file);
  const prefix = realRoot.endsWith(NodePath.sep) ? realRoot : realRoot + NodePath.sep;
  if (!realFile.startsWith(prefix)) return undefined;
  return realFile;
}

function toBundlePath(relFromRoot: string): string {
  const rel = relFromRoot.split(NodePath.sep).join("/");
  const body = rel.startsWith("assets/") ? rel.slice("assets/".length) : rel;
  const parts = body.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`stage image ${relFromRoot} cannot be placed under assets/.`);
  }
  return `assets/${parts.join("/")}`;
}

function resolveStageFile(root: string, ref: string): string | undefined {
  let clean = ref.split(/[?#]/)[0] ?? "";
  try {
    clean = decodeURI(clean);
  } catch {
    // keep the raw reference
  }
  if (clean.includes("\0")) return undefined;
  if (NodePath.isAbsolute(clean)) return containedFile(root, clean);
  const normalized = NodePath.posix.normalize(clean.replaceAll("\\", "/"));
  if (normalized.startsWith("../") || normalized === ".." || normalized.startsWith("/")) {
    return undefined;
  }
  const candidates = [normalized];
  if (normalized.startsWith("assets/")) {
    const stripped = normalized.slice("assets/".length);
    if (stripped) candidates.push(stripped);
  }
  for (const rel of candidates) {
    if (rel.startsWith("../") || rel === ".." || NodePath.isAbsolute(rel)) continue;
    const hit = containedFile(root, NodePath.resolve(root, rel));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Copies image references that live in `assetDir` into bundle `assets/`.
 * `assets/tile.webp` resolves to that path or to `tile.webp` in the directory.
 * Absolute paths inside the directory are rewritten to the bundle path.
 * Paths outside the directory, including `..`, are left untouched.
 */
export function stageAssets(assetDir: string, text: string): StagedAssets {
  // realpath so macOS /var -> /private/var matches the realpath'd files below.
  const root = NodeFs.realpathSync(assertAssetDir(assetDir));
  const refs = new Set<string>();
  for (const match of text.matchAll(/["'`]([^"'`\r\n]+)["'`]/g)) {
    const value = match[1]!;
    if (!STAGE_IMAGE.test(value) || value.startsWith("data:") || /^https?:/i.test(value)) continue;
    refs.add(value);
  }
  const files = new Map<string, StageAssetFile>();
  const replacements = new Map<string, string>();
  let copied = 0;
  let inlineBytes = 0;
  const skippedInline: string[] = [];
  for (const ref of [...refs].sort((a, b) => b.length - a.length)) {
    const file = resolveStageFile(root, ref);
    if (!file) continue;
    const bundlePath = toBundlePath(NodePath.relative(root, file));
    let staged = files.get(bundlePath);
    if (!staged) {
      const bytes = NodeFs.readFileSync(file);
      if (bytes.length > MAX_ONE_ASSET_BYTES) {
        throw new Error(
          `${ref} is ${bytes.length} bytes; a stage image must be at most ${MAX_ONE_ASSET_BYTES}.`,
        );
      }
      copied += bytes.length;
      if (copied > ASSET_BUDGET_BYTES) {
        throw new Error(
          `Stage images are over the ${ASSET_BUDGET_BYTES} byte budget (stopped at ${ref}).`,
        );
      }
      const encoded = dataUri(file);
      let dataUriValue: string | undefined;
      if (encoded && inlineBytes + encoded.length <= ASSET_BUDGET_BYTES) {
        dataUriValue = encoded;
        inlineBytes += encoded.length;
      } else {
        skippedInline.push(bundlePath);
      }
      staged = { bundlePath, bytes, mapKey: bundlePath, dataUri: dataUriValue };
      files.set(bundlePath, staged);
    }
    if (ref !== bundlePath) replacements.set(ref, bundlePath);
  }
  let rewritten = text;
  for (const [from, to] of [...replacements.entries()].sort((a, b) => b[0].length - a[0].length)) {
    for (const quote of [`"`, `'`, "`"]) {
      rewritten = rewritten.replaceAll(`${quote}${from}${quote}`, `${quote}${to}${quote}`);
    }
  }
  return { text: rewritten, files: [...files.values()], skippedInline };
}

/** Merges staged data URIs into `#nf-assets` so the page resolves them without a file server. */
export function inlineStageAssets(html: string, files: readonly StageAssetFile[]): string {
  const inlined = files.filter((file) => file.dataUri);
  if (inlined.length === 0) return html;
  const pattern = /<script type="application\/json" id="nf-assets">([\s\S]*?)<\/script>/;
  const match = pattern.exec(html);
  if (!match) return html;
  let map: Record<string, string> = {};
  try {
    const parsed = JSON.parse(match[1]!) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      map = parsed as Record<string, string>;
    }
  } catch {
    map = {};
  }
  for (const file of inlined) map[file.mapKey] = file.dataUri!;
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(map).sort()) sorted[key] = map[key]!;
  const json = JSON.stringify(sorted).replace(/</g, "\\u003c");
  return html.replace(pattern, `<script type="application/json" id="nf-assets">${json}</script>`);
}

// The same pattern T3's HtmlRender uses to find local images to inline.
const IMAGE_EXTENSIONS = "png|jpg|jpeg|gif|webp|avif|svg|bmp|ico";
const ABSOLUTE_PATH = String.raw`(?:/(?!/)|[a-z]:[\\/])`;
const LOCAL_IMAGE_PATTERN = new RegExp(
  String.raw`(["'\x60])(${ABSOLUTE_PATH}(?:(?!\1)[^\r\n]){0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1` +
    String.raw`|url\(\s*(${ABSOLUTE_PATH}[^\s"'\x60()]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))\s*\)`,
  "gi",
);

/** Escapes the leading slash of every quoted absolute image path (`"\/a.png"` is still "/a.png" in JS and JSON). */
export function escapeLocalPaths(text: string): string {
  return text.replace(
    LOCAL_IMAGE_PATTERN,
    (
      match,
      quote: string | undefined,
      quoted: string | undefined,
      unquoted: string | undefined,
    ) => {
      if (quote && quoted) {
        return quoted.startsWith("/")
          ? `${quote}\\${quoted}${quote}`
          : `${quote}${quoted.replace(/^([a-z]):/i, "$1\\u003a")}${quote}`;
      }
      if (unquoted) return `url(data:,)`;
      return match;
    },
  );
}

/** Rewrites asset paths to the inlined data URIs as the page renders (img/src, srcset, video, styles). */
export const ASSET_SCRIPT = `(function(){var e=document.getElementById("nf-assets");var A={};try{A=JSON.parse(e?e.textContent:"{}")}catch(x){}
function r(u){if(typeof u!=="string"||u.slice(0,5)==="data:")return;var k=u.replace(/^https?:\\/\\/[^\\/]+/,"").split("?")[0].split("#")[0].replace(/^\\//,"");try{k=decodeURI(k)}catch(x){}return A[k]}
function fs(s){return s.replace(/url\\((['"]?)([^'")]+)\\1\\)/g,function(m,q,u){var d=r(u);return d?'url("'+d+'")':m})}
function fix(n){if(!n||n.nodeType!==1)return;["src","poster","href","xlink:href"].forEach(function(a){var v=n.getAttribute(a);var d=v&&r(v);if(d)n.setAttribute(a,d)});var ss=n.getAttribute("srcset");if(ss&&ss.indexOf("data:")<0){var o=ss.split(",").map(function(p){var q=p.trim().split(/\\s+/);var d=r(q[0]);if(d)q[0]=d;return q.join(" ")}).join(", ");if(o!==ss)n.setAttribute("srcset",o)}var st=n.getAttribute("style");if(st&&st.indexOf("url(")>=0){var f=fs(st);if(f!==st)n.setAttribute("style",f)}}
function walk(n){if(!n||n.nodeType!==1)return;fix(n);n.querySelectorAll("img,source,video,image,use,[style*='url(']").forEach(fix)}
new MutationObserver(function(ms){ms.forEach(function(m){if(m.type==="attributes")fix(m.target);else m.addedNodes.forEach(walk)})}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:["src","srcset","poster","style","href"]});
[[window.HTMLImageElement,"src"],[window.HTMLMediaElement,"src"],[window.HTMLSourceElement,"src"]].forEach(function(p){if(!p[0])return;var d=Object.getOwnPropertyDescriptor(p[0].prototype,p[1]);if(!d||!d.set)return;Object.defineProperty(p[0].prototype,p[1],{configurable:true,enumerable:d.enumerable,get:d.get,set:function(v){d.set.call(this,r(v)||v)}})});
window.__nfAsset=function(u){return r(u)||u};})();`;

/** Sandboxed frames can throw on storage access; blocks that remember UI state get an in-memory store. */
export const STORAGE_SCRIPT = `(function(){function mk(){var s={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(s,k)?s[k]:null},setItem:function(k,v){s[k]=String(v)},removeItem:function(k){delete s[k]},clear:function(){s={}},key:function(i){return Object.keys(s)[i]||null},get length(){return Object.keys(s).length}}}["localStorage","sessionStorage"].forEach(function(n){try{window[n].getItem("nf")}catch(x){try{Object.defineProperty(window,n,{value:mk(),configurable:true})}catch(y){}}})})();`;

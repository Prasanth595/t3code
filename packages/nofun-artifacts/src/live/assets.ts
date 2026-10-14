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
  const ordered = [...new Set(paths)].sort((a, b) => rank(a) - rank(b));
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

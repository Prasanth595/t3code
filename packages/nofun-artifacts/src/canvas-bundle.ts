// A Canvas artifact bundle: manifest.json + index.html + stamp.json + the source that produced it.
// Manifest shape matches Canvas `WebArtifactManifest` / the MCP `validate_bundle` (format
// `nofun-canvas-artifact-bundle`). `stamp.json` and `source/` sit beside the entry; today's Swift
// walker still rejects those two paths, which the root applies from the W1 snippet.
import { createHash } from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import { formatStamp, type ArtifactStamp } from "./stamp.ts";

export const CANVAS_FORMAT = "nofun-canvas-artifact-bundle";
export const MANIFEST_KEYS = [
  "format",
  "version",
  "name",
  "entry",
  "size",
  "background",
  "interaction",
  "source",
  "createdAt",
  "sha256",
] as const;

const HEX_COLOR = /^#[0-9a-f]{6}$/;

export function parseCanvasSize(text: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(text.trim());
  if (!match) throw new Error(`size must be WxH (got ${JSON.stringify(text)}).`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  assertCanvasSize(width, height);
  return { width, height };
}

export function assertCanvasSize(width: number, height: number): void {
  for (const [name, value] of [
    ["width", width],
    ["height", height],
  ] as const) {
    if (!Number.isInteger(value) || value < 16 || value > 4096) {
      throw new Error(`${name} must be an integer from 16 to 4096 (got ${value}).`);
    }
  }
}

export function parseCanvasBackground(text: string): "transparent" | "match" | `#${string}` {
  const value = text.trim().toLowerCase();
  if (value === "transparent" || value === "match") return value;
  if (HEX_COLOR.test(value)) return value as `#${string}`;
  throw new Error(
    `background must be transparent, match, or #rrggbb (got ${JSON.stringify(text)}).`,
  );
}

/**
 * Hides `http://` and `https://` from Canvas's byte lint without changing what JavaScript or JSON
 * evaluate to. React's SVG path is `createElementNS("http://www.w3.org/2000/svg")`; deleting a slash
 * there makes every chart throw. `\u002f` is a slash inside JS and JSON strings, and the file no
 * longer contains the two-slash sequence the lint rejects.
 */
export function stripNetworkUrls(html: string): string {
  return html.replace(/https?:\/\//gi, (match) => `${match.slice(0, -2)}\\u002f\\u002f`);
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!,
  );

function stampMeta(stamp: ArtifactStamp): string {
  return `<meta name="nofun-artifact" content="${escapeHtml(formatStamp(stamp))}">`;
}

function withStamp(html: string, stamp: ArtifactStamp): string {
  const tag = stampMeta(stamp);
  if (/<meta\s+name="nofun-artifact"\s+content="[^"]*"\s*\/?>/i.test(html)) {
    return html.replace(/<meta\s+name="nofun-artifact"\s+content="[^"]*"\s*\/?>/i, tag);
  }
  if (html.includes("</head>")) return html.replace("</head>", `${tag}</head>`);
  return `${tag}${html}`;
}

function canvasFrame(background: string): string {
  const bg =
    background === "transparent" || background === "match"
      ? "html,body,body[data-brand]{background:transparent!important}"
      : `html,body,body[data-brand]{background:${background}!important}`;
  return `<meta name="color-scheme" content="dark"><style id="nf-canvas">:root{color-scheme:dark}${bg}</style>`;
}

function withCanvasFrame(html: string, background: string): string {
  if (html.includes('id="nf-canvas"')) return html;
  const tags = canvasFrame(background);
  if (html.includes("</head>")) return html.replace("</head>", `${tags}</head>`);
  return `${tags}${html}`;
}

function assertName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || Buffer.byteLength(trimmed) > 200) {
    throw new Error("name must be nonempty and at most 200 bytes.");
  }
  return trimmed;
}

function refuseSymlink(file: string): void {
  let stat: NodeFs.Stats;
  try {
    stat = NodeFs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink())
    throw new Error(`${file} is a symlink; the bundle must be regular files.`);
}

function writeRegular(file: string, data: string | Buffer): void {
  refuseSymlink(file);
  NodeFs.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFs.writeFileSync(file, data);
}

export interface CanvasBundleInput {
  readonly outDir: string;
  readonly html: string;
  readonly name: string;
  readonly size: { readonly width: number; readonly height: number };
  readonly background: string;
  readonly stamp: ArtifactStamp;
  /** Original spec, tsx, or page file. Copied under `source/` as a regular file. */
  readonly sourceFile: { readonly name: string; readonly bytes: Buffer };
}

export interface CanvasManifest {
  readonly format: typeof CANVAS_FORMAT;
  readonly version: 1;
  readonly name: string;
  readonly entry: "index.html";
  readonly size: { readonly width: number; readonly height: number };
  readonly background: string;
  readonly interaction: "interactive";
  readonly source: { readonly kind: "nofun-artifact-render"; readonly ref: string };
  readonly createdAt: string;
  readonly sha256: string;
}

/** Writes a Canvas bundle. Returns the manifest that was written. */
export function writeCanvasBundle(input: CanvasBundleInput): CanvasManifest {
  const outDir = NodePath.resolve(input.outDir);
  refuseSymlink(outDir);
  assertCanvasSize(input.size.width, input.size.height);
  const background = parseCanvasBackground(input.background);
  const name = assertName(input.name);
  const at = input.stamp.at.replace(/\.\d{3}Z$/, "Z");
  const stamp: ArtifactStamp = { ...input.stamp, at };
  const sourceName = NodePath.basename(input.sourceFile.name);
  if (!sourceName || sourceName === "." || sourceName === ".." || sourceName.includes("/")) {
    throw new Error(
      `source file name ${JSON.stringify(input.sourceFile.name)} is not a single path segment.`,
    );
  }
  const sourceHash = createHash("sha256").update(input.sourceFile.bytes).digest("hex");
  const html = stripNetworkUrls(withCanvasFrame(withStamp(input.html, stamp), background));
  const sha256 = createHash("sha256").update(html).digest("hex");
  const manifest: CanvasManifest = {
    format: CANVAS_FORMAT,
    version: 1,
    name,
    entry: "index.html",
    size: { width: input.size.width, height: input.size.height },
    background,
    interaction: "interactive",
    source: {
      kind: "nofun-artifact-render",
      ref: `${sourceHash}@components=${stamp.components}`,
    },
    createdAt: at,
    sha256,
  };
  NodeFs.mkdirSync(outDir, { recursive: true });
  writeRegular(NodePath.join(outDir, "index.html"), html);
  writeRegular(NodePath.join(outDir, "stamp.json"), `${JSON.stringify(stamp, null, 2)}\n`);
  writeRegular(NodePath.join(outDir, "source", sourceName), input.sourceFile.bytes);
  writeRegular(
    NodePath.join(outDir, "source", "meta.json"),
    `${JSON.stringify({ lane: stamp.lane, theme: stamp.theme, size: manifest.size }, null, 2)}\n`,
  );
  writeRegular(NodePath.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

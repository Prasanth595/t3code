// The revision line baked into every compiled page, and the parser agents use to read it back.
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

export interface ArtifactStamp {
  /** Full nofun-components commit the page was compiled from. */
  readonly components: string;
  /** `@t3tools/nofun-artifacts` package version (`0.0.0` when the package is unversioned). */
  readonly compiler: string;
  readonly lane: "spec" | "tsx" | "page";
  readonly theme: string;
  /** UTC instant, `YYYY-MM-DDTHH:mm:ssZ` (no fractional seconds; Canvas decodes that form). */
  readonly at: string;
}

const PACKAGE_JSON = NodePath.join(
  NodePath.dirname(fileURLToPath(import.meta.url)),
  "..",
  "package.json",
);

export function compilerVersion(): string {
  try {
    const pkg = JSON.parse(NodeFs.readFileSync(PACKAGE_JSON, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** ISO-8601 instant Canvas accepts (`withInternetDateTime`, no fractional seconds). */
export function stampInstant(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function formatStamp(stamp: ArtifactStamp): string {
  return `components=${stamp.components};compiler=${stamp.compiler};lane=${stamp.lane};theme=${stamp.theme};at=${stamp.at}`;
}

const unescapeHtml = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

/** Reads the `nofun-artifact` meta tag. Undefined when the tag is missing or incomplete. */
export function readStamp(html: string): ArtifactStamp | undefined {
  const match = /<meta\s+name="nofun-artifact"\s+content="([^"]*)"/i.exec(html);
  if (!match?.[1]) return undefined;
  const fields = new Map<string, string>();
  for (const part of unescapeHtml(match[1]).split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const components = fields.get("components");
  const compiler = fields.get("compiler");
  const lane = fields.get("lane");
  const theme = fields.get("theme");
  const at = fields.get("at");
  if (!components || !compiler || !theme || !at) return undefined;
  if (lane !== "spec" && lane !== "tsx" && lane !== "page") return undefined;
  return { components, compiler, lane, theme, at };
}

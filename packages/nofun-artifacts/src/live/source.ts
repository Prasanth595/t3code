// Where the live No Fun component library lives and which revision of it a build saw. The checkout is
// read-only to us: we bundle straight from its sources and node_modules and never run its scripts.
// Resolution is `NOFUN_COMPONENTS_DIR`, else the pin cache `~/.nofun-t3/caches/nofun-components@<sha>`
// (`components.pin`). A dirty checkout, or one whose HEAD is not that pin, is refused unless
// `NOFUN_COMPONENTS_ALLOW_DIRTY=1`.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const PACKAGE_ROOT = NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), "../..");

export const COMPONENTS_PIN_FILE = NodePath.join(PACKAGE_ROOT, "components.pin");
export const DEFAULT_COMPONENTS_DIR = "/Users/nofun/Documents/GitHub/nofun-components";

/** The sha in `components.pin` (abbreviated or full). */
export function readComponentsPin(): string {
  let text: string;
  try {
    text = NodeFs.readFileSync(COMPONENTS_PIN_FILE, "utf8");
  } catch {
    throw new Error(
      `Missing ${COMPONENTS_PIN_FILE}. It holds the nofun-components sha this compiler builds from.`,
    );
  }
  const pin = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!/^[0-9a-f]{7,40}$/.test(pin)) {
    throw new Error(`components.pin must be a git sha, not ${JSON.stringify(pin)}.`);
  }
  return pin;
}

/** `~/.nofun-t3/caches/nofun-components@<pin>`. */
export function pinnedCacheDir(pin = readComponentsPin()): string {
  return NodePath.join(homedir(), ".nofun-t3", "caches", `nofun-components@${pin}`);
}

/** The nofun-components checkout: `NOFUN_COMPONENTS_DIR`, else the pin cache. */
export function componentsDir(): string {
  const override = process.env.NOFUN_COMPONENTS_DIR?.trim();
  if (override) return NodePath.resolve(override);
  return pinnedCacheDir();
}

function gitText(dir: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return undefined;
  }
}

/** Full HEAD commit, else the sha encoded in a `nofun-components@<sha>` directory name, else the pin. */
export function componentsCommit(dir = componentsDir()): string {
  const head = gitText(dir, ["rev-parse", "HEAD"]);
  if (head && /^[0-9a-f]{40}$/i.test(head)) return head.toLowerCase();
  const named = /^nofun-components@([0-9a-f]{7,40})$/i.exec(NodePath.basename(dir));
  if (named?.[1]) return named[1].toLowerCase();
  return readComponentsPin();
}

function allowDirty(): boolean {
  return process.env.NOFUN_COMPONENTS_ALLOW_DIRTY === "1";
}

function assertPinnedClean(dir: string): void {
  if (allowDirty()) return;
  const pin = readComponentsPin();
  const head = gitText(dir, ["rev-parse", "HEAD"]);
  const status = gitText(dir, ["status", "--porcelain", "--untracked-files=all"]);
  const dirty = status !== undefined && status.length > 0;
  const pinned = head !== undefined && head.toLowerCase().startsWith(pin);
  if (pinned && !dirty) return;
  const headLabel = head ? head.slice(0, 12) : "not a git checkout";
  const problem = [dirty ? "dirty" : "", pinned ? "" : `not pinned to ${pin} (HEAD ${headLabel})`]
    .filter(Boolean)
    .join(" and ");
  throw new Error(
    `nofun-components at ${dir} is ${problem}. Set NOFUN_COMPONENTS_ALLOW_DIRTY=1 to compile it anyway, or run \`node scripts/sync.ts --cache\` to build ~/.nofun-t3/caches/nofun-components@${pin}.`,
  );
}

export function assertComponentsDir(dir = componentsDir()): string {
  if (!NodeFs.existsSync(NodePath.join(dir, "registry.json"))) {
    let pin = "";
    try {
      pin = readComponentsPin();
    } catch {
      pin = "";
    }
    const cache = pin ? pinnedCacheDir(pin) : "";
    const hint =
      !process.env.NOFUN_COMPONENTS_DIR?.trim() &&
      cache &&
      NodePath.resolve(dir) === NodePath.resolve(cache)
        ? ` Pinned cache ${cache} is missing. Run \`node scripts/sync.ts --cache\` from packages/nofun-artifacts.`
        : ` Set NOFUN_COMPONENTS_DIR to a checkout, or run sync --cache for pin ${pin || "(unreadable)"}.`;
    throw new Error(`No nofun-components checkout at ${dir} (registry.json missing).${hint}`);
  }
  if (!NodeFs.existsSync(NodePath.join(dir, "node_modules", "react"))) {
    throw new Error(`${dir} has no node_modules; install its dependencies there first.`);
  }
  assertPinnedClean(dir);
  return dir;
}

let stampCache: { dir: string; at: number; stamp: Promise<string> } | undefined;
const STAMP_TTL_MS = 2_000;

/**
 * HEAD plus a hash of the dirty state (status lines and the size/mtime of each dirty file), so an edit,
 * a new component or a pull invalidates every cache keyed on it. Re-read at most every two seconds.
 */
export function sourceStamp(dir = componentsDir()): Promise<string> {
  const now = Date.now();
  if (stampCache && stampCache.dir === dir && now - stampCache.at < STAMP_TTL_MS) {
    return stampCache.stamp;
  }
  const stamp = (async () => {
    const git = (args: string[]) =>
      run("git", ["-C", dir, ...args], { maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout);
    const [head, status] = await Promise.all([
      git(["rev-parse", "HEAD"]).catch(() => "nogit"),
      git(["status", "--porcelain", "--untracked-files=all"]).catch(() => ""),
    ]);
    const hash = createHash("sha256").update(head.trim());
    for (const line of status.split("\n")) {
      if (!line) continue;
      hash.update(line);
      const file = line.slice(3).split(" -> ").pop()!.replace(/^"|"$/g, "");
      try {
        const stat = NodeFs.statSync(NodePath.join(dir, file));
        hash.update(`${stat.size}:${stat.mtimeMs}`);
      } catch {
        hash.update("gone");
      }
    }
    return `${head.trim().slice(0, 12)}-${hash.digest("hex").slice(0, 12)}`;
  })();
  stampCache = { dir, at: now, stamp };
  stamp.catch(() => {
    if (stampCache?.stamp === stamp) stampCache = undefined;
  });
  return stamp;
}

/** Memoizes one value per source stamp; a new stamp drops the old value. */
export function perStamp<T>(build: (dir: string, stamp: string) => Promise<T>) {
  let cached: { key: string; value: Promise<T> } | undefined;
  return async (): Promise<T> => {
    const dir = assertComponentsDir();
    const stamp = await sourceStamp(dir);
    const key = `${dir}@${stamp}`;
    if (cached?.key !== key) {
      const value = build(dir, stamp);
      cached = { key, value };
      value.catch(() => {
        if (cached?.value === value) cached = undefined;
      });
    }
    return cached.value;
  };
}

/** Memoizes many values per source stamp, keyed by `id`. */
export function perStampMap<T>(build: (dir: string, stamp: string, id: string) => Promise<T>) {
  let cached: { key: string; values: Map<string, Promise<T>> } | undefined;
  return async (id: string): Promise<T> => {
    const dir = assertComponentsDir();
    const stamp = await sourceStamp(dir);
    const key = `${dir}@${stamp}`;
    if (cached?.key !== key) cached = { key, values: new Map() };
    const values = cached.values;
    let value = values.get(id);
    if (!value) {
      value = build(dir, stamp, id);
      values.set(id, value);
      const settled = value;
      settled.catch(() => {
        if (values.get(id) === settled) values.delete(id);
      });
    }
    return value;
  };
}

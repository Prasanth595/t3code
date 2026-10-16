// @effect-diagnostics nodeBuiltinImport:off - home selection must finish synchronously before pre-ready settings and the Effect config provider are acquired.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const SELECTOR_NAME = ".nofun-t3-desktop.json";
const MAX_SELECTOR_BYTES = 4096;

// Reject links and writable ancestors so a different user cannot redirect the
// selected identity between validation and the first settings/database open.
function validateDirectoryPath(directory: string, uid: number): void {
  let current = directory;
  while (true) {
    const stat = NodeFS.lstatSync(current);
    if (
      !stat.isDirectory() ||
      (stat.mode & 0o022) !== 0 ||
      (stat.uid !== uid && stat.uid !== 0) ||
      (current === directory && stat.uid !== uid)
    ) {
      throw new Error(
        "Home paths must be owned directories without symlinks or group/other write access.",
      );
    }
    const parent = NodePath.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function validateSelector(stat: NodeFS.Stats, uid: number): void {
  if (
    !stat.isFile() ||
    stat.uid !== uid ||
    stat.nlink !== 1 ||
    ((stat.mode & 0o7777) !== 0o600 && (stat.mode & 0o7777) !== 0o400) ||
    stat.size === 0 ||
    stat.size > MAX_SELECTOR_BYTES
  ) {
    throw new Error(
      "The selector must be an owner-only regular file (mode 600 or 400), without links, of 1–4096 bytes.",
    );
  }
}

/** Applies a machine-local desktop identity before any stateful service starts. */
export function applyDesktopHomeOverride(): void {
  if (process.env.T3CODE_HOME?.trim()) return;

  const homeDirectory = NodePath.resolve(NodeOS.homedir());
  const selectorPath = NodePath.join(homeDirectory, SELECTOR_NAME);
  try {
    let selectorStat: NodeFS.Stats;
    try {
      selectorStat = NodeFS.lstatSync(selectorPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }

    const uid = process.getuid?.();
    if (uid === undefined) {
      throw new Error(
        "Local home selectors require POSIX ownership checks; use T3CODE_HOME on this platform.",
      );
    }
    validateDirectoryPath(homeDirectory, uid);
    validateSelector(selectorStat, uid);
    const fd = NodeFS.openSync(
      selectorPath,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
    let contents: string;
    try {
      const openedStat = NodeFS.fstatSync(fd);
      validateSelector(openedStat, uid);
      if (openedStat.dev !== selectorStat.dev || openedStat.ino !== selectorStat.ino) {
        throw new Error("The home selector changed while being opened. Retry after saving it.");
      }
      const buffer = Buffer.alloc(MAX_SELECTOR_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = NodeFS.readSync(fd, buffer, length, buffer.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > MAX_SELECTOR_BYTES) throw new Error("The home selector exceeds 4096 bytes.");
      contents = buffer.toString("utf8", 0, length);
    } finally {
      NodeFS.closeSync(fd);
    }

    const selector: unknown = JSON.parse(contents);
    if (
      typeof selector !== "object" ||
      selector === null ||
      Object.keys(selector).length !== 1 ||
      !("t3Home" in selector) ||
      typeof selector.t3Home !== "string" ||
      selector.t3Home.trim() !== selector.t3Home ||
      !NodePath.isAbsolute(selector.t3Home) ||
      selector.t3Home.includes("\0") ||
      selector.t3Home
        .split(NodePath.sep)
        .some((part) => part === "~" || part === "." || part === "..")
    ) {
      throw new Error(
        'Expected exactly { "t3Home": "/absolute/existing/home" }, without tilde or dot segments.',
      );
    }
    // Strip trailing separators before lstat: lstat("link/") follows the link.
    const t3Home = NodePath.resolve(selector.t3Home);
    validateDirectoryPath(t3Home, uid);
    process.env.T3CODE_HOME = t3Home;
  } catch (cause) {
    // Never fall back to a fresh identity when a selector exists but is invalid.
    throw new Error(
      `Cannot use desktop home selector ${selectorPath}. No desktop settings or database were opened. Fix the selector or explicitly set T3CODE_HOME. ${cause instanceof Error ? cause.message : "Cannot read selector."}`,
    );
  }
}

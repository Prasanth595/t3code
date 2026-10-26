// @effect-diagnostics nodeBuiltinImport:off - the pause file is read and written the way softfac does it.
/**
 * Claims paused by hand: the file `claims-paused` in the data directory. While it is there a pass
 * claims no ready issue of any repo, and everything else in the pass goes on. `pauseClaims`
 * writes it and `resumeClaims` removes it.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { errnoCode } from "./ledger/errors.ts";
import { formatTs, parseTs } from "./ledger/time.ts";

/** The file in the data dir that holds claims back by hand. */
export const PAUSE_FILE = "claims-paused";

/** The file in the data dir that autodeploy.sh writes while a build waits to be installed. */
export const DEPLOY_PENDING_FILE = "deploy-pending";

/** Claims held back by a person, as the data dir has it. */
export interface HandPause {
  /**
   * When the pause was made, in Unix epoch milliseconds: the time in the file, or the file's
   * modification time when a person wrote it by hand and the text is not a time.
   */
  readonly sinceMs: number;
}

/**
 * The pause on disk: any regular file is a pause, whatever it holds; a missing file, symlink or
 * FIFO is none. Unparseable text falls back to the mtime, then to 0. A file that exists but cannot
 * be opened is still a pause: a person made it to stop claims.
 */
export const loadHandPause = (dataDir: string): HandPause | null => {
  const path = NodePath.join(dataDir, PAUSE_FILE);
  let fd: number;
  try {
    // Without following a symlink and without blocking, so a FIFO put there cannot hang the pass.
    fd = NodeFS.openSync(
      path,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
  } catch (error) {
    // ELOOP is a symlink refused by O_NOFOLLOW.
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ELOOP") return null;
    return unopenedPause(path);
  }
  try {
    const stat = NodeFS.fstatSync(fd);
    if (!stat.isFile()) return null;
    let parsed: number | null = null;
    try {
      parsed = parseTs(NodeFS.readFileSync(fd, "utf8").trim());
    } catch {
      parsed = null;
    }
    return { sinceMs: parsed ?? Math.floor(stat.mtimeMs) };
  } finally {
    NodeFS.closeSync(fd);
  }
};

/** A pause file that is there but could not be opened, by what `lstat` says of it. */
const unopenedPause = (path: string): HandPause | null => {
  let stat: NodeFS.Stats;
  try {
    stat = NodeFS.lstatSync(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    return { sinceMs: 0 };
  }
  return stat.isFile() ? { sinceMs: Math.floor(stat.mtimeMs) } : null;
};

/** A build autodeploy has waiting, as the data dir has it. */
export interface PendingDeploy {
  /** When the first build left waiting was found, in Unix epoch milliseconds. */
  readonly sinceMs: number;
  /** The newest build waiting, as a hex sha; null when the file does not name one. */
  readonly commit: string | null;
}

/**
 * The build autodeploy.sh has waiting: `deploy-pending` in the data dir holds `<epoch seconds>
 * <sha>` while origin/main has a commit that is not installed, and the script removes it when
 * nothing is pending. The pass claims nothing while it is there, so the runs in progress can end
 * and the build can be installed. A missing file, symlink or FIFO is nothing pending. A first
 * word that is not whole seconds falls back to the file's mtime; a file that exists but cannot be
 * opened is still pending since its mtime.
 */
export const loadPendingDeploy = (dataDir: string): PendingDeploy | null => {
  const path = NodePath.join(dataDir, DEPLOY_PENDING_FILE);
  let fd: number;
  try {
    fd = NodeFS.openSync(
      path,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ELOOP") return null;
    const unopened = unopenedPause(path);
    return unopened === null ? null : { sinceMs: unopened.sinceMs, commit: null };
  }
  try {
    const stat = NodeFS.fstatSync(fd);
    if (!stat.isFile()) return null;
    let words: Array<string> = [];
    try {
      words = NodeFS.readFileSync(fd, "utf8").trim().split(/\s+/);
    } catch {
      words = [];
    }
    const since = words[0] ?? "";
    const sha = words[1] ?? "";
    return {
      sinceMs: /^[0-9]+$/.test(since) ? Number(since) * 1000 : Math.floor(stat.mtimeMs),
      commit: /^[0-9a-f]{7,40}$/.test(sha) ? sha : null,
    };
  } finally {
    NodeFS.closeSync(fd);
  }
};

/** What {@link pauseClaims} found. */
export type Paused =
  /** Claims were not paused, and now are. */
  | { readonly kind: "now" }
  /** Claims were already paused since `sinceMs`, and the file is as it was. */
  | { readonly kind: "already"; readonly sinceMs: number };

/**
 * Pauses claims at `nowMs` by writing `<data dir>/claims-paused`, whole or not at all and
 * private to the owner. A pause that is already there keeps its time and nothing is written.
 * The data directory is not made: one that is not there is an error.
 */
export const pauseClaims = (dataDir: string, nowMs: number): Paused => {
  const pause = loadHandPause(dataDir);
  if (pause !== null) return { kind: "already", sinceMs: pause.sinceMs };
  const path = NodePath.join(dataDir, PAUSE_FILE);
  const temp = `${path}.${process.pid}.tmp`;
  const fd = NodeFS.openSync(
    temp,
    NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL,
    0o600,
  );
  try {
    NodeFS.writeFileSync(fd, `${formatTs(nowMs)}\n`);
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
  try {
    NodeFS.renameSync(temp, path);
  } catch (error) {
    NodeFS.rmSync(temp, { force: true });
    throw error;
  }
  return { kind: "now" };
};

/**
 * Lets the passes claim again by removing the file: `true` when it was there, `false` when claims
 * were not paused.
 */
export const resumeClaims = (dataDir: string): boolean => {
  try {
    NodeFS.unlinkSync(NodePath.join(dataDir, PAUSE_FILE));
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
};

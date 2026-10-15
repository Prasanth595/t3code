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

/** Claims held back by a person, as the data dir has it. */
export interface HandPause {
  /**
   * When the pause was made, in Unix epoch milliseconds: the time in the file, or the file's
   * modification time when a person wrote it by hand and the text is not a time.
   */
  readonly sinceMs: number;
}

/**
 * The pause on disk. The file is a pause whenever it is a regular file, whatever it holds: a
 * file that is missing, a symlink or a FIFO is no pause. A text that is not a time falls back to
 * the modification time, and to 0 when that cannot be read either.
 */
export const loadHandPause = (dataDir: string): HandPause | null => {
  const path = NodePath.join(dataDir, PAUSE_FILE);
  let fd: number;
  try {
    fd = NodeFS.openSync(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  } catch {
    return null;
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

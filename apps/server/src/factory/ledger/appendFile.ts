// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { LedgerError, errnoCode, ioError } from "./errors.ts";

/**
 * The two file operations an append performs. A seam so a test can make them fail the way a full
 * or failing disk does; the real implementation is `node:fs`. `writeSync` may write less than the
 * whole buffer and returns how many bytes it wrote.
 */
export type AppendIo = {
  writeSync(fd: number, buffer: Uint8Array): number;
  fsyncSync(fd: number): void;
};

export const nodeIo: AppendIo = {
  writeSync: (fd, buffer) => NodeFS.writeSync(fd, buffer),
  fsyncSync: (fd) => NodeFS.fsyncSync(fd),
};

/** Flush a directory's entries to disk, so a file created in it survives a crash. */
export type SyncDir = (dir: string) => void;

export const syncDir: SyncDir = (dir) => {
  const fd = NodeFS.openSync(dir, "r");
  try {
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
};

/**
 * Create `path` if it is missing, owner-only (`0o700`); true if it did not exist before. Missing
 * parents are made the ordinary way, and a directory that already exists is left as it is,
 * whatever its mode. Throws what `node:fs` throws.
 */
export const ensureDir = (path: string): boolean => {
  try {
    NodeFS.statSync(path);
    return false;
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  try {
    NodeFS.mkdirSync(path, { mode: 0o700 });
    return true;
  } catch (error) {
    // Someone else made it between the check and here.
    if (errnoCode(error) === "EEXIST") return false;
    throw error;
  }
};

/** `sync` of `dir` with its failure reported as an `Io` error for `dir`. */
export const syncAt = (sync: SyncDir, dir: string): void => {
  try {
    sync(dir);
  } catch (error) {
    throw ioError(dir, error);
  }
};

const NEWLINE = 0x0a;

/**
 * Open an existing regular file for append, never creating it and never following a symlink
 * (`O_WRONLY | O_APPEND | O_NOFOLLOW`, plus read access to look at the last byte). A last line with
 * no newline is a write that was cut off: it is ended with one `\n` write and an fsync, so the
 * next event starts on its own line, and `repaired` is true. The fragment stays in the file.
 * A missing file is `NotFound`; anything else that goes wrong is `Io`.
 */
export const openForAppend = (
  path: string,
  io: AppendIo = nodeIo,
): { readonly file: AppendFile; readonly repaired: boolean } => {
  let fd: number;
  try {
    fd = NodeFS.openSync(
      path,
      NodeFS.constants.O_RDWR | NodeFS.constants.O_APPEND | NodeFS.constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (errnoCode(error) === "ENOENT") throw new LedgerError({ kind: "NotFound", path });
    throw ioError(path, error);
  }
  let repaired = false;
  try {
    const size = NodeFS.fstatSync(fd).size;
    if (size > 0) {
      const last = Buffer.alloc(1);
      NodeFS.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== NEWLINE) {
        NodeFS.writeSync(fd, "\n");
        NodeFS.fsyncSync(fd);
        repaired = true;
      }
    }
  } catch (error) {
    NodeFS.closeSync(fd);
    throw ioError(path, error);
  }
  return { file: new AppendFile(path, fd, io), repaired };
};

/** The directory that holds `dir`, which the sync after making `dir` has to reach. */
export const parentOf = (dir: string): string => NodePath.dirname(dir);

/**
 * An open file that lines are appended to, one write each: the part a run file and the machine
 * log have in common.
 */
export class AppendFile {
  readonly path: string;
  private fd: number | null;
  private readonly io: AppendIo;
  /**
   * An earlier write or sync failed, so the file may end in a partial line with no newline. The
   * next append starts with a `\n` so it cannot be glued onto that fragment.
   */
  private dirty = false;

  constructor(path: string, fd: number, io: AppendIo = nodeIo) {
    this.path = path;
    this.fd = fd;
    this.io = io;
  }

  /**
   * Append `line` (which ends in a newline) as one write of the whole line, then sync, so a
   * crash loses at most the line in flight. `written` runs once the whole line is in the file,
   * before it is known to be durable: the line counts even if making it durable fails.
   */
  writeLine(line: string, written: () => void = () => {}): void {
    const fd = this.fd;
    if (fd === null) throw ioError(this.path, new Error("the file is closed"));
    // After a failed write, end whatever fragment is in the file first, in the same write.
    const bytes = Buffer.from(this.dirty ? `\n${line}` : line, "utf8");
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const count = this.io.writeSync(fd, bytes.subarray(offset));
        if (!(count > 0)) throw new Error("failed to write the whole line");
        offset += count;
      }
    } catch (error) {
      this.dirty = true;
      throw ioError(this.path, error);
    }
    written();
    try {
      this.io.fsyncSync(fd);
    } catch (error) {
      this.dirty = true;
      throw ioError(this.path, error);
    }
    this.dirty = false;
  }

  close(): void {
    if (this.fd === null) return;
    const fd = this.fd;
    this.fd = null;
    NodeFS.closeSync(fd);
  }
}

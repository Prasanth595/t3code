// @effect-diagnostics nodeBuiltinImport:off - softfac's write rules need raw fds: O_NOFOLLOW, O_NONBLOCK and fsync.
// @effect-diagnostics globalDate:off - the default clock is the wall clock softfac stamps lines with.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  AppendFile,
  ensureDir,
  nodeIo,
  openForAppend,
  parentOf,
  syncAt,
  syncDir,
  type AppendIo,
  type SyncDir,
} from "./appendFile.ts";
import { LedgerError, errnoCode, ioError } from "./errors.ts";
import { MACHINE_EVENT_FIELDS, buildData, issueKeyJson, type MachineEvent } from "./events.ts";
import { NEWLINE } from "./limits.ts";
import { decodeLine, isBlankLine, lineHead } from "./read.ts";
import { formatTs } from "./time.ts";

/** The file in the data dir that takes the events that belong to no run. */
export const MACHINE_LOG = "events.jsonl";

const NOT_REGULAR = "not a regular file, so it is not followed";

export type MachineLogOptions = {
  /** Returns the current time as Unix epoch milliseconds. Defaults to the system clock. */
  readonly clock?: () => number;
  /** The write and fsync an append performs. Defaults to `node:fs`; a test injects failures. */
  readonly io?: AppendIo;
  /** Flushes a directory to disk after the log is made. Defaults to an fsync. */
  readonly syncDir?: SyncDir;
};

/**
 * The machine log: `<data dir>/events.jsonl`, one line per event in the ledger's line format
 * without a cause, and with the ledger's write rules: the file and a data dir made for it are
 * private to the owner, each event is one write of the whole line followed by a sync, a line cut
 * off by a crash or a failed write is ended before the next one, and a symlink or anything else
 * that is not a regular file in its place is refused. It is appended to and never rewritten.
 */
export class MachineLog {
  private readonly out: AppendFile;
  private readonly clock: () => number;

  private constructor(out: AppendFile, clock: () => number) {
    this.out = out;
    this.clock = clock;
  }

  /**
   * Open the log for append, making it (and the data dir) if they are missing. The data dir and
   * its parent are synced on every open, not only when this call made them, so an open that
   * made them and then failed to sync leaves them for the retry to sync.
   */
  static open(dataDir: string, options: MachineLogOptions = {}): MachineLog {
    const path = NodePath.join(dataDir, MACHINE_LOG);
    const sync = options.syncDir ?? syncDir;
    try {
      ensureDir(dataDir);
    } catch (error) {
      throw ioError(dataDir, error);
    }
    const io = options.io ?? nodeIo;
    const file = existingRegularFile(path) ? openForAppend(path, io).file : createLog(path, io);
    try {
      syncAt(sync, dataDir);
      syncAt(sync, parentOf(dataDir));
    } catch (error) {
      file.close();
      throw error;
    }
    return new MachineLog(file, options.clock ?? Date.now);
  }

  /**
   * Append one event as one line: a single write of the whole line, then a sync. Throws
   * `UnknownEvent`, writing nothing, for an event name that ledger.md does not list.
   */
  append(event: MachineEvent): void {
    if (!Object.hasOwn(MACHINE_EVENT_FIELDS, event.event)) {
      throw new LedgerError({ kind: "UnknownEvent", event: String(event.event) });
    }
    const ms = this.clock();
    let line: string;
    try {
      // An issue key is written the way softfac's `IssueKey` serialises: a number or a string.
      const issue = "issue" in event.data ? { issue: issueKeyJson(event.data.issue) } : {};
      const data = buildData(MACHINE_EVENT_FIELDS[event.event], event.data, issue);
      line = `${JSON.stringify({ ts: formatTs(ms), ms, event: event.event, data })}\n`;
    } catch (error) {
      throw ioError(this.out.path, error);
    }
    this.out.writeLine(line);
  }

  /** Release the file handle. Appending after this fails with `Io`. */
  close(): void {
    this.out.close();
  }
}

/** Make the log, owner-only. Read access lets an append check how the file ends. */
const createLog = (path: string, io: AppendIo): AppendFile => {
  try {
    // The check before this and the open are two calls, so the open refuses a symlink itself.
    const fd = NodeFS.openSync(
      path,
      NodeFS.constants.O_RDWR |
        NodeFS.constants.O_APPEND |
        NodeFS.constants.O_CREAT |
        NodeFS.constants.O_NOFOLLOW,
      0o600,
    );
    return new AppendFile(path, fd, io);
  } catch (error) {
    throw ioError(path, error);
  }
};

/** True when `path` is a regular file, false when it is missing; anything else is refused. */
const existingRegularFile = (path: string): boolean => {
  let isFile: boolean;
  try {
    isFile = NodeFS.lstatSync(path).isFile();
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw ioError(path, error);
  }
  if (!isFile) throw ioError(path, new Error(NOT_REGULAR));
  return true;
};

/** One line of the machine log as read back. The event and its data are as written. */
export type MachineEntry = {
  /** RFC 3339 UTC, as written in the file. */
  readonly ts: string;
  /** Unix epoch milliseconds. */
  readonly ms: number;
  readonly event: string;
  /** `null` when the line has no `data`. */
  readonly data: unknown;
};

/**
 * Every line of the machine log, oldest first. A line that is not valid (such as the last one,
 * when a crash cut it off) is skipped, and a last line with no newline is still read if it
 * parses. A missing file is an empty log. A symlink or anything else that is not a regular file
 * is refused, as the log refuses to append to one: the file is opened without following a
 * symlink and without blocking, and checked on the open handle, so a swap after the check is
 * not followed.
 */
export const scanMachineLog = (dataDir: string): Array<MachineEntry> => {
  const path = NodePath.join(dataDir, MACHINE_LOG);
  let fd: number;
  try {
    fd = NodeFS.openSync(
      path,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw ioError(path, error);
  }
  let bytes: Buffer;
  try {
    if (!NodeFS.fstatSync(fd).isFile()) throw new Error(NOT_REGULAR);
    bytes = NodeFS.readFileSync(fd);
  } catch (error) {
    throw ioError(path, error);
  } finally {
    NodeFS.closeSync(fd);
  }

  const entries: Array<MachineEntry> = [];
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(NEWLINE, start);
    const end = newline === -1 ? bytes.length : newline;
    const line = bytes.subarray(start, end);
    start = end + 1;
    if (isBlankLine(line)) continue;
    const object = decodeLine(line);
    const head = object === null ? null : lineHead(object);
    if (head !== null) entries.push(head);
  }
  return entries;
};

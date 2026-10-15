// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  AppendFile,
  ensureDir,
  nodeIo,
  parentOf,
  syncDir,
  type AppendIo,
  type SyncDir,
} from "./appendFile.ts";
import { LedgerError, errnoCode, ioError } from "./errors.ts";
import {
  RUN_EVENT_FIELDS,
  causeObject,
  runEventData,
  type Cause,
  type Outcome,
  type PrEnd,
  type RunEvent,
} from "./events.ts";
import { parseLines, readRunBytes } from "./read.ts";
import { RUNS_DIR, runPath, type RunId } from "./runId.ts";
import { formatTs } from "./time.ts";

export { LedgerError } from "./errors.ts";
export type { AppendIo } from "./appendFile.ts";

const U32_MAX = 4294967295;
// The largest u64 as a double; a JSON number past 2^53 is already a double here.
const U64_MAX = 18446744073709551615;
const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

const isIntegerIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/** An open run file that events are appended to. */
export class Ledger {
  private readonly out: AppendFile;
  private readonly clock: () => number;
  /** The `ms` of the first line, which `finished` measures total time from. */
  private firstMs: number | null = null;
  /** The distinct `attempt` values among the `gate_command` lines. */
  private readonly gateAttempts = new Set<number>();
  private finished = false;

  private constructor(out: AppendFile, clock: () => number) {
    this.out = out;
    this.clock = clock;
  }

  /** The run file. */
  get path(): string {
    return this.out.path;
  }

  /**
   * Start a new run file. Throws `AlreadyExists`, leaving the file alone, if there is one.
   * Directories this makes are `0o700` and the file `0o600`; the file's directory entry is
   * synced, and the file removed again if that fails, so a retry does not meet an orphan.
   */
  static create(dataDir: string, id: RunId, options: LedgerOptions = {}): Ledger {
    const path = runPath(dataDir, id);
    const runs = NodePath.join(dataDir, RUNS_DIR);
    const sync = options.syncDir ?? syncDir;
    const dataDirCreated = ensureDirAt(dataDir);
    const runsCreated = ensureDirAt(runs);
    let fd: number;
    try {
      // The ledger holds issue and PR details, so keep it to the owner.
      fd = NodeFS.openSync(path, "ax", 0o600);
    } catch (error) {
      if (errnoCode(error) === "EEXIST") throw new LedgerError({ kind: "AlreadyExists", path });
      throw ioError(path, error);
    }
    // The new file's directory entry must be durable too, or a crash could lose the whole file
    // and the events synced into it.
    try {
      syncAt(sync, runs);
      if (runsCreated) syncAt(sync, dataDir);
      if (dataDirCreated) syncAt(sync, parentOf(dataDir));
    } catch (error) {
      NodeFS.closeSync(fd);
      try {
        NodeFS.unlinkSync(path);
      } catch {
        // The sync error is the one to report.
      }
      throw error;
    }
    return new Ledger(new AppendFile(path, fd, options.io ?? nodeIo), options.clock ?? Date.now);
  }

  /**
   * Reopen an existing run for append after a restart. If the last line is incomplete (a crash
   * mid-write), it is terminated with a newline first, so the next event starts on its own
   * line. The fragment stays in the file and readers skip it.
   */
  static open(dataDir: string, id: RunId, options: LedgerOptions = {}): Ledger {
    const path = runPath(dataDir, id);
    let content: Uint8Array = readRunBytes(path);
    let fd: number;
    try {
      fd = NodeFS.openSync(path, "a");
    } catch (error) {
      throw ioError(path, error);
    }
    if (content.length > 0 && content[content.length - 1] !== 0x0a) {
      try {
        NodeFS.writeSync(fd, "\n");
        NodeFS.fsyncSync(fd);
      } catch (error) {
        NodeFS.closeSync(fd);
        throw ioError(path, error);
      }
      content = Buffer.concat([content, Buffer.from("\n")]);
    }
    const ledger = new Ledger(
      new AppendFile(path, fd, options.io ?? nodeIo),
      options.clock ?? Date.now,
    );
    for (const entry of parseLines(content).entries) {
      ledger.observe(entry.ms, entry.event, entry.data);
    }
    return ledger;
  }

  /** Fold a line that is now in the file into what the summary needs. */
  private observe(ms: number, event: string, data: unknown): void {
    this.firstMs ??= ms;
    // Only a `gate_command` that softfac would read as a whole counts: it falls back to an
    // unknown event, which is not counted, when any field is missing or the wrong type.
    if (event === "gate_command" && typeof data === "object" && data !== null) {
      const { attempt, command, exit_code, duration_ms } = data as Record<string, unknown>;
      if (
        isIntegerIn(attempt, 0, U32_MAX) &&
        typeof command === "string" &&
        isIntegerIn(exit_code, I32_MIN, I32_MAX) &&
        isIntegerIn(duration_ms, 0, U64_MAX)
      ) {
        this.gateAttempts.add(attempt);
      }
    }
    // A `finished` line ends the run even if its data cannot be read.
    if (event === "finished") this.finished = true;
  }

  /**
   * Append one event as one line, with why it was written: a single write of the whole line,
   * then a sync, so a crash loses at most the event in flight. A `finished` event has its
   * `total_ms` and `gate_attempts` replaced with the ledger's own count; use `finish`. Throws
   * `AlreadyFinished` after a `finished` line, and `UnknownEvent` for an event name that
   * ledger.md does not list; neither writes anything.
   */
  append(event: RunEvent, cause: Cause): void {
    if (this.finished) throw new LedgerError({ kind: "AlreadyFinished", path: this.out.path });
    if (!Object.hasOwn(RUN_EVENT_FIELDS, event.event)) {
      throw new LedgerError({ kind: "UnknownEvent", event: String(event.event) });
    }
    const ms = this.clock();
    const data = runEventData(
      event,
      event.event === "finished"
        ? {
            total_ms: Math.max(0, ms - (this.firstMs ?? ms)),
            gate_attempts: this.gateAttempts.size,
          }
        : {},
    );
    let line: string;
    try {
      line = `${JSON.stringify({ ts: formatTs(ms), ms, event: event.event, data, cause: causeObject(cause) })}\n`;
    } catch (error) {
      throw ioError(this.out.path, error);
    }
    // The line is in the file once `written` runs, so it counts even if making it durable
    // fails: a failed sync on `finished` must not allow a second `finished` line.
    this.out.writeLine(line, () => this.observe(ms, event.event, data));
  }

  /**
   * Write the summary line that ends the run. The ledger fills in the total time since the
   * first line and the number of distinct gate attempts; later appends fail. `prEnd` is how the
   * pull request ended, for a run that ended because it did.
   */
  finish(
    outcome: Outcome,
    reviewCycles: number | null,
    prUrl: string | null,
    cause: Cause,
    prEnd: PrEnd | null = null,
  ): void {
    this.append(
      {
        event: "finished",
        data: {
          outcome,
          total_ms: 0,
          gate_attempts: 0,
          review_cycles: reviewCycles,
          pr_url: prUrl,
          pr_end: prEnd,
        },
      },
      cause,
    );
  }

  /** Release the file handle. Appending after this fails with `Io`. */
  close(): void {
    this.out.close();
  }
}

/** `ensureDir` with its failure reported as an `Io` error for `dir`. */
const ensureDirAt = (dir: string): boolean => {
  try {
    return ensureDir(dir);
  } catch (error) {
    throw ioError(dir, error);
  }
};

const syncAt = (sync: SyncDir, dir: string): void => {
  try {
    sync(dir);
  } catch (error) {
    throw ioError(dir, error);
  }
};

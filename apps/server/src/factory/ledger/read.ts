// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { LedgerError, errnoCode, ioError } from "./errors.ts";
import { runPath, type RunId } from "./runId.ts";

/**
 * A cause as read back. Its step and reason are the words in the file, not the ones this build
 * knows, so a cause from a newer build is read as it was written, extra keys included.
 */
export type ReadCause = { step: string; reason: string; [key: string]: unknown };

/** One line of a run, as read back: the event and its data are as written. */
export type Entry = {
  /** RFC 3339 UTC, as written in the file. */
  readonly ts: string;
  /** Unix epoch milliseconds. */
  readonly ms: number;
  readonly event: string;
  /** `null` when the line has no `data`. */
  readonly data: unknown;
  /** `null` for a line from before causes existed, and for a cause that is not an object with a step and a reason. */
  readonly cause: ReadCause | null;
};

/** A run read back from its file. */
export type RunRecord = {
  readonly id: RunId;
  readonly entries: ReadonlyArray<Entry>;
  /** The last line was incomplete or not valid JSON, and was dropped. */
  readonly truncated: boolean;
  /** Invalid lines that were not the last, and so were skipped. */
  readonly skipped: number;
};

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const U32_MAX = 4294967295;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * An empty line: nothing, or just the `\r` of a CRLF ending. The repair after a failed write
 * leaves one, and nothing was lost, so it is neither an entry nor damage.
 */
export const isBlankLine = (line: Uint8Array): boolean =>
  line.length === 0 || (line.length === 1 && line[0] === CARRIAGE_RETURN);

// Strict UTF-8, and a byte order mark is a syntax error as it is for any JSON reader.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** One line as a JSON object, or `null` when it is not UTF-8, not JSON or not an object. */
export const decodeLine = (line: Uint8Array): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(decoder.decode(line));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

/**
 * The keys every line has: a string `ts`, a whole non-negative number `ms` and a string `event`.
 * A missing `data` reads as `null`.
 */
export const lineHead = (
  object: Record<string, unknown>,
): { ts: string; ms: number; event: string; data: unknown } | null => {
  const { ts, ms, event, data } = object;
  if (typeof ts !== "string" || typeof event !== "string") return null;
  if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms < 0) return null;
  return { ts, ms, event, data: data === undefined ? null : data };
};

const readCause = (value: unknown): ReadCause | null => {
  if (!isRecord(value)) return null;
  const { step, reason, actor, command, attempt, label } = value;
  if (typeof step !== "string" || typeof reason !== "string") return null;
  for (const text of [actor, command, label]) {
    if (text !== undefined && text !== null && typeof text !== "string") return null;
  }
  if (
    attempt !== undefined &&
    attempt !== null &&
    !(
      typeof attempt === "number" &&
      Number.isInteger(attempt) &&
      attempt >= 0 &&
      attempt <= U32_MAX
    )
  ) {
    return null;
  }
  return value as ReadCause;
};

const parseLine = (line: Uint8Array): Entry | null => {
  const object = decodeLine(line);
  const head = object === null ? null : lineHead(object);
  if (object === null || head === null) return null;
  return { ...head, cause: readCause(object.cause) };
};

/**
 * Read a run file's bytes into entries. Never fails on a bad line: an incomplete or invalid last
 * line is dropped and flagged, and any other invalid line is skipped and counted. Empty lines
 * are ignored.
 */
export const parseLines = (
  bytes: Uint8Array,
): { entries: Array<Entry>; truncated: boolean; skipped: number } => {
  const completeLength = bytes.lastIndexOf(NEWLINE) + 1;
  const lines: Array<Entry | null> = [];
  let start = 0;
  while (start < completeLength) {
    const end = bytes.indexOf(NEWLINE, start);
    const line = bytes.subarray(start, end);
    if (!isBlankLine(line)) lines.push(parseLine(line));
    start = end + 1;
  }

  let truncated = false;
  if (!isBlankLine(bytes.subarray(completeLength))) {
    truncated = true;
  } else if (lines.length > 0 && lines[lines.length - 1] === null) {
    truncated = true;
    lines.pop();
  }
  const skipped = lines.filter((line) => line === null).length;
  return { entries: lines.filter((line) => line !== null), truncated, skipped };
};

/**
 * Read a run file, refusing anything that is not a regular file: a symlink or directory named
 * like a run is reported as not found, so nothing ever reads (or appends to) some other file.
 * The check and the read are separate calls, so a swap in between is not caught; the data
 * directory is private to its owner, which is who could make that swap.
 */
export const readRunBytes = (path: string): Buffer => {
  const notFound = () => new LedgerError({ kind: "NotFound", path });
  try {
    if (!NodeFS.lstatSync(path).isFile()) throw notFound();
  } catch (error) {
    if (error instanceof LedgerError) throw error;
    if (errnoCode(error) === "ENOENT") throw notFound();
    throw ioError(path, error);
  }
  try {
    return NodeFS.readFileSync(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") throw notFound();
    throw ioError(path, error);
  }
};

/** Read a run back. A damaged line never fails the read; see `RunRecord`. */
export const readRun = (dataDir: string, id: RunId): RunRecord => {
  const bytes = readRunBytes(runPath(dataDir, id));
  return { id, ...parseLines(bytes) };
};

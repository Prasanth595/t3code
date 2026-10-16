// @effect-diagnostics nodeBuiltinImport:off - the open items are one file, written whole as the pause file is.
// @effect-diagnostics globalDate:off - an item is stamped with the wall clock, as the ledger is.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ensureDir } from "./ledger/appendFile.ts";
import { formatTs, parseTs } from "./ledger/time.ts";
import { FactoryProcess } from "./process.ts";
import * as Paths from "./t3/paths.ts";

/**
 * What a person has to look at. `attention` is an `attention` event of the pass; `stuck` and
 * `needs-info` are runs that ended there; `config` is a machine config that did not load;
 * `pass-errors` is a pass that errored several times in a row.
 */
export type AttentionKind = "attention" | "stuck" | "needs-info" | "config" | "pass-errors";

const KINDS: ReadonlyArray<string> = ["attention", "stuck", "needs-info", "config", "pass-errors"];

export interface AttentionItem {
  /** What the item is about, so raising it twice is one item. */
  readonly id: string;
  readonly kind: AttentionKind;
  /** The watched repo, or none for an item about the machine. */
  readonly repo: string | null;
  readonly issue: number | null;
  /** The run id, when the item is about one run. */
  readonly run: string | null;
  readonly message: string;
  /** When the item was first raised, in Unix epoch milliseconds. */
  readonly firstSeenMs: number;
}

export type NewItem = Omit<AttentionItem, "firstSeenMs">;

/** How a pass ended, for the count of passes that error in a row. */
export type PassOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * The open attention items: what the factory needs a person for. An item is raised when its
 * condition starts and cleared when the condition ends; a new item posts one macOS notification,
 * and one that stays open is never notified again, because the open items are kept in
 * `<factory dir>/attention.json` and read back at start.
 */
export class Attention extends Context.Service<
  Attention,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<AttentionItem>>;
    /** Opens the item unless one with its id is open; a new item is persisted, then notified once. Never fails: a file or notifier problem is logged. */
    readonly raise: (item: NewItem) => Effect.Effect<void>;
    /** Removes every open item `matches` is true for, and persists. */
    readonly clear: (matches: (item: AttentionItem) => boolean) => Effect.Effect<void>;
    /** Counts erroring passes in a row; the third raises `pass-errors`; a success clears it and resets the count. */
    readonly passEnded: (outcome: PassOutcome) => Effect.Effect<void>;
    /** Whether new items post a notification. Starts true (the machine config may not have loaded). */
    readonly setNotify: (on: boolean) => Effect.Effect<void>;
  }
>()("t3/factory/attention") {}

export const ATTENTION_FILE = "attention.json";
export const PASS_ERRORS_IN_A_ROW = 3;
export const CONFIG_ITEM_ID = "config";
export const PASS_ERRORS_ITEM_ID = "pass-errors";

/** The exit code of the `sh` wrapper that found no such command. */
const COMMAND_NOT_FOUND = 127;
const NOTIFY_TIMEOUT_MS = 15_000;

/**
 * The text arrives as argv, so nothing a repo, an issue title or a session wrote can become
 * AppleScript source.
 */
const SCRIPT = `on run argv
  display notification (item 2 of argv) with title (item 1 of argv)
end run`;

const titleOf = (item: NewItem): string => {
  if (item.repo === null) return "factory";
  return item.issue === null ? item.repo : `${item.repo}#${item.issue}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOrNull = (value: unknown): string | null | undefined =>
  value === null || typeof value === "string" ? value : undefined;

/** One entry of the file, or `null` when it is malformed. */
const itemFromFile = (entry: unknown): AttentionItem | null => {
  if (!isRecord(entry)) return null;
  const { id, kind, repo, issue, run, message } = entry;
  const firstSeenMs = typeof entry["first_seen"] === "string" ? parseTs(entry["first_seen"]) : null;
  if (typeof id !== "string" || typeof kind !== "string" || !KINDS.includes(kind)) return null;
  if (typeof message !== "string" || firstSeenMs === null) return null;
  const repoOrNull = stringOrNull(repo);
  const runOrNull = stringOrNull(run);
  if (repoOrNull === undefined || runOrNull === undefined) return null;
  if (issue !== null && typeof issue !== "number") return null;
  return {
    id,
    kind: kind as AttentionKind,
    repo: repoOrNull,
    issue,
    run: runOrNull,
    message,
    firstSeenMs,
  };
};

type Loaded =
  | { readonly items: ReadonlyArray<AttentionItem> }
  | { readonly items: ReadonlyArray<AttentionItem>; readonly warning: string };

/** The open items on disk. A missing file is none; a file that is not the expected shape is none, with a warning. */
const readFile = (path: string): Loaded => {
  let text: string;
  try {
    text = NodeFS.readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [] };
    return { items: [], warning: `cannot read ${path}: ${String(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { items: [], warning: `${path} is not valid JSON, so no attention item is kept` };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["items"])) {
    return { items: [], warning: `${path} has no items list, so no attention item is kept` };
  }
  return {
    items: parsed["items"].flatMap((entry) => {
      const found = itemFromFile(entry);
      return found === null ? [] : [found];
    }),
  };
};

/** Writes the items whole or not at all, private to the owner, as the pause file is. */
const writeFile = (dir: string, items: ReadonlyArray<AttentionItem>): void => {
  ensureDir(dir);
  const path = NodePath.join(dir, ATTENTION_FILE);
  const temp = `${path}.${process.pid}.tmp`;
  const body = JSON.stringify({
    items: items.map((item) => ({
      id: item.id,
      kind: item.kind,
      repo: item.repo,
      issue: item.issue,
      run: item.run,
      message: item.message,
      first_seen: formatTs(item.firstSeenMs),
    })),
  });
  const fd = NodeFS.openSync(
    temp,
    NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_TRUNC,
    0o600,
  );
  try {
    NodeFS.writeFileSync(fd, `${body}\n`);
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
};

const make = (options: { readonly clock?: () => number }) =>
  Effect.gen(function* () {
    const { factoryDir } = yield* Paths.FactoryPaths;
    const runner = yield* FactoryProcess;
    const clock = options.clock ?? Date.now;
    const path = NodePath.join(factoryDir, ATTENTION_FILE);

    const loaded = readFile(path);
    if ("warning" in loaded) yield* Effect.logWarning(loaded.warning);
    const items = new Map<string, AttentionItem>(loaded.items.map((item) => [item.id, item]));
    let notifying = true;
    let osascriptMissing = false;
    let failedPasses = 0;

    const persist = Effect.suspend(() => {
      try {
        writeFile(factoryDir, [...items.values()]);
        return Effect.void;
      } catch (error) {
        return Effect.logWarning(
          `cannot write ${path}, so open attention items may be notified again: ${String(error)}`,
        );
      }
    });

    const post = (item: NewItem) =>
      Effect.gen(function* () {
        if (!notifying || osascriptMissing) return;
        const result = yield* Effect.result(
          runner.run({
            command: "osascript",
            args: ["-e", SCRIPT, titleOf(item), item.message],
            timeoutMs: NOTIFY_TIMEOUT_MS,
          }),
        );
        if (result._tag === "Failure") {
          return yield* Effect.logWarning(
            `cannot notify attention item ${item.id}: ${String(result.failure.cause)}`,
          );
        }
        const ran = result.success;
        if (ran.exitCode === COMMAND_NOT_FOUND) {
          osascriptMissing = true;
          return yield* Effect.logWarning(
            "osascript not found, so attention items are not notified on this machine",
          );
        }
        if (ran.exitCode !== 0 || ran.timedOut) {
          return yield* Effect.logWarning(
            `cannot notify attention item ${item.id}: ${ran.timedOut ? "timed out" : `exit ${ran.exitCode}`}: ${ran.tail.trim()}`,
          );
        }
      });

    const raise = (item: NewItem): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (items.has(item.id)) return;
        items.set(item.id, { ...item, firstSeenMs: clock() });
        // Saved before it is posted, so a crash between the two cannot notify the item twice.
        yield* persist;
        yield* post(item);
      });

    const clear = (matches: (item: AttentionItem) => boolean): Effect.Effect<void> =>
      Effect.gen(function* () {
        const gone = [...items.values()].filter(matches);
        if (gone.length === 0) return;
        for (const item of gone) items.delete(item.id);
        yield* persist;
      });

    const passEnded = (outcome: PassOutcome): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (outcome.ok) {
          failedPasses = 0;
          return yield* clear((item) => item.id === PASS_ERRORS_ITEM_ID);
        }
        failedPasses += 1;
        if (failedPasses < PASS_ERRORS_IN_A_ROW) return;
        yield* raise({
          id: PASS_ERRORS_ITEM_ID,
          kind: "pass-errors",
          repo: null,
          issue: null,
          run: null,
          message: `the pass has failed ${PASS_ERRORS_IN_A_ROW} times in a row, last: ${outcome.message}`,
        });
      });

    return Attention.of({
      list: () => Effect.sync(() => [...items.values()]),
      raise,
      clear,
      passEnded,
      setNotify: (on) =>
        Effect.sync(() => {
          notifying = on;
        }),
    });
  });

/** Needs FactoryPaths and FactoryProcess. `clock` is for a test; it reads the wall clock by default. */
export const layer = (options: { readonly clock?: () => number } = {}) =>
  Layer.effect(Attention, make(options));

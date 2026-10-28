import { UsageProviderKind, UsageTokenTotals } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  totalTokens,
  type ProviderUsageReader,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { OpenCodeSettings } from "../settings.ts";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseOpenCodeMessage(
  source: string,
  fallback: {
    readonly id?: string;
    readonly sessionId?: string;
    readonly timestampMs?: number;
  } = {},
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  const message = object(parsed);
  if (message.role !== undefined && message.role !== "assistant") return null;
  const usage = object(message.tokens);
  const cache = object(usage.cache);
  const modelReference = object(message.model);
  const model = text(modelReference.id) || text(modelReference.modelID) || text(message.modelID);
  const timestampMs = object(message.time).created ?? fallback.timestampMs;
  if (!model || typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) return null;
  const reasoningTokens = tokens(usage.reasoning);
  const totals = {
    uncachedInputTokens: tokens(usage.input),
    cachedInputTokens: tokens(cache.read),
    cacheCreationTokens: tokens(cache.write),
    outputTokens: tokens(usage.output) + reasoningTokens,
    reasoningTokens,
  };
  if (totalTokens(totals) === 0) return null;
  const id = fallback.id || text(message.id);
  const cost = message.cost;
  return {
    provider: "opencode",
    timestampMs,
    model,
    sessionId: fallback.sessionId || text(message.sessionID),
    totals,
    // OpenCode uses zero for unknown rates, including paid subscriptions; let shared pricing estimate.
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null,
    speed: "standard",
    dedupeKey: id ? `opencode:${id}` : null,
  };
}

export interface CachedOpenCodeRow {
  readonly fingerprint: string | null;
  readonly created: number | null;
  readonly record: UsageRecord | null;
}

/** Parsed rows by `${databasePath}\0${table}`, then rowid; changed tables get new maps. */
export type OpenCodeUsageCache = Map<string, ReadonlyMap<number, CachedOpenCodeRow>>;

interface ListedRow {
  readonly row_id: number;
  readonly fingerprint: string | null;
}

export interface OpenCodeUsageReadResult {
  readonly files: readonly { readonly path: string; readonly records: readonly UsageRecord[] }[];
  readonly missing: boolean;
  readonly error: boolean;
}

const isNotFound = (cause: PlatformError.PlatformError) => cause.reason._tag === "NotFound";
const MESSAGE_PAGE_SIZE = 64;

const isSymbolicLink = Effect.fnUntraced(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Effect.isSuccess(fileSystem.readLink(path));
});

const entryInfo = Effect.fn("entryInfo")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  if (yield* isSymbolicLink(path))
    return { type: "SymbolicLink" as const, mtime: Option.none<Date>() };
  return yield* fileSystem.stat(path);
});

const LEGACY_STAT_CONCURRENCY = 4;

// Batch stats so huge directories do not stay in memory.
const LEGACY_STAT_BATCH = 256;

export const readOpenCodeUsage = Effect.fn("readOpenCodeUsage")(function* (
  root: string,
  sinceMs: number,
  cache?: { readonly rows: OpenCodeUsageCache; readonly retentionCutoffMs: number },
): Effect.fn.Return<OpenCodeUsageReadResult, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: { path: string; records: UsageRecord[] }[] = [];
  const seen = new Set<string>();
  let found = false;
  let error = false;
  const append = (records: UsageRecord[], record: UsageRecord | null) => {
    if (record === null || record.timestampMs < sinceMs) return;
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) return;
      seen.add(record.dedupeKey);
    }
    records.push(record);
  };

  const databases = yield* fileSystem.readDirectory(root).pipe(
    Effect.flatMap((names) =>
      Effect.filter(
        names.filter((name) => /^opencode(?:-[a-zA-Z0-9_-]+)?\.db$/.test(name)),
        (name) =>
          entryInfo(path.join(root, name)).pipe(
            Effect.map((info) => info.type === "File"),
            Effect.catchTags({
              PlatformError: (cause) =>
                isNotFound(cause) ? Effect.succeed(false) : Effect.fail(cause),
            }),
          ),
      ),
    ),
    Effect.map((names) =>
      names.sort((a, b) =>
        a === "opencode.db" ? -1 : b === "opencode.db" ? 1 : a.localeCompare(b),
      ),
    ),
    Effect.catchTags({
      PlatformError: (cause) => {
        if (!isNotFound(cause)) error = true;
        return Effect.succeed([]);
      },
    }),
  );
  for (const name of databases) {
    found = true;
    const file = { path: path.join(root, name), records: [] as UsageRecord[] };
    files.push(file);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Fail promptly on live-writer locks instead of stalling the server.
      yield* sql.unsafe("PRAGMA busy_timeout = 100");
      const tables = new Set(
        (yield* sql.unsafe<{ readonly name: unknown }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        )).map((row) => row.name),
      );
      if (!tables.has("message") && !tables.has("session_message")) error = true;
      for (const table of ["message", "session_message"] as const) {
        if (!tables.has(table)) continue;
        const columns = new Set(
          (yield* sql.unsafe<{ readonly name: unknown }>(`PRAGMA table_info(${table})`)).map(
            (row) => row.name,
          ),
        );
        const timestamp = columns.has("time_created") ? "time_created" : "NULL";
        const predicates = table === "session_message" ? ["type = 'assistant'"] : [];
        if (timestamp !== "NULL") predicates.push("time_created >= ?");
        const key = `${file.path}\0${table}`;
        const previous = cache?.rows.get(key);
        const hit = (row: ListedRow) =>
          row.fingerprint !== null && previous?.get(row.row_id)?.fingerprint === row.fingerprint;
        // Select ids through time indexes; a rowid sweep (or ORDER BY rowid) reads every row. One
        // statement also excludes mid-scan appends. octet_length reads the record header only;
        // the length guards writers that keep time_updated.
        const listed = (yield* sql.unsafe<ListedRow>(
          `SELECT rowid AS row_id, ${columns.has("time_updated") ? "time_updated || ':' || octet_length(data)" : "NULL"} AS fingerprint
           FROM ${table} ${predicates.length === 0 ? "" : `WHERE ${predicates.join(" AND ")}`}`,
          timestamp === "NULL" ? [] : [sinceMs],
        )).toSorted((a, b) => a.row_id - b.row_id);
        const misses = listed.filter((row) => !hit(row));
        const fetched = new Map<number, Omit<CachedOpenCodeRow, "fingerprint">>();
        // StatementSync.all materializes results; fetch the large data column in pages.
        // Omit tracing because large histories require thousands of statements.
        for (let start = 0; start < misses.length; start += MESSAGE_PAGE_SIZE) {
          const page = misses.slice(start, start + MESSAGE_PAGE_SIZE);
          const rows = yield* sql
            .unsafe<{
              readonly row_id: number;
              readonly id: unknown;
              readonly session_id: unknown;
              readonly data: unknown;
              readonly created: unknown;
            }>(
              `SELECT rowid AS row_id, id, session_id, data, ${timestamp} AS created
               FROM ${table} WHERE rowid IN (${page.map(() => "?").join(", ")})`,
              page.map((row) => row.row_id),
            )
            .pipe(Effect.withTracerEnabled(false));
          for (const row of rows) {
            fetched.set(row.row_id, {
              created: typeof row.created === "number" ? row.created : null,
              record: parseOpenCodeMessage(text(row.data), {
                id: text(row.id),
                sessionId: text(row.session_id),
                ...(typeof row.created === "number" ? { timestampMs: row.created } : {}),
              }),
            });
          }
          yield* Effect.yieldNow;
        }
        const next = new Map<number, CachedOpenCodeRow>();
        for (const row of listed) {
          // The listed fingerprint is never newer than fetched data, so a race only re-reads.
          const parsed = fetched.get(row.row_id);
          const entry = parsed
            ? { fingerprint: row.fingerprint, ...parsed }
            : hit(row)
              ? previous?.get(row.row_id)
              : undefined;
          if (entry === undefined) continue;
          append(file.records, entry.record);
          if (entry.fingerprint !== null) next.set(row.row_id, entry);
        }
        if (cache === undefined) continue;
        // Rows before this window went unchecked; keep them for wider windows until retention.
        for (const [rowId, entry] of previous ?? []) {
          const created = entry.created ?? -Infinity;
          if (!next.has(rowId) && created < sinceMs && created >= cache.retentionCutoffMs) {
            next.set(rowId, entry);
          }
        }
        // Without new rows, an equally large table only holds unchanged previous entries.
        if (fetched.size > 0 || next.size !== (previous?.size ?? 0)) cache.rows.set(key, next);
      }
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: file.path, readonly: true })),
      Effect.catchTags({
        SqlError: () => {
          error = true;
          return Effect.void;
        },
      }),
    );
  }

  const directories = [path.join(root, "storage", "message")];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    yield* Effect.gen(function* () {
      const names = yield* fileSystem.readDirectory(directory);
      for (let start = 0; start < names.length; start += LEGACY_STAT_BATCH) {
        const batch = names.slice(start, start + LEGACY_STAT_BATCH);
        const entries = batch.map((name) => path.join(directory, name));
        // stat follows symlinks; avoid expensive readLink failures unless link identity matters.
        const infos = yield* Effect.forEach(
          entries,
          (entry) =>
            fileSystem.stat(entry).pipe(
              Effect.catchTags({
                PlatformError: (cause) =>
                  isNotFound(cause)
                    ? Effect.succeed(null)
                    : isSymbolicLink(entry).pipe(
                        Effect.flatMap((link) =>
                          link ? Effect.succeed(null) : Effect.fail(cause),
                        ),
                      ),
              }),
              Effect.exit,
            ),
          { concurrency: LEGACY_STAT_CONCURRENCY },
        );
        for (const [index, name] of batch.entries()) {
          const entry = entries[index]!;
          const info = yield* infos[index]!;
          if (info?.type === "Directory") {
            if (!(yield* isSymbolicLink(entry))) directories.push(entry);
          } else if (info?.type === "File" && name.endsWith(".json")) {
            const id = name.slice(0, -5);
            // Messages cannot postdate file mtime; older files hold no in-window usage.
            const skip =
              seen.has(`opencode:${id}`) ||
              Option.exists(info.mtime, (mtime) => mtime.getTime() < sinceMs);
            if (found && skip) continue;
            if (yield* isSymbolicLink(entry)) continue;
            found = true;
            if (skip) continue;
            const file = { path: entry, records: [] as UsageRecord[] };
            files.push(file);
            yield* fileSystem.readFileString(entry).pipe(
              Effect.map((source) => append(file.records, parseOpenCodeMessage(source, { id }))),
              Effect.catchTags({
                PlatformError: (cause) => {
                  if (!isNotFound(cause)) error = true;
                  return Effect.void;
                },
              }),
            );
          }
        }
      }
    }).pipe(
      Effect.catchTags({
        PlatformError: (cause) => {
          if (!isNotFound(cause)) error = true;
          return Effect.void;
        },
      }),
    );
  }
  return { files, missing: !found && !error, error };
});

const resolveOpenCodeDataDirs = Effect.fn("resolveOpenCodeDataDirs")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const roots = environment["OPENCODE_DATA_DIR"]
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const dataHome = environment["XDG_DATA_HOME"]?.trim();
  const defaults = [
    path.join(
      dataHome && path.isAbsolute(dataHome)
        ? dataHome
        : path.join(homeDirectory, ".local", "share"),
      "opencode",
    ),
  ];
  const canonical = new Set<string>();
  for (const root of roots?.length ? roots : defaults) {
    const resolved = path.resolve(expandHomePath(root, homeDirectory));
    canonical.add(yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved)));
  }
  return [...canonical];
});

export type OpenCodeUsageReaderEnv = FileSystem.FileSystem | Path.Path | ProviderHost.ProviderHost;

// Rename when parseOpenCodeMessage output or the fingerprint changes; a bad file reads as empty.
const CACHE_FILE_NAME = "usage-opencode-cache-v1.json";
// Tuples in plain records; ReadonlyMap codecs made encode and decode several times slower.
const CacheFile = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Tuple([
        Schema.Number,
        Schema.NullOr(Schema.String),
        Schema.NullOr(Schema.Number),
        Schema.NullOr(
          Schema.Struct({
            provider: UsageProviderKind,
            timestampMs: Schema.Number,
            model: Schema.String,
            sessionId: Schema.String,
            totals: UsageTokenTotals,
            reportedCostUsd: Schema.NullOr(Schema.Number),
            speed: Schema.Literals(["standard", "fast", "ultrafast"]),
            dedupeKey: Schema.NullOr(Schema.String),
          }),
        ),
      ]),
    ),
  ),
);
const decodeCacheFile = Schema.decodeUnknownEffect(CacheFile);
const encodeCacheFile = Schema.encodeEffect(CacheFile);
// Parsed rows by cache file, so refreshes and restarts re-read only rows that changed.
const rowCaches = new Map<string, OpenCodeUsageCache>();

export const openCodeUsageReader: ProviderUsageReader<OpenCodeSettings, OpenCodeUsageReaderEnv> = {
  kind: "scan",
  provider: "opencode",
  scan: Effect.fn("openCodeUsageReader.scan")(function* ({
    instances,
    windowStartMs,
    retentionCutoffMs,
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cachePath = path.join((yield* ProviderHost.ProviderHost).paths.stateDir, CACHE_FILE_NAME);
    if (!rowCaches.has(cachePath)) {
      const loaded = yield* fileSystem.readFileString(cachePath).pipe(
        Effect.flatMap(decodeCacheFile),
        Effect.orElseSucceed(() => ({})),
      );
      const tables = Object.entries(loaded).map(([key, rows]) => {
        const entries = rows.map(([id, fingerprint, created, record]) => {
          return [id, { fingerprint, created, record }] as const;
        });
        return [key, new Map(entries)] as const;
      });
      if (!rowCaches.has(cachePath)) rowCaches.set(cachePath, new Map(tables));
    }
    const rowCache = rowCaches.get(cachePath)!;
    const before = new Map(rowCache);
    const roots = new Set<string>();
    for (const instance of instances) {
      for (const root of yield* resolveOpenCodeDataDirs(instance.environment)) roots.add(root);
    }
    const scans = yield* Effect.forEach(
      roots,
      (dir) =>
        readOpenCodeUsage(dir, windowStartMs, { rows: rowCache, retentionCutoffMs }).pipe(
          Effect.map((result) => ({
            dir,
            files: result.missing && !result.error ? null : result.files,
            status: result.error ? ("partial" as const) : ("ok" as const),
            ...(result.error ? { message: "Some OpenCode history could not be read." } : {}),
          })),
        ),
      { concurrency: "unbounded" },
    );
    if (
      rowCache.size !== before.size ||
      rowCache.entries().some(([key, rows]) => before.get(key) !== rows)
    ) {
      const tables = rowCache.entries().map(([key, rows]) => {
        const entries = rows
          .entries()
          .map(([id, row]) => [id, row.fingerprint, row.created, row.record] as const);
        return [key, entries.toArray()] as const;
      });
      yield* encodeCacheFile(Object.fromEntries(tables)).pipe(
        Effect.flatMap((contents) => writeFileStringAtomically({ filePath: cachePath, contents })),
        Effect.ignore,
      );
    }
    return scans;
  }),
};

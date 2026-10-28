import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";

import { openCodeUsageReader, readOpenCodeUsage } from "./usage.ts";

const openDatabase = (filename: string) =>
  Layer.build(NodeSqliteClient.layer({ filename })).pipe(
    Effect.map(Context.get(SqlClient.SqlClient)),
  );

// Counts statements and fetched data values, the expensive column a warm cache skips.
const countQueries = Effect.acquireRelease(
  Effect.sync(() => {
    const counts = { statements: 0, dataRows: 0 };
    const originalAll = NodeSqlite.StatementSync.prototype.all;
    const spy = vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementation(function (
      this: NodeSqlite.StatementSync,
      ...params
    ) {
      const rows = originalAll.apply(this, params);
      counts.statements += 1;
      counts.dataRows += rows.filter((row) => "data" in row).length;
      return rows;
    });
    return { counts, spy };
  }),
  ({ spy }) => Effect.sync(() => spy.mockRestore()),
).pipe(Effect.map(({ counts }) => counts));

describe("readOpenCodeUsage", () => {
  it.effect("bounds raw history allocations while counting every eligible message once", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-large-test-" });
      const db = yield* openDatabase(path.join(dir, "opencode.db"));
      yield* db.unsafe(
        "CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER)",
      );
      const sinceMs = 1780000000000;
      const message = {
        role: "assistant",
        modelID: "claude-sonnet-4-5",
        time: { created: sinceMs },
        tokens: { input: 100, output: 20 },
        body: "x".repeat(64 * 1024),
      };
      const data = JSON.stringify(message);
      const insert = (rowId: number, id: string, payload: string, created = sinceMs) =>
        db.unsafe(
          "INSERT INTO message (rowid, id, session_id, data, time_created) VALUES (?, ?, ?, ?, ?)",
          [rowId, id, "session-1", payload, created],
        );
      for (let index = 0; index < 130; index++) {
        yield* insert(index * 2 - 10, `msg-${index}`, data);
      }
      yield* insert(300, "old", data, sinceMs - 1);
      yield* insert(301, "user", JSON.stringify({ ...message, role: "user" }));
      yield* insert(302, "invalid", "{invalid");
      yield* insert(303, "msg-0", data);

      let largestRawResult = 0;
      const originalAll = NodeSqlite.StatementSync.prototype.all;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementation(function (
            this: NodeSqlite.StatementSync,
            ...params
          ) {
            const rows = originalAll.apply(this, params);
            const rawSize = rows.reduce(
              (size, row) => size + (typeof row.data === "string" ? row.data.length : 0),
              0,
            );
            largestRawResult = Math.max(largestRawResult, rawSize);
            return rows;
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const result = yield* readOpenCodeUsage(dir, sinceMs);
      assert.isFalse(result.error);
      const records = result.files.flatMap((file) => file.records);
      assert.deepStrictEqual(
        records.map((record) => record.dedupeKey),
        Array.from({ length: 130 }, (_, index) => `opencode:msg-${index}`),
      );
      assert.strictEqual(
        records.reduce((total, record) => total + record.totals.uncachedInputTokens, 0),
        13000,
      );
      assert.isAbove(largestRawResult, 0);
      assert.isBelow(largestRawResult, 6 * 1024 * 1024);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads statements in proportion to the window, not the whole history", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "usage-reader-window-test-",
      });
      const db = yield* openDatabase(path.join(dir, "opencode.db"));
      yield* db.unsafe(
        "CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER)",
      );
      yield* db.unsafe("CREATE INDEX message_time_created_idx ON message (time_created)");
      const sinceMs = 1780000000000;
      const data = JSON.stringify({ role: "assistant", modelID: "m", tokens: { input: 1 } });
      yield* db.unsafe(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
         INSERT INTO message (rowid, id, session_id, data, time_created)
         SELECT i * 2, 'old-' || i, 'session-1', ?, ? FROM n`,
        [data, sinceMs - 1],
      );
      // Rowids are not time-ordered: in-window rows sit below and between old ones.
      for (const [rowId, id] of [
        [5001, "b"],
        [1, "a"],
        [20000, "c"],
      ] as const) {
        yield* db.unsafe(
          "INSERT INTO message (rowid, id, session_id, data, time_created) VALUES (?, ?, 'session-1', ?, ?)",
          [rowId, id, data, sinceMs],
        );
      }
      const counts = yield* countQueries;
      const result = yield* readOpenCodeUsage(dir, sinceMs);
      assert.deepStrictEqual(
        result.files.flatMap((file) => file.records).map((record) => record.dedupeKey),
        ["opencode:a", "opencode:b", "opencode:c"],
      );
      assert.isBelow(counts.statements, 10);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("counts migrated OpenCode messages once and sees subsequent WAL writes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const db = yield* openDatabase(path.join(dir, "opencode.db"));
      yield* db.unsafe("PRAGMA journal_mode = WAL");
      yield* db.unsafe("PRAGMA wal_autocheckpoint = 0");
      yield* db.unsafe("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)");
      const message = {
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
        modelID: "claude-sonnet-4-5",
        time: { created: 1780000000000 },
        cost: 0.25,
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } },
      };
      const insert = (id: string, sessionId: string, data: string) =>
        db.unsafe("INSERT INTO message VALUES (?, ?, ?)", [id, sessionId, data]);
      yield* insert(message.id, message.sessionID, JSON.stringify(message));
      const legacy = path.join(dir, "storage", "message", message.sessionID);
      yield* fileSystem.makeDirectory(legacy, { recursive: true });
      yield* fileSystem.writeFileString(path.join(legacy, "msg-1.json"), JSON.stringify(message));
      const first = yield* readOpenCodeUsage(dir, 0);
      assert.isFalse(first.error);
      const records = first.files.flatMap((file) => file.records);
      assert.strictEqual(records.length, 1);
      assert.deepStrictEqual(records[0]?.totals, {
        uncachedInputTokens: 100,
        cachedInputTokens: 30,
        cacheCreationTokens: 10,
        outputTokens: 25,
        reasoningTokens: 5,
      });
      assert.strictEqual(records[0]?.reportedCostUsd, 0.25);
      yield* insert(
        "msg-2",
        message.sessionID,
        JSON.stringify({ ...message, id: "msg-2", time: { created: 1780000001000 } }),
      );
      const next = yield* readOpenCodeUsage(dir, 1780000001000);
      assert.isFalse(next.error);
      assert.deepStrictEqual(
        next.files.flatMap((file) => file.records).map((record) => record.dedupeKey),
        ["opencode:msg-2"],
      );
      assert.isAbove(Number((yield* fileSystem.stat(path.join(dir, "opencode.db-wal"))).size), 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads only legacy OpenCode messages written since the window opened", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const sinceMs = 1780000000000;
      const legacy = path.join(dir, "storage", "message", "session-1");
      yield* fileSystem.makeDirectory(legacy, { recursive: true });
      const write = Effect.fn(function* (id: string, mtimeMs: number) {
        const file = path.join(legacy, `${id}.json`);
        yield* fileSystem.writeFileString(
          file,
          JSON.stringify({
            id,
            sessionID: "session-1",
            role: "assistant",
            modelID: "claude-sonnet-4-5",
            time: { created: sinceMs + 1000 },
            tokens: { input: 100, output: 20 },
          }),
        );
        yield* fileSystem.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
        return file;
      });
      yield* write("msg-old", sinceMs - 60_000);

      const stale = yield* readOpenCodeUsage(dir, sinceMs);
      assert.deepStrictEqual(stale, { files: [], missing: false, error: false });

      const recent = yield* write("msg-new", sinceMs + 60_000);
      const result = yield* readOpenCodeUsage(dir, sinceMs);
      assert.isFalse(result.missing);
      assert.isFalse(result.error);
      assert.deepStrictEqual(
        result.files.map((file) => file.path),
        [recent],
      );
      assert.deepStrictEqual(
        result.files.flatMap((file) => file.records).map((record) => record.dedupeKey),
        ["opencode:msg-new"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("never follows symlinks in the legacy OpenCode store", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const sinceMs = 1780000000000;
      const store = path.join(dir, "storage", "message");
      const session = path.join(store, "session-1");
      yield* fileSystem.makeDirectory(session, { recursive: true });
      const write = Effect.fn(function* (directory: string, id: string, mtimeMs: number) {
        const file = path.join(directory, `${id}.json`);
        yield* fileSystem.writeFileString(
          file,
          JSON.stringify({
            id,
            sessionID: "session-1",
            role: "assistant",
            modelID: "claude-sonnet-4-5",
            time: { created: sinceMs + 1000 },
            tokens: { input: 100, output: 20 },
          }),
        );
        yield* fileSystem.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
        return file;
      });
      const target = yield* write(outside, "msg-linked", sinceMs + 60_000);
      const stale = yield* write(outside, "msg-stale", sinceMs - 60_000);
      yield* fileSystem.symlink(target, path.join(session, "msg-linked.json"));
      yield* fileSystem.symlink(stale, path.join(session, "msg-stale.json"));
      yield* fileSystem.symlink(outside, path.join(store, "session-linked"));
      yield* fileSystem.symlink(store, path.join(session, "cycle"));
      yield* fileSystem.symlink(path.join(outside, "gone.json"), path.join(session, "gone.json"));
      yield* fileSystem.symlink(path.join(session, "loop.json"), path.join(session, "loop.json"));

      const linksOnly = yield* readOpenCodeUsage(dir, sinceMs);
      assert.deepStrictEqual(linksOnly, { files: [], missing: true, error: false });

      const real = yield* write(session, "msg-real", sinceMs + 60_000);
      const result = yield* readOpenCodeUsage(dir, sinceMs);
      assert.isFalse(result.missing);
      assert.isFalse(result.error);
      assert.deepStrictEqual(
        result.files.map((file) => file.path),
        [real],
      );
      assert.deepStrictEqual(
        result.files.flatMap((file) => file.records).map((record) => record.dedupeKey),
        ["opencode:msg-real"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
import * as NodeSqlite from "node:sqlite";

describe("openCodeUsageReader", () => {
  it.effect("scans canonical instance roots once, including XDG and home defaults", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-instances-test-" });
      const home = yield* fileSystem.realPath(temp);
      const defaultRoot = path.join(home, ".local", "share", "opencode");
      const instanceRoot = path.join(home, "instance");
      const dataHome = path.join(home, "xdg");
      const xdgRoot = path.join(dataHome, "opencode");
      const alias = path.join(home, "default-alias");
      for (const root of [defaultRoot, instanceRoot, xdgRoot]) {
        yield* fileSystem.makeDirectory(root, { recursive: true });
      }
      yield* fileSystem.symlink(defaultRoot, alias);
      const instances = [
        { id: "opencode", environment: {}, configured: false },
        {
          id: "opencode-list",
          environment: { OPENCODE_DATA_DIR: ` ${instanceRoot}, ${alias}, ${defaultRoot}, , ` },
          configured: true,
        },
        {
          id: "opencode-xdg",
          environment: { XDG_DATA_HOME: dataHome },
          configured: true,
        },
      ];
      if (openCodeUsageReader.kind !== "scan") throw new Error("Expected an OpenCode scan reader");
      const sources = yield* openCodeUsageReader
        .scan({
          instances: instances.map(({ id, environment, configured }) => ({
            instanceId: ProviderInstanceId.make(id),
            config: undefined,
            environment,
            configured,
          })),
          settings: DEFAULT_SERVER_SETTINGS,
          windowStartMs: 0,
          retentionCutoffMs: 0,
          awaitRefresh: true,
        })
        .pipe(
          Effect.provide(TestProviderHost.layer()),
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provideService(HostProcess.HomeDirectory, home),
        );
      assert.deepStrictEqual(
        sources.map((source) => source.dir).sort(),
        [defaultRoot, instanceRoot, xdgRoot].sort(),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("restores parsed rows after a restart and ignores unreadable cache files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "usage-reader-persist-test-",
      });
      const db = yield* openDatabase(path.join(dir, "opencode.db"));
      yield* db.unsafe(
        "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
      );
      const data = JSON.stringify({ role: "assistant", modelID: "m", tokens: { input: 7 } });
      yield* db.unsafe("INSERT INTO message VALUES ('a', 's', 1, 1, ?)", [data]);
      const counts = yield* countQueries;
      if (openCodeUsageReader.kind !== "scan") throw new Error("Expected an OpenCode scan reader");
      const reader = openCodeUsageReader;
      const scan = (cacheFile?: string) =>
        Effect.gen(function* () {
          const host = yield* ProviderHost.ProviderHost;
          const cachePath = path.join(host.paths.stateDir, "usage-opencode-cache-v1.json");
          if (cacheFile !== undefined) yield* fileSystem.writeFileString(cachePath, cacheFile);
          counts.dataRows = 0;
          const [source] = yield* reader.scan({
            instances: [
              {
                instanceId: ProviderInstanceId.make("opencode"),
                config: undefined,
                environment: { OPENCODE_DATA_DIR: dir },
                configured: true,
              },
            ],
            settings: DEFAULT_SERVER_SETTINGS,
            windowStartMs: 0,
            retentionCutoffMs: 0,
            awaitRefresh: true,
          });
          const records = source?.files?.flatMap((file) => file.records);
          return {
            records,
            dataRows: counts.dataRows,
            saved: yield* fileSystem.readFileString(cachePath),
          };
        }).pipe(Effect.provide(TestProviderHost.layer()));

      const first = yield* scan();
      assert.strictEqual(first.records?.[0]?.totals.uncachedInputTokens, 7);
      // Each host has its own state dir, so seeding its cache file stands in for a restart.
      assert.deepStrictEqual(yield* scan(first.saved), { ...first, dataRows: 0 });
      for (const bad of ["{", '[["key",[[1,{"fingerprint":1}]]]]']) {
        assert.deepStrictEqual(yield* scan(bad), first);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("retries a failed cache write on the next unchanged scan", () => {
    let failures = 1;
    const flakyFileSystem = Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (inner) => ({
        ...inner,
        // Writing under a missing directory fails with a real PlatformError.
        writeFileString: (target: string, contents: string) =>
          failures-- > 0
            ? inner.writeFileString(`${target}/missing/file`, contents)
            : inner.writeFileString(target, contents),
      })),
    ).pipe(Layer.provide(NodeServices.layer));
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "usage-reader-retry-test-",
      });
      const db = yield* openDatabase(path.join(dir, "opencode.db"));
      yield* db.unsafe(
        "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
      );
      yield* db.unsafe("INSERT INTO message VALUES ('a', 's', 1, 1, ?)", [
        JSON.stringify({ role: "assistant", modelID: "m", tokens: { input: 7 } }),
      ]);
      if (openCodeUsageReader.kind !== "scan") throw new Error("Expected an OpenCode scan reader");
      const reader = openCodeUsageReader;
      const host = yield* ProviderHost.ProviderHost;
      const cachePath = path.join(host.paths.stateDir, "usage-opencode-cache-v1.json");
      const scan = reader.scan({
        instances: [
          {
            instanceId: ProviderInstanceId.make("opencode"),
            config: undefined,
            environment: { OPENCODE_DATA_DIR: dir },
            configured: true,
          },
        ],
        settings: DEFAULT_SERVER_SETTINGS,
        windowStartMs: 0,
        retentionCutoffMs: 0,
        awaitRefresh: true,
      });
      yield* scan;
      assert.isFalse(yield* fileSystem.exists(cachePath));
      // The rows are unchanged since the failed write, so only the retry can save them.
      yield* scan;
      assert.isTrue(yield* fileSystem.exists(cachePath));
    }).pipe(
      Effect.provide(
        TestProviderHost.layer().pipe(
          Layer.provideMerge(flakyFileSystem),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  });
});

describe("readOpenCodeUsage cache", () => {
  it.effect("re-reads only appended, updated, and resized rows, and keeps older rows", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-cache-test-" });
      const db = yield* openDatabase(path.join(dir, "opencode.db"));
      yield* db.unsafe(
        "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
      );
      const sinceMs = 1780000000000;
      const data = (input: number) =>
        JSON.stringify({ role: "assistant", modelID: "m", tokens: { input, output: 1 } });
      const insert = (id: string, created: number, input: number) =>
        db.unsafe("INSERT INTO message VALUES (?, 's', ?, ?, ?)", [
          id,
          created,
          created,
          data(input),
        ]);
      yield* insert("old", sinceMs - 86_400_000, 1);
      yield* insert("a", sinceMs, 2);
      yield* insert("b", sinceMs + 1, 3);
      const counts = yield* countQueries;
      const cache = { rows: new Map(), retentionCutoffMs: sinceMs - 10 * 86_400_000 };
      const read = (windowStartMs: number) =>
        Effect.gen(function* () {
          counts.dataRows = 0;
          const cached = yield* readOpenCodeUsage(dir, windowStartMs, cache);
          const fetched = counts.dataRows;
          assert.deepStrictEqual(cached, yield* readOpenCodeUsage(dir, windowStartMs));
          const inputs = cached.files
            .flatMap((file) => file.records)
            .map((record) => `${record.dedupeKey}=${record.totals.uncachedInputTokens}`);
          return [fetched, ...inputs];
        });

      assert.deepStrictEqual(yield* read(sinceMs - 2 * 86_400_000), [
        3,
        "opencode:old=1",
        "opencode:a=2",
        "opencode:b=3",
      ]);
      // A narrower window leaves "old" unchecked but cached for wider windows.
      assert.deepStrictEqual(yield* read(sinceMs), [0, "opencode:a=2", "opencode:b=3"]);
      yield* insert("c", sinceMs + 2, 4);
      assert.deepStrictEqual(yield* read(sinceMs), [
        1,
        "opencode:a=2",
        "opencode:b=3",
        "opencode:c=4",
      ]);
      yield* db.unsafe(
        "UPDATE message SET data = ?, time_updated = time_updated + 1 WHERE id = 'a'",
        [data(5)],
      );
      // Same time_updated, different length: the byte count still invalidates the row.
      yield* db.unsafe("UPDATE message SET data = ? WHERE id = 'b'", [data(30)]);
      yield* db.unsafe("DELETE FROM message WHERE id = 'c'");
      assert.deepStrictEqual(yield* read(sinceMs), [2, "opencode:a=5", "opencode:b=30"]);
      assert.deepStrictEqual(yield* read(sinceMs - 2 * 86_400_000), [
        0,
        "opencode:old=1",
        "opencode:a=5",
        "opencode:b=30",
      ]);
      // Past retention, unchecked rows are dropped and read again when a window needs them.
      cache.retentionCutoffMs = sinceMs;
      yield* read(sinceMs);
      assert.strictEqual((yield* read(sinceMs - 2 * 86_400_000))[0], 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

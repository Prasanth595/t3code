// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's File.Info has no ctime or sub-millisecond mtime, which the cache tests compare.
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, vi } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { makeAntigravityUsageCache, readAntigravityUsage } from "./antigravityUsageReader.ts";

/** A writable connection that stays open until the enclosing scope closes. */
const openDatabase = Effect.fn("openDatabase")(function* (filename: string) {
  const context = yield* Layer.build(NodeSqliteClient.layer({ filename }));
  const sql = Context.get(context, SqlClient.SqlClient);
  return {
    exec: (statement: string) => sql.unsafe(statement),
    run: (statement: string, params: ReadonlyArray<unknown>) => sql.unsafe(statement, params),
  };
});

/** Seeds `filename` and closes it, as a provider that has finished writing. */
const seedDatabase = <E>(
  filename: string,
  seed: (db: Effect.Success<ReturnType<typeof openDatabase>>) => Effect.Effect<void, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seed(yield* openDatabase(filename));
    }),
  );

const tempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
});

function protoNumber(field: number, value: number): number[] {
  const varint = (number: number) => {
    const bytes: number[] = [];
    do {
      const byte = number % 128;
      number = Math.floor(number / 128);
      bytes.push(byte + (number > 0 ? 128 : 0));
    } while (number > 0);
    return bytes;
  };
  return [...varint(field * 8), ...varint(value)];
}

function protoBytes(field: number, bytes: readonly number[]): number[] {
  const encoded = protoNumber(field, bytes.length);
  encoded[0] = encoded[0]! + 2;
  return [...encoded, ...bytes];
}

function protoText(field: number, value: string): number[] {
  return protoBytes(field, [...Buffer.from(value)]);
}

const TABLES =
  "CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE steps (idx INTEGER, metadata BLOB)";

const createTables = (db: Effect.Success<ReturnType<typeof openDatabase>>) =>
  Effect.forEach(TABLES.split("; "), db.exec, { discard: true });

const records = (result: Effect.Success<ReturnType<typeof readAntigravityUsage>>) =>
  result.files.flatMap((file) => file.records);

describe("readAntigravityUsage", () => {
  it.effect(
    "deduplicates Antigravity generation and step usage while preserving retry model and token buckets",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const dir = yield* tempDir;
        const stamp = protoNumber(1, 1780000000);
        const usage = [
          ...protoNumber(2, 100),
          ...protoNumber(3, 40),
          ...protoNumber(4, 5),
          ...protoNumber(5, 20),
          ...protoNumber(9, 10),
          ...protoText(11, "response-1"),
        ];
        const retry = [
          ...protoNumber(1, 1026),
          ...protoNumber(2, 12),
          ...protoNumber(3, 3),
          ...protoText(11, "retry-1"),
        ];
        const generation = protoBytes(1, [
          ...protoBytes(4, usage),
          ...protoText(19, "Gemini 3 Pro"),
          ...protoBytes(9, protoBytes(4, stamp)),
        ]);
        const step = [
          ...protoBytes(9, usage),
          ...protoBytes(8, stamp),
          ...protoBytes(28, protoBytes(2, retry)),
        ];
        yield* seedDatabase(path.join(dir, "session-1.db"), (db) =>
          Effect.gen(function* () {
            yield* createTables(db);
            yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
              0,
              new Uint8Array(generation),
            ]);
            yield* db.run("INSERT INTO steps VALUES (?, ?)", [0, new Uint8Array(step)]);
          }),
        );
        const result = yield* readAntigravityUsage(dir, 0);
        assert.deepStrictEqual(result.errors, []);
        const read = records(result);
        assert.strictEqual(read.length, 2);
        const main = read.find((record) => record.model === "gemini-3-pro");
        assert.isDefined(main);
        assert.strictEqual(main?.timestampMs, 1780000000000);
        assert.strictEqual(main?.sessionId, "session-1");
        assert.deepStrictEqual(main?.totals, {
          uncachedInputTokens: 100,
          cachedInputTokens: 20,
          cacheCreationTokens: 5,
          outputTokens: 40,
          reasoningTokens: 10,
        });
        assert.strictEqual(
          read.find((record) => record.model === "claude-opus-4-6")?.totals.uncachedInputTokens,
          12,
        );
        assert.deepStrictEqual(records(yield* readAntigravityUsage(dir, 1780000000001)), []);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses the matching Antigravity generation model for each model-less step", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      yield* seedDatabase(path.join(dir, "model-switch.db"), (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          for (const [idx, name] of ["Gemini 3 Pro", "Claude Opus 4.6"].entries()) {
            yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
              idx,
              new Uint8Array(protoBytes(1, protoText(19, name))),
            ]);
            yield* db.run("INSERT INTO steps VALUES (?, ?)", [
              idx,
              new Uint8Array(protoBytes(9, protoNumber(2, 10 + idx))),
            ]);
          }
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      assert.deepStrictEqual(
        records(result).map((record) => record.model),
        ["gemini-3-pro", "claude-opus-4-6"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("merges Antigravity aliases that bridge previously separate step records", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      yield* seedDatabase(path.join(dir, "bridge.db"), (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [
            0,
            new Uint8Array(protoBytes(9, [...protoNumber(2, 100), ...protoText(11, "response")])),
          ]);
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [
            1,
            new Uint8Array(protoBytes(9, [...protoNumber(3, 40), ...protoText(12, "provider")])),
          ]);
          yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
            0,
            new Uint8Array(
              protoBytes(1, [
                ...protoText(19, "Gemini 3 Pro"),
                ...protoBytes(4, [
                  ...protoNumber(2, 50),
                  ...protoNumber(5, 20),
                  ...protoText(11, "response"),
                  ...protoText(12, "provider"),
                ]),
              ]),
            ),
          ]);
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      const read = records(result);
      assert.strictEqual(read.length, 1);
      assert.deepStrictEqual(read[0]?.totals, {
        uncachedInputTokens: 100,
        cachedInputTokens: 20,
        cacheCreationTokens: 0,
        outputTokens: 40,
        reasoningTokens: 0,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "merges Antigravity provider and message aliases across configured roots while keeping original ownership",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* tempDir;
        const roots = [path.join(dir, "first"), path.join(dir, "second")];
        for (const [index, root] of roots.entries()) {
          yield* fileSystem.makeDirectory(root);
          yield* seedDatabase(path.join(root, `session-${index}.db`), (db) =>
            Effect.gen(function* () {
              yield* db.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
              for (const identity of [7, 12]) {
                const usage = [
                  ...protoNumber(1, 246),
                  ...protoNumber(2, index === 0 ? 100 : 150),
                  ...protoText(11, `response-${index}-${identity}`),
                  ...protoText(identity, `shared-${identity}`),
                ];
                yield* db.run("INSERT INTO steps VALUES (?, ?)", [
                  identity,
                  new Uint8Array(protoBytes(9, usage)),
                ]);
              }
            }),
          );
        }
        const result = yield* readAntigravityUsage(roots, 0);
        assert.deepStrictEqual(result.errors, []);
        assert.strictEqual(result.files.length, 2);
        assert.strictEqual(result.files[0]?.root, roots[0]);
        assert.strictEqual(result.files[0]?.records.length, 2);
        assert.strictEqual(result.files[1]?.records.length, 0);
        assert.deepStrictEqual(
          result.files[0]?.records.map((record) => record.totals.uncachedInputTokens),
          [150, 150],
        );
        assert.isTrue(result.files[0]?.records.every((record) => record.sessionId === "session-0"));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("upgrades Antigravity fallback timestamps before applying the date window", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      for (const fallback of ["mtime", "trajectory"]) {
        const file = path.join(dir, `${fallback}.db`);
        yield* seedDatabase(file, (db) =>
          Effect.gen(function* () {
            yield* createTables(db);
            if (fallback === "trajectory") {
              yield* db.exec("CREATE TABLE trajectory_metadata_blob (data BLOB)");
              yield* db.run("INSERT INTO trajectory_metadata_blob VALUES (?)", [
                new Uint8Array(protoBytes(2, protoNumber(1, 1780000200))),
              ]);
            }
            for (const [index, seconds] of [1780000000, 1780000200].entries()) {
              const usage = [...protoNumber(2, 10), ...protoText(11, `${fallback}-${index}`)];
              yield* db.run("INSERT INTO steps VALUES (?, ?)", [
                index,
                new Uint8Array(protoBytes(9, usage)),
              ]);
              yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
                index,
                new Uint8Array(
                  protoBytes(1, [
                    ...protoBytes(4, usage),
                    ...protoBytes(9, protoBytes(4, protoNumber(1, seconds))),
                  ]),
                ),
              ]);
            }
          }),
        );
        yield* fileSystem.utimes(file, 1780000000, 1780000000);
      }
      const result = yield* readAntigravityUsage(dir, 1780000100000);
      assert.deepStrictEqual(result.errors, []);
      const read = records(result);
      assert.strictEqual(read.length, 2);
      assert.deepStrictEqual(
        read.map((record) => record.timestampMs),
        [1780000200000, 1780000200000],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  const antigravityGeneration = (responseId: string) =>
    new Uint8Array(
      protoBytes(1, [
        ...protoBytes(4, [
          ...protoNumber(2, 100),
          ...protoNumber(3, 40),
          ...protoText(11, responseId),
        ]),
        ...protoText(19, "Gemini 3 Pro"),
        ...protoBytes(9, protoBytes(4, protoNumber(1, 1780000000))),
      ]),
    );

  it.effect("reuses an unchanged Antigravity database instead of decoding it again", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      const db = yield* openDatabase(path.join(dir, "session-1.db"));
      yield* db.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
      yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [0, antigravityGeneration("r-1")]);
      const cache = makeAntigravityUsageCache();
      assert.deepStrictEqual((yield* readAntigravityUsage(dir, 0, cache)).errors, []);

      // An exclusive lock makes a fresh read fail without touching the file, so
      // only a cache hit can still return the earlier records.
      yield* db.exec("BEGIN EXCLUSIVE");
      assert.strictEqual((yield* readAntigravityUsage(dir, 0)).errors.length, 1);
      const cached = yield* readAntigravityUsage(dir, 0, cache);
      assert.deepStrictEqual(cached.errors, []);
      assert.deepStrictEqual(
        records(cached).map((record) => record.dedupeKey),
        ["antigravity:11:r-1"],
      );
      yield* db.exec("ROLLBACK");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rereads an Antigravity database rewritten with its size and mtime restored", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const dir = yield* tempDir;
      const path = pathService.join(dir, "session-1.db");
      yield* seedDatabase(path, (db) =>
        Effect.gen(function* () {
          yield* db.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
          yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
            0,
            antigravityGeneration("r-1"),
          ]);
        }),
      );
      yield* fileSystem.utimes(path, 1780000000, 1780000000);
      const cache = makeAntigravityUsageCache();
      assert.deepStrictEqual((yield* readAntigravityUsage(dir, 0, cache)).errors, []);

      // ctime has the kernel's timestamp granularity, which can be a few
      // milliseconds, so repeat the forged rewrite until it lands on a later tick
      // than the cached read, as any real rewrite does.
      const stat = () => Effect.promise(() => NodeFSP.stat(path));
      const cached = yield* stat();
      do {
        yield* fileSystem.writeFile(path, new Uint8Array(cached.size));
        yield* fileSystem.utimes(path, 1780000000, 1780000000);
      } while ((yield* stat()).ctimeMs === cached.ctimeMs);
      const restored = yield* stat();
      assert.strictEqual(restored.size, cached.size);
      assert.strictEqual(restored.mtimeMs, cached.mtimeMs);
      const next = yield* readAntigravityUsage(dir, 0, cache);
      assert.deepStrictEqual(next.errors, [path]);
      assert.deepStrictEqual(records(next), []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rereads an Antigravity database when only its WAL changed", () =>
    Effect.gen(function* () {
      const pathService = yield* Path.Path;
      const dir = yield* tempDir;
      const path = pathService.join(dir, "session-1.db");
      const db = yield* openDatabase(path);
      yield* db.exec("PRAGMA journal_mode = WAL");
      yield* db.exec("PRAGMA wal_autocheckpoint = 0");
      yield* db.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
      const insert = (idx: number, responseId: string) =>
        db.run("INSERT INTO gen_metadata VALUES (?, ?)", [idx, antigravityGeneration(responseId)]);
      yield* insert(0, "r-1");
      const cache = makeAntigravityUsageCache();
      const first = yield* readAntigravityUsage(dir, 0, cache);
      assert.strictEqual(records(first).length, 1);

      const before = yield* Effect.promise(() => NodeFSP.stat(path));
      yield* insert(1, "r-2");
      const after = yield* Effect.promise(() => NodeFSP.stat(path));
      assert.strictEqual(after.size, before.size);
      assert.strictEqual(after.mtimeMs, before.mtimeMs);

      const next = yield* readAntigravityUsage(dir, 0, cache);
      assert.deepStrictEqual(
        records(next).map((record) => record.dedupeKey),
        ["antigravity:11:r-1", "antigravity:11:r-2"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads Antigravity step-only stores and reports malformed databases", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      yield* seedDatabase(path.join(dir, "steps.db"), (db) =>
        Effect.gen(function* () {
          yield* db.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
          const usage = [...protoNumber(1, 246), ...protoNumber(2, 10), ...protoNumber(3, 5)];
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [
            0,
            new Uint8Array([...protoBytes(9, usage), ...protoBytes(8, protoNumber(1, 1780000000))]),
          ]);
        }),
      );
      yield* fileSystem.writeFileString(path.join(dir, "broken.db"), "not a sqlite database");
      const result = yield* readAntigravityUsage(dir, 0);
      assert.strictEqual(result.errors.length, 1);
      assert.strictEqual(records(result)[0]?.model, "gemini-2.5-pro");
      assert.strictEqual(records(result)[0]?.totals.outputTokens, 5);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores large values in unused Antigravity protobuf fields", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      yield* seedDatabase(path.join(dir, "large-varint.db"), (db) =>
        Effect.gen(function* () {
          yield* db.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
          const unusedField = [...protoNumber(99, 0).slice(0, -1), ...Array(9).fill(0xff), 0x01];
          const usage = [...protoNumber(1, 246), ...protoNumber(2, 10), ...unusedField];
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [
            0,
            new Uint8Array(protoBytes(9, usage)),
          ]);
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      assert.strictEqual(records(result)[0]?.totals.uncachedInputTokens, 10);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  /** Records the SQL of each StatementSync.all() call and how many blob rows it returned. */
  const recordReads = Effect.gen(function* () {
    // Statements are finalized when the reader closes the database, so each
    // call's SQL is recorded while it runs.
    const reads: Array<{ sql: string; blobRows: number }> = [];
    const all = NodeSqlite.StatementSync.prototype.all;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementation(function (
          this: NodeSqlite.StatementSync,
          ...params
        ) {
          const result = all.apply(this, params);
          const blobRows = result.filter((row) => "data" in row || "metadata" in row);
          reads.push({ sql: this.sourceSQL, blobRows: blobRows.length });
          return result;
        }),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    return reads;
  });

  it.effect("reads large Antigravity databases a bounded page of blobs at a time", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      const rows = 600;
      yield* seedDatabase(path.join(dir, "large.db"), (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          yield* db.exec("BEGIN");
          for (let idx = 0; idx < rows; idx++) {
            yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
              idx,
              antigravityGeneration(`g-${idx}`),
            ]);
            yield* db.run("INSERT INTO steps VALUES (?, ?)", [
              idx,
              new Uint8Array(protoBytes(9, [...protoNumber(2, 10), ...protoText(11, `s-${idx}`)])),
            ]);
          }
          yield* db.exec("COMMIT");
        }),
      );
      const reads = yield* recordReads;
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      assert.strictEqual(records(result).length, rows * 2);
      assert.strictEqual(
        reads.reduce((sum, read) => sum + read.blobRows, 0),
        rows * 2,
      );
      for (const read of reads) {
        assert.isAtMost(read.blobRows, 256, read.sql);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("pages Antigravity tables whose rowids exceed Number.MAX_SAFE_INTEGER", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      const rows = 300;
      yield* seedDatabase(path.join(dir, "large-rowid.db"), (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          yield* db.exec("CREATE TABLE trajectory_metadata_blob (data BLOB)");
          yield* db.exec("BEGIN");
          // Rowids start above 2^53 and count up while idx counts down; only the
          // last trajectory row has a timestamp.
          for (let index = 0; index < rows; index++) {
            const rowid = 2n ** 53n + 1n + BigInt(index);
            const idx = rows - 1 - index;
            yield* db.run("INSERT INTO gen_metadata (rowid, idx, data) VALUES (?, ?, ?)", [
              rowid,
              idx,
              antigravityGeneration(`g-${idx}`),
            ]);
            yield* db.run("INSERT INTO steps (rowid, idx, metadata) VALUES (?, ?, ?)", [
              rowid,
              idx,
              new Uint8Array(protoBytes(9, [...protoNumber(2, 10), ...protoText(11, `s-${idx}`)])),
            ]);
            yield* db.run("INSERT INTO trajectory_metadata_blob (rowid, data) VALUES (?, ?)", [
              rowid,
              new Uint8Array(protoBytes(2, protoNumber(1, index === rows - 1 ? 1780000300 : 0))),
            ]);
          }
          yield* db.exec("COMMIT");
        }),
      );
      const reads = yield* recordReads;
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      const indices = Array.from({ length: rows }, (_, idx) => idx);
      assert.deepStrictEqual(
        records(result).map((record) => record.dedupeKey),
        [
          ...indices.map((idx) => `antigravity:11:s-${idx}`),
          ...indices.map((idx) => `antigravity:11:g-${idx}`),
        ],
      );
      assert.strictEqual(records(result)[0]?.timestampMs, 1780000300000);
      for (const read of reads) {
        assert.isAtMost(read.blobRows, 256, read.sql);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stops reading Antigravity trajectory pages at the first timestamp", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      const rows = 600;
      yield* seedDatabase(path.join(dir, "trajectory.db"), (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          yield* db.exec("CREATE TABLE trajectory_metadata_blob (data BLOB)");
          yield* db.exec("BEGIN");
          // Rows before 300 have no timestamp, and rows after it do not decode.
          for (let index = 0; index < rows; index++) {
            yield* db.run("INSERT INTO trajectory_metadata_blob VALUES (?)", [
              new Uint8Array(
                index > 300
                  ? [0xff]
                  : protoBytes(2, protoNumber(1, index === 300 ? 1780000300 : 0)),
              ),
            ]);
          }
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [
            0,
            new Uint8Array(protoBytes(9, protoNumber(2, 10))),
          ]);
          yield* db.exec("COMMIT");
        }),
      );
      const reads = yield* recordReads;
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      assert.deepStrictEqual(
        records(result).map((record) => record.timestampMs),
        [1780000300000],
      );
      for (const read of reads) {
        assert.isAtMost(read.blobRows, 256, read.sql);
      }
      // The second page holds the timestamp, so the third is never read.
      assert.deepStrictEqual(
        reads
          .filter((read) => read.sql.includes("FROM trajectory_metadata_blob"))
          .map((read) => read.blobRows),
        [256, 256],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // Inserted out of idx order, with idx 1 twice; the second idx 1 row is last.
  const shuffledGenerations = [
    [2, 30, "Gemini 2.5 Pro"],
    [0, 10, "Gemini 3 Pro"],
    [1, 20, "Gemini 3 Flash"],
    [1, 21, "Claude Opus 4.6"],
  ] as const;

  /** Rows without response ids, so each dedupe key is the row's position after sorting by idx. */
  const positionalUsage = (
    db: Effect.Success<ReturnType<typeof openDatabase>>,
    generations: ReadonlyArray<readonly [idx: number, input: number, name: string]>,
  ) =>
    Effect.gen(function* () {
      for (const [idx, input, name] of generations) {
        yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
          idx,
          new Uint8Array(
            protoBytes(1, [...protoBytes(4, protoNumber(2, input)), ...protoText(19, name)]),
          ),
        ]);
      }
      for (const [idx, input] of [
        [1, 7],
        [0, 5],
      ] as const) {
        yield* db.run("INSERT INTO steps VALUES (?, ?)", [
          idx,
          new Uint8Array(protoBytes(9, protoNumber(2, input))),
        ]);
      }
    });

  const inputTokens = (uncachedInputTokens: number) => ({
    uncachedInputTokens,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  });

  const summary = (result: Effect.Success<ReturnType<typeof readAntigravityUsage>>) =>
    records(result).map(({ dedupeKey, model, totals }) => ({ dedupeKey, model, totals }));

  it.effect("orders unindexed Antigravity rows by idx, keeping insertion order for equal idx", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      yield* seedDatabase(path.join(dir, "order.db"), (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          yield* positionalUsage(db, shuffledGenerations);
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      assert.deepStrictEqual(summary(result), [
        { dedupeKey: "antigravity:order:step:0:0", model: "gemini-3-pro", totals: inputTokens(5) },
        {
          dedupeKey: "antigravity:order:step:1:0",
          model: "claude-opus-4-6",
          totals: inputTokens(7),
        },
        {
          dedupeKey: "antigravity:order:generation:0:0",
          model: "gemini-3-pro",
          totals: inputTokens(10),
        },
        {
          dedupeKey: "antigravity:order:generation:1:0",
          model: "gemini-3-flash",
          totals: inputTokens(20),
        },
        {
          dedupeKey: "antigravity:order:generation:2:0",
          model: "claude-opus-4-6",
          totals: inputTokens(21),
        },
        {
          dedupeKey: "antigravity:order:generation:3:0",
          model: "gemini-2.5-pro",
          totals: inputTokens(30),
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  /** The records of `positionalUsage` without the second idx 1 generation. */
  const keyedSummary = (sessionId: string) => [
    {
      dedupeKey: `antigravity:${sessionId}:step:0:0`,
      model: "gemini-3-pro",
      totals: inputTokens(5),
    },
    {
      dedupeKey: `antigravity:${sessionId}:step:1:0`,
      model: "gemini-3-flash",
      totals: inputTokens(7),
    },
    {
      dedupeKey: `antigravity:${sessionId}:generation:0:0`,
      model: "gemini-3-pro",
      totals: inputTokens(10),
    },
    {
      dedupeKey: `antigravity:${sessionId}:generation:1:0`,
      model: "gemini-3-flash",
      totals: inputTokens(20),
    },
    {
      dedupeKey: `antigravity:${sessionId}:generation:2:0`,
      model: "gemini-2.5-pro",
      totals: inputTokens(30),
    },
  ];

  it.effect("reads Antigravity tables whose idx is an INTEGER PRIMARY KEY", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      yield* seedDatabase(path.join(dir, "keyed.db"), (db) =>
        Effect.gen(function* () {
          yield* db.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)");
          yield* db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB)");
          // A primary key cannot repeat, so the second idx 1 generation is left out.
          yield* positionalUsage(db, shuffledGenerations.slice(0, 3));
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      assert.deepStrictEqual(summary(result), keyedSummary("keyed"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads WITHOUT ROWID Antigravity tables", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      yield* seedDatabase(path.join(dir, "without-rowid.db"), (db) =>
        Effect.gen(function* () {
          yield* db.exec(
            "CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB) WITHOUT ROWID",
          );
          yield* db.exec(
            "CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB) WITHOUT ROWID",
          );
          yield* positionalUsage(db, shuffledGenerations.slice(0, 3));
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      assert.deepStrictEqual(summary(result), keyedSummary("without-rowid"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads Antigravity tables with a column named rowid", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      const rows = 300;
      yield* seedDatabase(path.join(dir, "rowid-column.db"), (db) =>
        Effect.gen(function* () {
          yield* db.exec("CREATE TABLE gen_metadata (rowid TEXT, idx INTEGER, data BLOB)");
          yield* db.exec("CREATE TABLE steps (rowid TEXT, idx INTEGER, metadata BLOB)");
          yield* db.exec("BEGIN");
          for (let idx = 0; idx < rows; idx++) {
            yield* db.run("INSERT INTO gen_metadata VALUES (?, ?, ?)", [
              `g-${idx}`,
              idx,
              antigravityGeneration(`g-${idx}`),
            ]);
            yield* db.run("INSERT INTO steps VALUES (?, ?, ?)", [
              `s-${idx}`,
              idx,
              new Uint8Array(protoBytes(9, [...protoNumber(2, 10), ...protoText(11, `s-${idx}`)])),
            ]);
          }
          yield* db.exec("COMMIT");
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      assert.strictEqual(records(result).length, rows * 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the index order of equal idx rows in indexed Antigravity tables", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      yield* seedDatabase(path.join(dir, "indexed.db"), (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          yield* db.exec("CREATE INDEX gen_metadata_idx ON gen_metadata (idx ASC, data DESC)");
          yield* positionalUsage(db, [
            [0, 1, "Gemini 3 Pro"],
            [0, 2, "Gemini 3 Pro"],
            [0, 3, "Gemini 3 Pro"],
          ]);
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      // ORDER BY idx reads the covering index, which sorts equal idx rows by data, descending.
      assert.deepStrictEqual(
        summary(result)
          .filter(({ dedupeKey }) => dedupeKey?.includes(":generation:"))
          .map(({ totals }) => totals.uncachedInputTokens),
        [3, 2, 1],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("takes the first Antigravity trajectory timestamp in an indexed table's order", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      yield* seedDatabase(path.join(dir, "indexed-trajectory.db"), (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          // With a second column in the table, SQLite reads data from the smaller index.
          yield* db.exec("CREATE TABLE trajectory_metadata_blob (id TEXT, data BLOB)");
          yield* db.exec("CREATE INDEX trajectory_data ON trajectory_metadata_blob (data DESC)");
          for (const seconds of [1780000001, 1780000002, 1780000003]) {
            yield* db.run("INSERT INTO trajectory_metadata_blob VALUES (?, ?)", [
              `t-${seconds}`,
              new Uint8Array(protoBytes(2, protoNumber(1, seconds))),
            ]);
          }
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [
            0,
            new Uint8Array(protoBytes(9, protoNumber(2, 10))),
          ]);
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      // The index returns the last inserted timestamp first.
      assert.deepStrictEqual(
        records(result).map((record) => record.timestampMs),
        [1780000003000],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// @effect-diagnostics nodeBuiltinImport:off - real SQLite verifies the D1 transaction's deduplication.
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import type * as Cloudflare from "@cloudflare/workers-types";
import { expect, it } from "@effect/vitest";
import { persistSavings } from "./Savings.ts";

it.effect(
  "increments lifetime totals once per receipt, including retries and different hosts",
  () =>
    Effect.gen(function* () {
      const sqlite = new NodeSqlite.DatabaseSync(":memory:");
      try {
        sqlite.exec(
          NodeFS.readFileSync(
            new URL("./telemetry-migrations/0001_savings.sql", import.meta.url),
            "utf8",
          ),
        );
        sqlite.exec(
          NodeFS.readFileSync(
            new URL("./telemetry-migrations/0002_unspecified_tier.sql", import.meta.url),
            "utf8",
          ),
        );
        const db = {
          prepare: (sql: string) => ({ bind: (...args: (string | number)[]) => ({ sql, args }) }),
          batch: async (statements: { sql: string; args: (string | number)[] }[]) => {
            sqlite.exec("BEGIN");
            try {
              for (const statement of statements)
                sqlite.prepare(statement.sql).run(...statement.args);
              sqlite.exec("COMMIT");
            } catch (error) {
              sqlite.exec("ROLLBACK");
              throw error;
            }
            return [];
          },
        } as unknown as Cloudflare.D1Database;
        const summary = {
          id: "a".repeat(64),
          recordedAt: 1,
          host: "mbp",
          platform: "darwin",
          arch: "arm64",
          ci: false,
          runId: "",
          tasks: [{ package: "server", task: "check", source: "remote" as const, savedMs: 900 }],
        };
        yield* persistSavings(db, summary, "alice");
        yield* persistSavings(db, summary, "alice");
        yield* persistSavings(db, { ...summary, id: "b".repeat(64), host: "linux" }, "bob");
        yield* persistSavings(db, { ...summary, id: "c".repeat(64) }, "alice");
        const rows = sqlite
          .prepare("SELECT developer, host, remote_ms, remote_hits FROM savings ORDER BY developer")
          .all();
        expect(rows).toEqual([
          { developer: "alice", host: "mbp", remote_ms: 1800, remote_hits: 2 },
          { developer: "bob", host: "linux", remote_ms: 900, remote_hits: 1 },
        ]);
      } finally {
        sqlite.close();
      }
    }),
);

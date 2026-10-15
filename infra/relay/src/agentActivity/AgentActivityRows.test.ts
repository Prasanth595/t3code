import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect, type PgTable } from "drizzle-orm/pg-core";
import * as NodeSqlite from "node:sqlite";

import * as RelayDb from "../db.ts";
import { relayAgentActivityRows } from "../persistence/schema.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";
import { makeAggregateState } from "./agentActivityAggregate.ts";

const state: RelayAgentActivityState = {
  environmentId: "env-1" as RelayAgentActivityState["environmentId"],
  threadId: "thread-1" as RelayAgentActivityState["threadId"],
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "gpt-5.4",
  phase: "running",
  headline: "Running",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deepLink: "/threads/env-1/thread-1",
};

describe("AgentActivityRows", () => {
  it.effect(
    "filters expired aggregate rows in SQL without changing identity reads or aggregates",
    () =>
      Effect.gen(function* () {
        const sqlite = yield* Effect.acquireRelease(
          Effect.sync(() => new NodeSqlite.DatabaseSync(":memory:")),
          (db) => Effect.sync(() => db.close()),
        );
        // Execute the service's PostgreSQL query locally; SQLite has the same JSON
        // extraction/comparison operators, with REGEXP standing in for PostgreSQL's ~.
        sqlite.function("regexp", (pattern, value) =>
          typeof pattern === "string" &&
          typeof value === "string" &&
          new RegExp(pattern).test(value)
            ? 1
            : 0,
        );
        sqlite.exec(`
        CREATE TABLE relay_agent_activity_rows (
          environment_id TEXT, environment_public_key TEXT, thread_id TEXT,
          state_json TEXT, updated_at TEXT
        );
        CREATE TABLE relay_environment_links (
          environment_id TEXT, environment_public_key TEXT, user_id TEXT,
          revoked_at TEXT, live_activities_enabled INTEGER
        );
        INSERT INTO relay_environment_links VALUES ('env-1', 'key', 'user-2', NULL, 1);
        INSERT INTO relay_environment_links VALUES ('revoked', 'key', 'user-2', 'revoked', 1);
        INSERT INTO relay_environment_links VALUES ('disabled', 'key', 'user-2', NULL, 0);
        INSERT INTO relay_environment_links VALUES ('other-user', 'key', 'other-user', NULL, 1);
      `);
        const insert = sqlite.prepare(
          "INSERT INTO relay_agent_activity_rows VALUES (?, 'key', ?, ?, ?)",
        );
        const nowMs = DateTime.makeUnsafe("2026-09-05T12:00:00.000Z").epochMilliseconds;
        const fixtures: RelayAgentActivityState[] = [];
        const expectedThreads: string[] = [];
        for (const phase of [
          "starting",
          "running",
          "waiting_for_approval",
          "waiting_for_input",
          "stale",
          "completed",
          "failed",
        ] as const) {
          const ttl =
            phase === "running" || phase === "starting"
              ? 2 * 60 * 60_000
              : phase === "completed" || phase === "failed"
                ? 15 * 60_000
                : 24 * 60 * 60_000;
          for (const offset of [-1, 0, 1]) {
            const row = {
              ...state,
              phase,
              threadId: `${phase}:${offset}` as RelayAgentActivityState["threadId"],
              updatedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - ttl + offset)),
            };
            fixtures.push(row);
            if (offset >= 0) expectedThreads.push(row.threadId);
          }
        }
        for (const updatedAt of [
          "2026-09-05T14:00:00+02:00",
          "2026-09-05T12:00:00Z",
          "2026-09-06T00:00:00.000Z",
          "invalid",
        ]) {
          const row = {
            ...state,
            threadId: `date:${updatedAt}` as RelayAgentActivityState["threadId"],
            updatedAt,
          };
          fixtures.push(row);
          expectedThreads.push(row.threadId);
        }
        for (const row of fixtures)
          insert.run(row.environmentId, row.threadId, JSON.stringify(row), row.updatedAt);
        for (const environmentId of ["revoked", "disabled", "other-user"]) {
          const row = {
            ...state,
            environmentId,
            updatedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
          };
          insert.run(environmentId, row.threadId, JSON.stringify(row), row.updatedAt);
        }

        const dialect = new PgDialect();
        const db = {
          select: (selection: { stateJson: typeof relayAgentActivityRows.stateJson }) => ({
            from: (table: PgTable) => ({
              innerJoin: (joined: PgTable, join: SQL) => ({
                where: (condition: SQL) => ({
                  orderBy: (order: SQL) =>
                    Effect.sync(() => {
                      const query = dialect.sqlToQuery(
                        sql`SELECT ${selection.stateJson} AS "stateJson" FROM ${table} INNER JOIN ${joined} ON ${join} WHERE ${condition} ORDER BY ${order}`,
                      );
                      const bindings = Object.fromEntries(
                        query.params.map((value, index) => [
                          String(index + 1),
                          typeof value === "boolean"
                            ? Number(value)
                            : (value as NodeSqlite.SQLInputValue),
                        ]),
                      );
                      return sqlite
                        .prepare(query.sql.replaceAll(" ~ ", " REGEXP "))
                        .all(bindings)
                        .map((row) => ({
                          stateJson: JSON.parse(String(row.stateJson)) as unknown,
                        }));
                    }),
                }),
              }),
            }),
          }),
        } as unknown as RelayDb.RelayDb["Service"];
        const rows = yield* AgentActivityRows.make.pipe(Effect.provideService(RelayDb.RelayDb, db));
        const visible = yield* rows.listForUser({ userId: "user-2", visibleAt: nowMs });
        expect(visible.map((row) => row.threadId).toSorted()).toEqual(expectedThreads.toSorted());
        const all = yield* rows.listForUser({ userId: "user-2" });
        expect(all).toHaveLength(fixtures.length);
        expect(
          yield* rows.getForUserThread({
            userId: "user-2",
            environmentId: "env-1",
            threadId: "completed:-1",
          }),
        ).toEqual(fixtures.find((row) => row.threadId === "completed:-1"));
        for (const phases of [
          ["running", "starting"],
          ["completed", "failed"],
          ["waiting_for_approval", "waiting_for_input", "stale"],
          [],
        ]) {
          const filter = (states: ReadonlyArray<RelayAgentActivityState>) =>
            states.filter((row) => phases.length === 0 || phases.includes(row.phase));
          expect(
            makeAggregateState({ activeStates: filter(visible), terminalState: null, nowMs }),
          ).toEqual(makeAggregateState({ activeStates: filter(all), terminalState: null, nowMs }));
        }

        // DateTime normalizes these to October 1; string comparison alone
        // would exclude work that is still inside the two-hour window.
        for (const updatedAt of ["2026-09-31T00:00:00.000Z", "2026-09-30T24:00:00.000Z"]) {
          const row = { ...state, threadId: updatedAt, updatedAt };
          insert.run(row.environmentId, row.threadId, JSON.stringify(row), row.updatedAt);
        }
        const rolloverTime = DateTime.makeUnsafe("2026-10-01T01:00:00.000Z").epochMilliseconds;
        const rolled = yield* rows.listForUser({ userId: "user-2", visibleAt: rolloverTime });
        expect(
          makeAggregateState({ activeStates: rolled, terminalState: null, nowMs: rolloverTime })
            ?.activeCount,
        ).toBe(2);
      }).pipe(Effect.scoped),
  );

  it.effect("validates database JSON objects and ignores invalid activity rows", () => {
    const queryRows = [
      { stateJson: null },
      { stateJson: JSON.stringify(state) },
      { stateJson: { ...state, phase: "invalid" } },
      { stateJson: { ...state, unrelated: "ignored" } },
    ];
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              orderBy: () => Effect.succeed(queryRows),
            }),
          }),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const rows = yield* AgentActivityRows.AgentActivityRows;
      expect(yield* rows.listForUser({ userId: "user-2" })).toEqual([state]);
      expect(
        yield* rows.getForUserThread({
          userId: "user-2",
          environmentId: "env-1",
          threadId: "thread-1",
        }),
      ).toEqual(state);
    }).pipe(
      Effect.provide(
        AgentActivityRows.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db))),
      ),
    );
  });

  it.effect("preserves activity context on persistence failures", () => {
    const cause = new Error("database unavailable");
    const failingDb = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => Effect.fail(cause),
        }),
      }),
      delete: () => ({
        where: () => Effect.fail(cause),
      }),
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              orderBy: () => Effect.fail(cause),
            }),
          }),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const rows = yield* AgentActivityRows.AgentActivityRows;

      const upsertError = yield* rows
        .upsert({ environmentPublicKey: "public-key", state })
        .pipe(Effect.flip);
      expect(upsertError).toMatchObject({
        environmentId: "env-1",
        threadId: "thread-1",
        cause,
      });
      expect(upsertError.message).toBe(
        "Failed to persist agent activity state for environment env-1, thread thread-1.",
      );

      const deleteError = yield* rows
        .remove({
          environmentId: "env-1",
          environmentPublicKey: "public-key",
          threadId: "thread-1",
        })
        .pipe(Effect.flip);
      expect(deleteError).toMatchObject({
        environmentId: "env-1",
        threadId: "thread-1",
        cause,
      });
      expect(deleteError.message).toBe(
        "Failed to delete agent activity state for environment env-1, thread thread-1.",
      );

      const listError = yield* rows.listForUser({ userId: "user-2" }).pipe(Effect.flip);
      expect(listError).toMatchObject({ userId: "user-2", cause });
      expect(listError.message).toBe("Failed to list agent activity state for user user-2.");

      const getError = yield* rows
        .getForUserThread({
          userId: "user-2",
          environmentId: "env-1",
          threadId: "thread-1",
        })
        .pipe(Effect.flip);
      expect(getError).toMatchObject({ userId: "user-2", cause });
    }).pipe(
      Effect.provide(
        AgentActivityRows.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, failingDb))),
      ),
    );
  });
});

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as RelayDb from "../db.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";

describe("AgentActivityRows", () => {
  it.effect("reports only inserts and changed payloads as changed", () => {
    let stored: unknown;
    const dialect = new PgDialect();
    const db = {
      insert: () => ({
        values: (values: { stateJson: unknown }) => ({
          onConflictDoUpdate: (options: { setWhere?: SQL }) => {
            const result = Effect.sync(() => {
              const condition = options.setWhere && dialect.sqlToQuery(options.setWhere);
              expect(condition?.sql).toContain('"state_json" is distinct from excluded.state_json');
              const changed =
                !condition || JSON.stringify(stored) !== JSON.stringify(values.stateJson);
              stored = values.stateJson;
              return changed ? [{ threadId: "thread" }] : [];
            });
            return Object.assign(result, { returning: () => result });
          },
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];
    const state: RelayAgentActivityState = {
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      projectTitle: "Project",
      threadTitle: "Thread",
      modelTitle: "Model",
      phase: "running",
      headline: "Working",
      updatedAt: "1970-01-01T00:00:00.000Z",
      deepLink: "/threads/env/thread",
    };
    return Effect.gen(function* () {
      const rows = yield* AgentActivityRows.AgentActivityRows;
      const input = { environmentPublicKey: "key", state };
      expect(yield* rows.upsert(input)).toBe(true);
      expect(yield* rows.upsert(input)).toBe(false);
      expect(
        yield* rows.upsert({ ...input, state: { ...state, phase: "completed", headline: "Done" } }),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        AgentActivityRows.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db))),
      ),
    );
  });
});

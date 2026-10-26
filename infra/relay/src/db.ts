import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Neon from "alchemy/Neon";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { relayDatabaseMode } from "./dbConfig.ts";

export class RelayDb extends Context.Service<
  RelayDb,
  EffectPgDatabase & {
    readonly $client: PgClient;
  }
>()("t3code-relay/db/RelayDb") {}

export class RelayTransactions extends Context.Service<
  RelayTransactions,
  {
    readonly withTransaction: RelayDb["Service"]["$client"]["withTransaction"];
  }
>()("t3code-relay/db/RelayTransactions") {
  static readonly layer = Layer.effect(
    RelayTransactions,
    Effect.gen(function* () {
      const db = yield* RelayDb;
      return RelayTransactions.of({
        withTransaction: db.$client.withTransaction,
      });
    }),
  );
}

export const NeonDatabase = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const schema = yield* Drizzle.Schema("RelaySchema", {
    schema: "./src/persistence/schema.ts",
    out: "./migrations/postgres",
    dialect: "postgres",
  });
  const project = { projectId: yield* Config.NonEmptyString("NEON_PROJECT_ID") };
  const migrations = { dir: schema.out, table: "relay_migrations" };

  // Prod owns the `relay` branch; other stages fork its schema so they never touch its data.
  return relayDatabaseMode(stage) === "shared-database"
    ? yield* Neon.Branch("RelayNeonBranch", {
        project,
        name: "relay",
        protected: true,
        migrations,
      }).pipe(RemovalPolicy.retain())
    : yield* Neon.Branch("RelayNeonStageBranch", {
        project,
        parentBranch: { name: "relay" },
        initSource: "schema-only",
        migrations,
      });
});

export const RelayHyperdrive = Effect.gen(function* () {
  const branch = yield* NeonDatabase;
  return yield* Cloudflare.Hyperdrive.Connection("RelayHyperdrive", {
    // The direct endpoint: Hyperdrive pools connections itself.
    origin: branch.origin,
    caching: {
      disabled: true,
    },
    // Neon's free compute accepts few connections; raise this with the compute size.
    originConnectionLimit: 10,
  });
});

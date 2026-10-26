import resultFixture from "./testkit/claudeSessionContract.fixture.json" with { type: "json" };
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSessionResult, EnvironmentId } from "@t3tools/contracts";
import { ClaudeJournalError } from "./ClaudeSessionJournal.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Ownership from "./ClaudeSessionOwnership.ts";

it.effect(
  "keeps one managed authority across two isolated databases sharing one synthetic store",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "claude-two-databases-owned-" });
      const fixture = yield* Schema.decodeUnknownEffect(ClaudeSessionResult)(resultFixture);
      if (fixture.view === null) return yield* Effect.die("Missing identity fixture.");
      const rootStat = yield* fs.stat(root);
      const plan = {
        ...fixture.view.plan,
        configDir: {
          kind: "unset" as const,
          effectiveRoot: {
            path: root,
            device: String(rootStat.dev),
            inode: String(Option.getOrThrow(rootStat.ino)),
          },
        },
      };
      const firstDatabase = path.join(root, "first.sqlite");
      const secondDatabase = path.join(root, "second.sqlite");
      const claim = (databasePath: string, environmentId = plan.environmentId) =>
        Effect.gen(function* () {
          const ownership = yield* Ownership.ClaudeSessionOwnership;
          return yield* ownership.claim(
            { ...plan, environmentId },
            "10000000-0000-4000-8000-000000000003",
          );
        }).pipe(
          Effect.provide(
            Ownership.layer(databasePath).pipe(Layer.provide(Sqlite.layerFromPath(databasePath))),
          ),
        );
      const owner = yield* claim(firstDatabase);
      assert.equal(owner.environmentId, plan.environmentId);
      const otherDatabase = yield* claim(
        secondDatabase,
        EnvironmentId.make("another-environment"),
      ).pipe(Effect.flip);
      if (!Schema.is(ClaudeJournalError)(otherDatabase)) return yield* Effect.die(otherDatabase);
      assert.equal(otherDatabase.code, "native-binding-owned");
      assert.deepEqual(yield* claim(firstDatabase), owner);
      const sameEnvironmentOtherDatabase = yield* claim(secondDatabase).pipe(Effect.flip);
      if (!Schema.is(ClaudeJournalError)(sameEnvironmentOtherDatabase))
        return yield* Effect.die(sameEnvironmentOtherDatabase);
      assert.equal(sameEnvironmentOtherDatabase.code, "native-binding-owned");
      assert.equal((yield* fs.readDirectory(path.join(root, ".t3-claude-authority"))).length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

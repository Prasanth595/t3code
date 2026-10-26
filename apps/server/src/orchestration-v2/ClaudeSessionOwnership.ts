// @effect-diagnostics nodeBuiltinImport:off -- private ownership records require exclusive no-follow creation, UID checks and directory fsync.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  ClaudeSessionFileIdentity,
  ClaudeSessionIdentityPlan,
  ClaudeSessionAdoptInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { ClaudeJournalError, claudePayloadHash } from "./ClaudeSessionJournal.ts";

const UUID = ClaudeSessionAdoptInput.fields.operationId;
const Authority = Schema.Struct({
  recordVersion: Schema.Literal(1),
  environmentId: ClaudeSessionIdentityPlan.fields.environmentId,
  projectId: ClaudeSessionIdentityPlan.fields.projectId,
  threadId: ClaudeSessionIdentityPlan.fields.threadId,
  nativeId: ClaudeSessionIdentityPlan.fields.nativeId,
  database: ClaudeSessionFileIdentity,
  databaseGeneration: UUID,
  bindingGeneration: UUID,
  initialOperationId: UUID,
  store: ClaudeSessionFileIdentity,
});
type Authority = typeof Authority.Type;
const decodeAuthority = Schema.decodeUnknownEffect(Schema.fromJsonString(Authority), {
  onExcessProperty: "error",
});
const encodeAuthority = Schema.encodeSync(Schema.fromJsonString(Authority));

export class ClaudeSessionOwnership extends Context.Service<
  ClaudeSessionOwnership,
  {
    readonly claim: (
      plan: ClaudeSessionIdentityPlan,
      operationId: string,
      existingGeneration?: string,
    ) => Effect.Effect<Authority, ClaudeJournalError>;
  }
>()("t3/orchestration-v2/ClaudeSessionOwnership") {}

export const layer = (databasePath: string) =>
  Layer.effect(
    ClaudeSessionOwnership,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const candidate = yield* randomUuidV4;
      const generations = yield* Effect.gen(function* () {
        yield* sql`INSERT OR IGNORE INTO orchestration_v2_claude_database_identity (singleton, generation) VALUES (1, ${candidate})`;
        return yield* sql<{
          generation: string;
        }>`SELECT generation FROM orchestration_v2_claude_database_identity WHERE singleton = 1`;
      }).pipe(sql.withTransaction, Effect.orDie);
      const databaseGeneration = generations[0]?.generation;
      if (databaseGeneration === undefined)
        return yield* Effect.die("Claude database identity unavailable.");
      const claim = Effect.fn("ClaudeSessionOwnership.claim")(function* (
        plan: ClaudeSessionIdentityPlan,
        operationId: string,
        existingGeneration?: string,
      ) {
        const bindingGeneration = yield* randomUuidV4;
        const expected = yield* Effect.tryPromise({
          try: async () => {
            const database = await NodeFSP.realpath(databasePath);
            const databaseStat = await NodeFSP.lstat(database, { bigint: true });
            const root = plan.configDir.effectiveRoot;
            const rootStat = await NodeFSP.lstat(root.path, { bigint: true });
            if (
              database !== databasePath ||
              !databaseStat.isFile() ||
              rootStat.isSymbolicLink() ||
              !rootStat.isDirectory() ||
              (await NodeFSP.realpath(root.path)) !== root.path ||
              String(rootStat.dev) !== root.device ||
              String(rootStat.ino) !== root.inode
            )
              throw new ClaudeJournalError({ code: "identity-changed" });
            return {
              recordVersion: 1 as const,
              environmentId: plan.environmentId,
              projectId: plan.projectId,
              threadId: plan.threadId,
              nativeId: plan.nativeId,
              database: {
                path: database,
                device: String(databaseStat.dev),
                inode: String(databaseStat.ino),
              },
              databaseGeneration,
              bindingGeneration,
              initialOperationId: operationId,
              store: root,
            };
          },
          catch: (cause) =>
            Schema.is(ClaudeJournalError)(cause)
              ? cause
              : new ClaudeJournalError({ code: "identity-unavailable", cause }),
        });
        const raw = yield* Effect.tryPromise({
          try: async () => {
            const directory = NodePath.join(expected.store.path, ".t3-claude-authority");
            await NodeFSP.mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
              if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
                throw error;
            });
            const stat = await NodeFSP.lstat(directory);
            if (
              !stat.isDirectory() ||
              stat.isSymbolicLink() ||
              stat.uid !== process.getuid?.() ||
              (stat.mode & 0o077) !== 0 ||
              (await NodeFSP.realpath(directory)) !== directory
            )
              throw new ClaudeJournalError({ code: "identity-unavailable" });
            const key = claudePayloadHash([
              expected.store.device,
              expected.store.inode,
              expected.nativeId,
            ]);
            const path = NodePath.join(directory, `${key}.json`);
            let created;
            try {
              created = await NodeFSP.open(
                path,
                NodeFS.constants.O_WRONLY |
                  NodeFS.constants.O_CREAT |
                  NodeFS.constants.O_EXCL |
                  NodeFS.constants.O_NOFOLLOW,
                0o600,
              );
            } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
                throw error;
            }
            if (created !== undefined) {
              try {
                await created.writeFile(encodeAuthority(expected));
                await created.sync();
              } finally {
                await created.close();
              }
              const parent = await NodeFSP.open(
                directory,
                NodeFS.constants.O_RDONLY |
                  NodeFS.constants.O_DIRECTORY |
                  NodeFS.constants.O_NOFOLLOW,
              );
              try {
                await parent.sync();
              } finally {
                await parent.close();
              }
            }
            const file = await NodeFSP.open(
              path,
              NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
            );
            try {
              const before = await file.stat();
              if (
                !before.isFile() ||
                before.nlink !== 1 ||
                before.uid !== process.getuid?.() ||
                (before.mode & 0o077) !== 0 ||
                before.size > 8192
              )
                throw new ClaudeJournalError({ code: "runtime-state-unknown" });
              const value = await file.readFile({ encoding: "utf8" });
              const after = await file.stat();
              const current = await NodeFSP.lstat(path);
              if (
                before.dev !== current.dev ||
                before.ino !== current.ino ||
                before.size !== after.size ||
                before.mtimeMs !== after.mtimeMs ||
                before.ctimeMs !== after.ctimeMs
              )
                throw new ClaudeJournalError({ code: "runtime-state-unknown" });
              return value;
            } finally {
              await file.close();
            }
          },
          catch: (cause) =>
            Schema.is(ClaudeJournalError)(cause)
              ? cause
              : new ClaudeJournalError({ code: "runtime-state-unknown", cause }),
        });
        const previous = yield* decodeAuthority(raw).pipe(
          Effect.mapError(
            (cause) => new ClaudeJournalError({ code: "runtime-state-unknown", cause }),
          ),
        );
        if (
          previous.environmentId !== expected.environmentId ||
          previous.projectId !== expected.projectId ||
          previous.threadId !== expected.threadId ||
          previous.nativeId !== expected.nativeId ||
          previous.databaseGeneration !== expected.databaseGeneration ||
          claudePayloadHash(previous.database) !== claudePayloadHash(expected.database) ||
          previous.store.device !== expected.store.device ||
          previous.store.inode !== expected.store.inode ||
          (previous.bindingGeneration !== existingGeneration &&
            previous.initialOperationId !== operationId)
        )
          return yield* new ClaudeJournalError({ code: "native-binding-owned" });
        return previous;
      });
      return ClaudeSessionOwnership.of({ claim });
    }),
  );

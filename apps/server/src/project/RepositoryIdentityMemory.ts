import { RepositoryIdentity } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The repository identity each workspace root last resolved to. Enrichment reads it back when
 * the folder is gone, so a project whose worktree was removed stays grouped with its repository
 * instead of degrading to a path group. Both operations swallow their own failures: memory is a
 * convenience, and losing it must never fail the resolution it decorates.
 */
export class RepositoryIdentityMemory extends Context.Service<
  RepositoryIdentityMemory,
  {
    readonly remember: (workspaceRoot: string, identity: RepositoryIdentity) => Effect.Effect<void>;
    readonly recall: (workspaceRoot: string) => Effect.Effect<Option.Option<RepositoryIdentity>>;
  }
>()("t3/project/RepositoryIdentityMemory") {}

export const layerInMemory = Layer.effect(
  RepositoryIdentityMemory,
  Effect.gen(function* () {
    const memory = yield* Ref.make(new Map<string, RepositoryIdentity>());
    return RepositoryIdentityMemory.of({
      remember: (workspaceRoot, identity) =>
        Ref.update(memory, (current) => new Map(current).set(workspaceRoot, identity)),
      recall: (workspaceRoot) =>
        Ref.get(memory).pipe(
          Effect.map((current) => Option.fromUndefinedOr(current.get(workspaceRoot))),
        ),
    });
  }),
);

const RepositoryIdentityJson = Schema.fromJsonString(RepositoryIdentity);
const encodeIdentity = Schema.encodeEffect(RepositoryIdentityJson);
const decodeIdentity = Schema.decodeUnknownEffect(RepositoryIdentityJson);

/**
 * Stores the identity on the active `projection_projects` rows for the root, so it dies with
 * the project and ProjectStore clears it when the project moves to another folder.
 */
export const layerSql = Layer.effect(
  RepositoryIdentityMemory,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const swallow =
      <A>(operation: string, fallback: A) =>
      <E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Repository identity memory failed", { operation, cause }).pipe(
              Effect.as(fallback),
            ),
          ),
        );

    return RepositoryIdentityMemory.of({
      remember: (workspaceRoot, identity) =>
        encodeIdentity(identity).pipe(
          Effect.flatMap(
            (json) => sql`
              UPDATE projection_projects
              SET repository_identity_json = ${json}
              WHERE workspace_root = ${workspaceRoot} AND deleted_at IS NULL
            `,
          ),
          Effect.asVoid,
          swallow<void>("remember", undefined),
        ),
      recall: (workspaceRoot) =>
        sql<{ readonly identity: string | null }>`
          SELECT repository_identity_json AS identity
          FROM projection_projects
          WHERE workspace_root = ${workspaceRoot}
            AND deleted_at IS NULL
            AND repository_identity_json IS NOT NULL
          LIMIT 1
        `.pipe(
          Effect.flatMap((rows) =>
            rows[0]?.identity == null
              ? Effect.succeedNone
              : decodeIdentity(rows[0].identity).pipe(Effect.map(Option.some)),
          ),
          swallow("recall", Option.none<RepositoryIdentity>()),
        ),
    });
  }),
);

import type { RepositoryIdentity } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

/**
 * The repository identity each workspace root last resolved to. Enrichment reads it back when
 * the folder is gone, so a project whose worktree was removed stays grouped with its repository
 * instead of degrading to a path group. Both operations swallow their own failures: memory is a
 * convenience, and losing it must never fail the resolution it decorates. The durable layer lives
 * in `orchestration-v2/ProjectStore.ts`, which owns the row it writes.
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

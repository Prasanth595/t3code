import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

// Shell commands that move HEAD or the index. Reads, fetches, and pushes leave the checkout alone.
const CHECKOUT_COMMAND =
  /\bgit\s+(?:commit|merge|rebase|reset|checkout|switch|pull|cherry-pick|revert|stash|am|restore)\b/u;

/**
 * Re-reads local status when an agent's git command finishes, so clients see a commit land while
 * the run continues instead of when it ends.
 */
export class CheckoutCommandReactor extends Context.Service<
  CheckoutCommandReactor,
  { readonly start: () => Effect.Effect<void, never, Scope.Scope> }
>()("t3/orchestration-v2/CheckoutCommandReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

  const refresh = (threadId: ThreadId) =>
    projections.getCheckpointContext(threadId).pipe(
      Effect.flatMap((context) =>
        Effect.forEach(
          new Set(context.checkpointScopes.map((scope) => scope.cwd)),
          (cwd) => vcsStatus.refreshLocalStatus(cwd),
          { discard: true },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logDebug("checkout refresh after a git command skipped", { threadId, cause }),
      ),
    );

  const start = Effect.fn("CheckoutCommandReactor.start")(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        event.type === "turn-item.updated" &&
        event.payload.type === "command_execution" &&
        event.payload.status === "completed" &&
        CHECKOUT_COMMAND.test(event.payload.input)
          ? refresh(event.threadId)
          : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("checkout command event stream failed", { cause }),
        ),
      ),
    );
  });

  return CheckoutCommandReactor.of({ start });
});

export const layer = Layer.effect(CheckoutCommandReactor, make);

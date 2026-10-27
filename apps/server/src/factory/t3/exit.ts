import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { exitProcess } from "./exitProcess.ts";

/**
 * The restart behind `POST /api/factory/restart` (`http.ts`): `request` begins it once and
 * answers `pending` to every later call, because this process is on its way out. `make` takes
 * the exit that ends the process, so the route's tests count calls instead of exiting vitest.
 */
export class ServerExit extends Context.Service<
  ServerExit,
  { readonly request: Effect.Effect<"started" | "pending"> }
>()("t3/factory/t3/exit/ServerExit") {}

/**
 * How long the 202 gets to leave the socket before the shutdown starts. Written before the
 * process begins to close, so the caller always receives the response; the restart itself takes
 * launchd about 10 seconds either way.
 */
const RESTART_GRACE = "500 millis";

/**
 * The first `request` forks a detached fiber that waits out the grace, logs the line that tells a
 * requested restart from a crash in the launchd log, and runs `exit`; it answers `started` at
 * once, so the handler's response leaves before the process begins to close.
 */
export const make = (
  exit: Effect.Effect<void>,
  grace: Duration.Input = RESTART_GRACE,
): ServerExit["Service"] => {
  const pending = Ref.makeUnsafe(false);
  return {
    request: Effect.gen(function* () {
      if (yield* Ref.getAndSet(pending, true)) return "pending";
      yield* Effect.forkDetach(
        Effect.sleep(grace).pipe(
          Effect.andThen(Effect.logInfo("factory restart requested")),
          Effect.andThen(exit),
        ),
      );
      return "started";
    }),
  };
};

export const layer = Layer.sync(ServerExit, () => make(Effect.sync(() => exitProcess())));

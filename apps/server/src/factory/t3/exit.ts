import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * How the restart route (`http.ts`) ends the process, as a service so the route's tests count the
 * calls instead of exiting vitest. `layer` is the real exit; FactoryLayer (`../index.ts`) provides
 * it to the routes.
 */
export class ServerExit extends Context.Service<
  ServerExit,
  { readonly exit: Effect.Effect<void> }
>()("t3/factory/t3/exit/ServerExit") {}

/** How long the normal shutdown gets before `process.exit(0)` ends the process regardless. */
export const EXIT_FALLBACK_MS = 10_000;

/**
 * Ends the process the way `t3 serve` already handles a stop: SIGTERM to itself, which
 * `NodeRuntime.runMain` turns into an interrupt of the main fiber, so the server closes its scope
 * (listeners, provider children, a running gate) as it does for `launchctl stop`. runMain's
 * teardown then exits 130 for an interrupt; the `exit` listener makes that 0, because a requested
 * restart is a clean exit to launchd (which restarts on any code) and to a shell alike. A shutdown
 * that hangs is cut short by `process.exit(0)` after `fallbackMs`; the timer is unref'd so it never
 * keeps a finished process alive.
 */
export const exitProcess = (fallbackMs = EXIT_FALLBACK_MS): void => {
  process.once("exit", () => {
    process.exitCode = 0;
  });
  // @effect-diagnostics-next-line globalTimers:off - must fire while the Effect runtime is shutting down or stuck.
  setTimeout(() => process.exit(0), fallbackMs).unref();
  process.kill(process.pid, "SIGTERM");
};

export const layer = Layer.succeed(
  ServerExit,
  ServerExit.of({ exit: Effect.sync(() => exitProcess()) }),
);

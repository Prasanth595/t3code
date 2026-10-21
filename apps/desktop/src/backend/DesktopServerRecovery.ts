import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopServerOwnership from "./DesktopServerOwnership.ts";

const { logInfo: logRecoveryInfo, logWarning: logRecoveryWarning } =
  DesktopObservability.makeComponentLogger("desktop-server-recovery");

const RECOVERY_SIGTERM_GRACE = Duration.seconds(5);
const RECOVERY_POLL_INTERVAL = Duration.millis(100);
const RECOVERY_KILL_TIMEOUT = Duration.seconds(5);

/**
 * Signal a pid, reporting whether the signal was delivered. A process that
 * is already gone is not an error: that is the outcome we wanted.
 */
const signalPid = (pid: number, signal: NodeJS.Signals): Effect.Effect<boolean> =>
  Effect.sync(() => {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  });

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/**
 * Wait for a pid to disappear, bounded by a timeout. Returns true when the
 * process is gone.
 */
const waitForExit = (pid: number, timeout: Duration.Duration): Effect.Effect<boolean> =>
  Effect.sync(() => isProcessAlive(pid)).pipe(
    Effect.repeat({
      while: (alive) => alive,
      schedule: Schedule.spaced(RECOVERY_POLL_INTERVAL),
    }),
    // The last value is the process's liveness at the moment the wait ended:
    // false means it exited, and a timeout means it is still running.
    Effect.timeoutOption(timeout),
    Effect.map((result) => Option.isSome(result) && !result.value),
  );

/**
 * Recover a stranded server that this desktop app started.
 *
 * The server holds the T3 home's ownership lock for its lifetime, so a
 * leftover from a previous desktop run blocks every later start. It is
 * stopped the same way the desktop stops its own backend: SIGTERM first, so
 * the server can shut down cleanly and release the lock, then SIGKILL if it
 * does not go away.
 *
 * Only a server the desktop has verified as its own stranded leftover is
 * stopped here. A healthy server and a server the desktop cannot prove it
 * started are left alone.
 */
export const recoverStrandedServer = Effect.fn("desktop.serverRecovery.recoverStrandedServer")(
  function* (input: {
    readonly owner: Extract<
      DesktopServerOwnership.DesktopServerOwner,
      { readonly _tag: "stranded" }
    >;
  }): Effect.fn.Return<boolean> {
    const pid = input.owner.record.pid;

    yield* logRecoveryInfo("stopping a stranded server that owns this T3 home", {
      pid,
      port: input.owner.record.port,
    });

    yield* signalPid(pid, "SIGTERM");
    const exited = yield* waitForExit(pid, RECOVERY_SIGTERM_GRACE);
    if (exited) {
      yield* logRecoveryInfo("the stranded server stopped and released the T3 home", { pid });
      return true;
    }

    // It ignored SIGTERM. The lock is only released when the process is
    // gone, so the escalation is what makes the home usable again.
    yield* logRecoveryWarning("the stranded server ignored SIGTERM; escalating to SIGKILL", {
      pid,
    });
    yield* signalPid(pid, "SIGKILL");
    const killed = yield* waitForExit(pid, RECOVERY_KILL_TIMEOUT);
    if (killed) {
      yield* logRecoveryInfo("the stranded server was killed and released the T3 home", { pid });
      return true;
    }

    yield* logRecoveryWarning("the stranded server could not be stopped", { pid });
    return false;
  },
);

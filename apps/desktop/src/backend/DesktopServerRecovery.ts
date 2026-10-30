import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopProcessTree from "./DesktopProcessTree.ts";
import * as DesktopServerOwnership from "./DesktopServerOwnership.ts";

const { logInfo: logRecoveryInfo, logWarning: logRecoveryWarning } =
  DesktopObservability.makeComponentLogger("desktop-server-recovery");

const RECOVERY_SIGTERM_GRACE = Duration.seconds(5);
const RECOVERY_POLL_INTERVAL = Duration.millis(100);
const RECOVERY_KILL_TIMEOUT = Duration.seconds(5);

/**
 * Recover a server this desktop started that still holds the home's lock but
 * no longer answers: SIGTERM so it releases the lock, SIGKILL if it does not.
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

    yield* DesktopProcessTree.signalProcessTree(pid, "SIGTERM");
    const exited = yield* DesktopProcessTree.waitForProcessTreeExit(
      pid,
      RECOVERY_SIGTERM_GRACE,
      RECOVERY_POLL_INTERVAL,
    );
    if (exited) {
      yield* logRecoveryInfo("the stranded server stopped and released the T3 home", { pid });
      return true;
    }

    // It ignored SIGTERM. The lock is only released when the process is
    // gone, so the escalation is what makes the home usable again.
    yield* logRecoveryWarning("the stranded server ignored SIGTERM; escalating to SIGKILL", {
      pid,
    });
    yield* DesktopProcessTree.signalProcessTree(pid, "SIGKILL");
    const killed = yield* DesktopProcessTree.waitForProcessTreeExit(
      pid,
      RECOVERY_KILL_TIMEOUT,
      RECOVERY_POLL_INTERVAL,
    );
    if (killed) {
      yield* logRecoveryInfo("the stranded server was killed and released the T3 home", { pid });
      return true;
    }

    yield* logRecoveryWarning("the stranded server could not be stopped", { pid });
    return false;
  },
);

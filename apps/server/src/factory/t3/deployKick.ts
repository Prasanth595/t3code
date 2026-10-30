// @effect-diagnostics nodeBuiltinImport:off - one launchctl call with a timeout, which execFile gives directly.
import * as NodeChildProcess from "node:child_process";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The autodeploy LaunchAgent's label, `job=` in factory/scripts/autodeploy.sh. */
const AUTODEPLOY_JOB = "io.github.rawphp.t3fac.autodeploy";

/**
 * Starts an autodeploy tick now, for `POST /api/factory/deploy/now` (`http.ts`). `kick` answers
 * whether launchd took the request; false on a dev server or a machine without the LaunchAgent,
 * where the next scheduled tick picks the request up. The route's tests inject one that never
 * calls launchctl.
 */
export class DeployKick extends Context.Service<
  DeployKick,
  { readonly kick: Effect.Effect<boolean> }
>()("t3/factory/t3/deployKick/DeployKick") {}

/**
 * `launchctl kickstart` without `-k`, so a tick that is already running is not killed. The server
 * runs as the user the job belongs to.
 */
const kickstart = Effect.callback<boolean>((resume) => {
  const uid = process.getuid?.();
  if (uid === undefined) {
    resume(Effect.succeed(false));
    return;
  }
  NodeChildProcess.execFile(
    "launchctl",
    ["kickstart", `gui/${uid}/${AUTODEPLOY_JOB}`],
    { timeout: 10_000 },
    (error) => resume(Effect.succeed(error === null)),
  );
});

export const layer = Layer.succeed(DeployKick, { kick: kickstart });

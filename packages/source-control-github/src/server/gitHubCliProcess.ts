import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

/**
 * Runs `gh` without letting it autolaunch a D-Bus session bus.
 *
 * gh reads its keyring through godbus. With no bus address and no bus under `/run/user/<uid>`,
 * godbus runs `dbus-launch`, whose daemon outlives gh. On hosts without a user session (WSL,
 * headless servers) every keyring read then leaks a daemon until inotify instances run out.
 * Only in that case, turn the bus off so the keyring read fails instead; a configured or
 * discoverable bus is left alone, matching godbus's own lookup.
 */
export const makeGhProcess = Effect.gen(function* () {
  const { process } = yield* SourceControlHost.SourceControlHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const userId = yield* HostProcess.UserId;

  const busMissing = Effect.gen(function* () {
    const address = environment.DBUS_SESSION_BUS_ADDRESS?.trim();
    if (platform === "darwin" || userId === undefined) return false;
    if (address && address !== "autolaunch:") return false;
    const found = yield* Effect.forEach(["bus", "dbus-session"], (name) =>
      fileSystem.exists(`/run/user/${userId}/${name}`).pipe(Effect.orElseSucceed(() => true)),
    );
    return !found.some(Boolean);
  });

  return {
    run: (input) =>
      busMissing.pipe(
        Effect.flatMap((missing) =>
          process.run(
            missing
              ? { ...input, env: { ...input.env, DBUS_SESSION_BUS_ADDRESS: "disabled:" } }
              : input,
          ),
        ),
      ),
  } satisfies SourceControlHost.SourceControlHost["Service"]["process"];
});

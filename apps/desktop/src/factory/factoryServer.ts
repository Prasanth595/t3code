// The packaged fork desktop app is a window onto the factory's LaunchAgent server
// (FORK_FACTORY_SERVER_URL) and starts no backend of its own. Upstream files call into
// this module through small hooks; see factory/AGENTS.md.
import { PRIMARY_LOCAL_ENVIRONMENT_ID, type DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { FORK_FACTORY_SERVER_URL } from "@t3tools/shared/forkIdentity";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as DesktopAppActivation from "../app/DesktopAppActivation.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const { logInfo, logWarning } = makeComponentLogger("desktop-factory-server");

/** Only packaged builds use the factory server; dev builds keep upstream's backend. */
export const usesFactoryServer = (environment: { readonly isPackaged: boolean }): boolean =>
  environment.isPackaged;

/** The one primary entry the web UI reads its environment URL from. */
export const factoryServerBootstraps = (): DesktopEnvironmentBootstrap[] => {
  const httpBaseUrl = new URL(FORK_FACTORY_SERVER_URL);
  const wsBaseUrl = new URL(httpBaseUrl.href);
  wsBaseUrl.protocol = wsBaseUrl.protocol === "https:" ? "wss:" : "ws:";
  return [
    {
      id: PRIMARY_LOCAL_ENVIRONMENT_ID,
      label: "Factory server",
      runningDistro: null,
      httpBaseUrl: httpBaseUrl.href,
      wsBaseUrl: wsBaseUrl.href,
    },
  ];
};

/**
 * `null` when upstream's bootstraps apply. Reads the environment as an optional service so
 * upstream's handler tests, which provide none, keep working unchanged.
 */
export const factoryServerBootstrapsWhenPackaged = Effect.gen(function* () {
  const environment = yield* Effect.serviceOption(DesktopEnvironment.DesktopEnvironment);
  return Option.isSome(environment) && usesFactoryServer(environment.value)
    ? factoryServerBootstraps()
    : null;
});

/**
 * Called in place of upstream's backend start. Returns false when upstream's bootstrap should
 * carry on. The window opens at once instead of waiting for a probe: the web UI shows its own
 * pairing, error and reconnecting states, and the connecting splash would say WSL.
 */
export const openOnFactoryServer = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (!usesFactoryServer(environment)) return false;

  const state = yield* DesktopState.DesktopState;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const appActivation = yield* DesktopAppActivation.DesktopAppActivation;
  yield* logInfo("skipping the bundled backend; using the factory server", {
    url: FORK_FACTORY_SERVER_URL,
  });
  if (!(yield* Ref.get(state.quitting))) {
    yield* desktopWindow
      .handleBackendReady(new URL(FORK_FACTORY_SERVER_URL))
      .pipe(
        Effect.catch((error) =>
          logWarning("failed to open main window on the factory server", { error: error.message }),
        ),
      );
    yield* appActivation.start.pipe(
      Effect.catch((error) =>
        logWarning("desktop app control socket unavailable", { error: error.message }),
      ),
    );
  }
  return true;
});

/**
 * True for the bundled backend (the primary instance) of a packaged fork build. Checked at the
 * instance's own `start`, so no caller (bootstrap, failed-update recovery, anything later) can
 * start it. Reads the environment as an optional service so upstream's manager tests, which
 * provide none, keep starting the primary.
 */
export const skipsBundledBackend = (id: string) =>
  Effect.gen(function* () {
    if (id !== PRIMARY_LOCAL_ENVIRONMENT_ID) return false;
    const environment = yield* Effect.serviceOption(DesktopEnvironment.DesktopEnvironment);
    return Option.isSome(environment) && usesFactoryServer(environment.value);
  });

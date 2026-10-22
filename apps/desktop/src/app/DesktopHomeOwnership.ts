import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";

import type { DesktopWindowError } from "../window/DesktopWindow.ts";
import * as DesktopServerOwnership from "../backend/DesktopServerOwnership.ts";

/**
 * A server that already owns the T3 home the desktop wants to use.
 */
export type DesktopHomeOwner = Extract<
  DesktopServerOwnership.DesktopServerOwner,
  { readonly _tag: "healthy" | "foreign" }
>;

/**
 * Open the desktop for a T3 home that another server already owns.
 *
 * The desktop does not start a second writer for a home that already has one.
 * It stays open: the way out of this state lives in Settings, and quitting
 * would leave the user unable to reach it, because the next launch would
 * find the same owner and stop again.
 */
export const openDesktopWithExistingOwner = Effect.fn(
  "desktop.homeOwnership.openDesktopWithExistingOwner",
)(function* (input: {
  readonly owner: DesktopHomeOwner;
  readonly showErrorBox: (title: string, content: string) => Effect.Effect<void>;
  readonly openMainWindow: Effect.Effect<unknown, DesktopWindowError>;
  /**
   * Starts the control socket the desktop exposes to `t3 app`. The app is
   * open, so the socket has to be listening too. Failures are the caller's
   * to report.
   */
  readonly startControlSocket: Effect.Effect<void, never, Scope.Scope>;
  readonly isQuitting: Effect.Effect<boolean>;
}): Effect.fn.Return<void, DesktopWindowError, Scope.Scope> {
  const quitting = yield* input.isQuitting;
  if (!quitting) {
    yield* input.startControlSocket;
  }
  const responding = input.owner._tag === "healthy";
  yield* input.showErrorBox(
    "This T3 home is already in use",
    responding
      ? `A T3 Code server is already running for this T3 home (${input.owner.record.origin}). The desktop did not start a second server for the same home, so it cannot open the local environment.\n\nTo use that server, turn off Settings > Connections > Local environment and add it as a saved environment. To let the desktop run its own server instead, stop that server and reopen T3 Code.`
      : `Another T3 Code server owns this T3 home and is not responding (${input.owner.record.origin}). The desktop did not start a second server for the same home.\n\nStop that server and reopen T3 Code, or turn off Settings > Connections > Local environment and add a running server as a saved environment.`,
  );
  if (quitting) {
    return;
  }
  yield* input.openMainWindow;
});

import * as Effect from "effect/Effect";

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
 * Report a server that already owns the T3 home.
 *
 * The desktop does not start a second writer for a home that already has one.
 * The app stays open: the way out of this state lives in Settings, and
 * quitting would leave the user unable to reach it, because the next launch
 * would find the same owner and stop again.
 */
export const reportHomeOwnedByAnotherServer = Effect.fn(
  "desktop.homeOwnership.reportHomeOwnedByAnotherServer",
)(function* (input: {
  readonly owner: DesktopHomeOwner;
  readonly showErrorBox: (title: string, content: string) => Effect.Effect<void>;
  readonly openMainWindow: Effect.Effect<unknown, DesktopWindowError>;
  readonly isQuitting: Effect.Effect<boolean>;
}): Effect.fn.Return<void, DesktopWindowError> {
  const responding = input.owner._tag === "healthy";
  yield* input.showErrorBox(
    "This T3 home is already in use",
    responding
      ? `A T3 Code server is already running for this T3 home (${input.owner.record.origin}). The desktop did not start a second server for the same home, so it cannot open the local environment.\n\nTo use that server, turn off Settings > Connections > Local environment and add it as a saved environment. To let the desktop run its own server instead, stop that server and reopen T3 Code.`
      : `Another T3 Code server owns this T3 home and is not responding (${input.owner.record.origin}). The desktop did not start a second server for the same home.\n\nStop that server and reopen T3 Code, or turn off Settings > Connections > Local environment and add a running server as a saved environment.`,
  );
  if (yield* input.isQuitting) {
    return;
  }
  yield* input.openMainWindow;
});

import { MessageChannelMain } from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PREVIEW_PREPARE_CAPTURE_CHANNEL } from "../ipc/channels.ts";

class GuestCapturePreparationError extends Schema.TaggedError<GuestCapturePreparationError>()(
  "GuestCapturePreparationError",
  { message: Schema.String, cause: Schema.optional(Schema.Unknown) },
) {}

/** Off-window guests stop compositing even with background throttling disabled. */
export const prepareGuestCapture = Effect.fn("Preview.prepareGuestCapture")(function* (
  guest: Electron.WebContents,
  tabId: string,
) {
  const { port1, port2 } = new MessageChannelMain();
  const release = () => {
    port1.postMessage("release");
    port1.close();
  };
  yield* Effect.callback<void, GuestCapturePreparationError>((resume) => {
    port1.on("message", ({ data }) => {
      resume(
        data === "ready"
          ? Effect.void
          : Effect.fail(
              new GuestCapturePreparationError({
                message: "The preview guest is no longer mounted.",
              }),
            ),
      );
    });
    port1.start();
    try {
      if (!guest.hostWebContents || guest.hostWebContents.isDestroyed()) {
        resume(
          Effect.fail(
            new GuestCapturePreparationError({
              message: "The preview window is no longer available.",
            }),
          ),
        );
      } else {
        guest.hostWebContents.postMessage(PREVIEW_PREPARE_CAPTURE_CHANNEL, tabId, [port2]);
      }
    } catch (cause) {
      resume(
        Effect.fail(
          new GuestCapturePreparationError({
            message: "Could not prepare the preview for capture.",
            cause,
          }),
        ),
      );
    }
  }).pipe(
    Effect.timeout(2_000),
    Effect.onError(() => Effect.sync(release)),
  );
  return release;
});

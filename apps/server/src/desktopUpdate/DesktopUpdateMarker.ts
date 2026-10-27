import { DESKTOP_UPDATE_IN_PROGRESS_TTL_MS } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const UpdateMarker = Schema.fromJsonString(
  Schema.Struct({ startedAt: Schema.optional(Schema.Unknown), expiresAt: Schema.Number }),
);

export class DesktopUpdateMarker extends Context.Service<
  DesktopUpdateMarker,
  {
    /** Remaining SSH launch wait in ms, capped at this build's TTL; removes expired markers. */
    readonly remainingWait: (markerFile: string) => Effect.Effect<Option.Option<number>>;
  }
>()("t3/desktopUpdate/DesktopUpdateMarker") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;

  const remainingWait: DesktopUpdateMarker["Service"]["remainingWait"] = Effect.fn(
    "DesktopUpdateMarker.remainingWait",
  )(function* (markerFile) {
    const now = yield* Clock.currentTimeMillis;
    const marker = yield* fileSystem
      .readFileString(markerFile)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(UpdateMarker)), Effect.option);
    if (Option.isSome(marker)) {
      const { startedAt, expiresAt } = marker.value;
      if (Number.isFinite(expiresAt) && expiresAt <= now) {
        yield* fileSystem.remove(markerFile, { force: true }).pipe(Effect.ignore);
      } else if (
        typeof startedAt === "number" &&
        Number.isFinite(startedAt) &&
        Number.isFinite(expiresAt) &&
        startedAt <= now &&
        expiresAt > now &&
        expiresAt > startedAt
      ) {
        return Option.some(Math.min(expiresAt - now, DESKTOP_UPDATE_IN_PROGRESS_TTL_MS));
      }
    }
    return Option.none();
  });

  return DesktopUpdateMarker.of({ remainingWait });
});

export const layer = Layer.effect(DesktopUpdateMarker, make);

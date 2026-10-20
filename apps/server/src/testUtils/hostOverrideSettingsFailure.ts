import { ServerSettingsError } from "@t3tools/contracts";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import * as ServerSettings from "../serverSettings.ts";

export const withHostOverrideSettingsFailure = <A, E, R>(
  use: (
    settings: ServerSettings.ServerSettingsService["Service"],
    warnings: string[],
  ) => Effect.Effect<A, E, R>,
) => {
  const warnings: string[] = [];
  const logger = Logger.make<unknown, void>(({ message, logLevel }) => {
    if (
      logLevel === "Warn" &&
      String(message).includes("Failed to read source-control host mappings")
    )
      warnings.push(String(message));
  });
  return Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const result = yield* use(
      {
        ...settings,
        getSettings: Effect.fail(
          new ServerSettingsError({
            settingsPath: "/test/settings.json",
            operation: "read-secret",
          }),
        ),
      },
      warnings,
    );
    assert.isAbove(warnings.length, 0);
    assert.isTrue(warnings.every((message) => message.includes("using hostname heuristics")));
    return result;
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layerTest(),
        Logger.layer([logger], { mergeWithExisting: false }),
      ),
    ),
  );
};

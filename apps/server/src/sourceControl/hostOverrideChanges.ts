import { sourceControlHostOverridesKey } from "@t3tools/shared/sourceControl";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { readHostOverrides } from "@t3tools/source-control-core/server/SourceControlHost";
import * as ServerSettings from "../serverSettings.ts";

export const subscribeHostOverrideChanges = Effect.fnUntraced(function* (
  invalidate: Effect.Effect<void>,
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  // Subscribe before reading the snapshot so writes during construction are queued.
  const changes = yield* settings.subscribeChanges;
  let previous = sourceControlHostOverridesKey(yield* readHostOverrides(settings.getSettings));
  yield* Stream.runForEach(changes, (value) =>
    Effect.suspend(() => {
      const next = sourceControlHostOverridesKey(value.sourceControlHostOverrides);
      if (previous === next) return Effect.void;
      previous = next;
      return invalidate;
    }),
  ).pipe(Effect.forkScoped);
});

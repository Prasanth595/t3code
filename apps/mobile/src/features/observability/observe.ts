import Constants from "expo-constants";
import { Observe } from "expo-observe";

// Importing expo-observe installs its global JS error handler; reports leave only through the relay.
const relayUrl: unknown = Constants.expoConfig?.extra?.relay?.url;
const appVariant: unknown = Constants.expoConfig?.extra?.appVariant;

export const crashReportingAvailable = typeof relayUrl === "string" && relayUrl.trim() !== "";

let latestConfiguration = 0;

/**
 * While sending is off, each dispatch pass drops what it finds. A report recorded after the
 * last pass would still go out once sending resumes, so a pass runs before turning it back on.
 */
export async function setCrashReportsEnabled(enabled: boolean) {
  const configuration = ++latestConfiguration;
  const dispatchingEnabled = crashReportingAvailable && enabled;
  if (dispatchingEnabled) {
    await Observe.dispatchEvents();
    if (configuration !== latestConfiguration) return;
  }
  Observe.configure({
    dispatchingEnabled,
    ...(typeof appVariant === "string" ? { environment: appVariant } : {}),
  });
}

if (!crashReportingAvailable) {
  void setCrashReportsEnabled(false);
} else {
  // Observe keeps its last configuration across launches; configuring it off while the setting
  // loads would drop the last session's native crash. Imported lazily so the persistence graph
  // never runs ahead of the imports `index.ts` orders first.
  const changedSinceLoad = () => latestConfiguration !== 0;
  void import("../../persistence/imperative")
    .then(({ loadPreferences }) => loadPreferences())
    .then(
      (preferences) =>
        changedSinceLoad()
          ? undefined
          : setCrashReportsEnabled(preferences.crashReportsEnabled !== false),
      (error: unknown) => {
        console.warn("[observe] could not read the crash report setting", error);
        return changedSinceLoad() ? undefined : setCrashReportsEnabled(false);
      },
    )
    .catch((error: unknown) => {
      console.warn("[observe] could not apply the crash report setting", error);
    });
}

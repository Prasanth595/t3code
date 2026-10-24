import type { NavigationState } from "@react-navigation/native";
import * as Linking from "expo-linking";
import { Dimensions, Platform } from "react-native";

import { deriveLayout } from "../../lib/layout";
import { loadPreferences, savePreferencesPatch } from "../../persistence/imperative";
import type { WorkspaceSelections } from "../../persistence/mobile-preferences";
import { workspaceSelectionsIn } from "./workspace-tab-navigation";

// Read synchronously when a tab opens, so it lives in memory and is saved as it changes.
let selections: WorkspaceSelections = {};
let hydration: Promise<void> | null = null;

/** Loads the saved selections once; pages visited before it resolves win over saved ones. */
export function hydrateWorkspaceSelections() {
  hydration ??= loadPreferences()
    .then((preferences) => {
      selections = { ...preferences.workspaceSelections, ...selections };
    })
    .catch(() => undefined);
  return hydration;
}

export function currentWorkspaceSelections() {
  return selections;
}

/** The navigation container's `onStateChange`: remembers the page each tab is showing. */
export function recordWorkspaceSelections(state: NavigationState | undefined) {
  if (!state) return;
  const next = workspaceSelectionsIn(state.routes.slice(0, state.index + 1), selections);
  if (next === selections) return;
  selections = next;
  void savePreferencesPatch({ workspaceSelections: next }).catch(() => undefined);
}

/**
 * Where a cold start without a link opens. A window that starts with columns reopens the last
 * chat beside the list instead of an empty detail column; a compact window opens on the list.
 */
export async function launchWorkspaceURL(): Promise<string | null> {
  if (Platform.OS !== "ios") return null;
  await hydrateWorkspaceSelections();
  const thread = selections.threads;
  const { width, height } = Dimensions.get("window");
  if (!thread || !deriveLayout({ width, height, nativeWorkspace: true }).usesSplitView) return null;
  return Linking.createURL(
    `threads/${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.threadId)}`,
  );
}

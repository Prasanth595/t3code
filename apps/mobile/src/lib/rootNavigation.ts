import {
  createNavigationContainerRef,
  type NavigationContainerRef,
} from "@react-navigation/native";

/**
 * The app's single navigation container. Work that outlives a screen (a draft
 * route's branch checkout, notification taps, quick actions, Connect
 * onboarding) navigates through it instead of mounting hooks in the navigator.
 */
export const rootNavigationRef = createNavigationContainerRef<ReactNavigation.RootParamList>();

/**
 * Ref callback for the container. Android activity replacement mounts the new
 * root before the old one unmounts, so the old container must not clear the
 * ref the new one already owns.
 */
export function attachRootNavigation(
  navigation: NavigationContainerRef<ReactNavigation.RootParamList> | null,
): () => void {
  rootNavigationRef.current = navigation;
  return () => {
    if (rootNavigationRef.current === navigation) rootNavigationRef.current = null;
  };
}

const pendingUntilReady: Array<() => void> = [];

/** Runs `navigate` now if the container is ready, otherwise once it becomes ready. */
export function whenRootNavigationReady(navigate: () => void): void {
  if (rootNavigationRef.isReady()) {
    navigate();
    return;
  }
  pendingUntilReady.push(navigate);
}

/** Wired to the container's `onReady`. */
export function flushRootNavigationQueue(): void {
  for (const navigate of pendingUntilReady.splice(0)) {
    try {
      navigate();
    } catch (error) {
      console.error("[navigation] queued navigation failed", error);
    }
  }
}

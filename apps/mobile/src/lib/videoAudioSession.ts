import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

const nativeControls = requireOptionalNativeModule<{
  releaseVideoAudioSession(): Promise<void>;
}>("T3NativeControls");

// Lets a player that starts right after another stops keep the session.
const RELEASE_DELAY_MS = 100;

let playingCount = 0;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

/** Pairs with `videoPlaybackStopped` for each inline player that is playing. */
export function videoPlaybackStarted(): void {
  playingCount += 1;
}

/**
 * expo-video activates the iOS playback session but never deactivates it, so
 * interrupted apps (Spotify, Podcasts) are never told they may resume. The
 * last player to stop releases it.
 */
export function videoPlaybackStopped(): void {
  playingCount -= 1;
  if (playingCount > 0 || Platform.OS !== "ios") return;
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    if (playingCount > 0) return;
    void nativeControls?.releaseVideoAudioSession().catch(() => undefined);
  }, RELEASE_DELAY_MS);
}

let fullscreenCount = 0;
const fullscreenListeners = new Set<() => void>();

/** Pairs with `fullscreenVideoClosed` while the native fullscreen player is open. */
export function fullscreenVideoOpened(): void {
  fullscreenCount += 1;
  for (const listener of fullscreenListeners) listener();
}

export function fullscreenVideoClosed(): void {
  fullscreenCount -= 1;
  for (const listener of fullscreenListeners) listener();
}

/** `useSyncExternalStore` source: inline players pause while fullscreen owns playback. */
export function subscribeFullscreenVideo(listener: () => void): () => void {
  fullscreenListeners.add(listener);
  return () => {
    fullscreenListeners.delete(listener);
  };
}

export function isFullscreenVideoOpen(): boolean {
  return fullscreenCount > 0;
}

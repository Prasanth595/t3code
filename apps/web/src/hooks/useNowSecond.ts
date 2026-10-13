import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

/**
 * Second-quantized shared UI clock (Unix seconds). One module-level 1s timer
 * feeds every consumer through useSyncExternalStore, so N "working for Xs"
 * rows cost one wakeup per second instead of N.
 *
 * The timer runs only while the document is visible: a hidden tab freezes the
 * snapshot (no commits, no wakeups) and re-reads the clock on the way back,
 * so ticks missed while hidden collapse into a single update.
 */

function currentSecond(): number {
  return Math.floor(Date.now() / 1_000);
}

function isShowing(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

let nowSecond = currentSecond();
let timerId: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function tick(): void {
  const next = currentSecond();
  if (next !== nowSecond) {
    nowSecond = next;
    notify();
  }
}

function startTimer(): void {
  if (timerId !== null || !isShowing()) return;
  timerId = setInterval(tick, 1_000);
}

function stopTimer(): void {
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
}

function onVisibilityChange(): void {
  if (isShowing()) {
    // Re-read now: missed ticks collapse into one update, due immediately.
    const next = currentSecond();
    const changed = next !== nowSecond;
    nowSecond = next;
    startTimer();
    if (changed) notify();
  } else {
    stopTimer();
  }
}

function watchVisibility(): void {
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
}

function unwatchVisibility(): void {
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    watchVisibility();
    startTimer();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopTimer();
      unwatchVisibility();
    }
  };
}

function getSnapshot(): number {
  // With no subscribers the stored second may be stale (e.g. a fresh mount
  // after a full unmount while hidden); re-read it so the first render shows
  // the current second instead of waiting for a tick. While subscribed the
  // cached value is returned untouched, as useSyncExternalStore requires
  // between change notifications.
  if (listeners.size === 0) {
    nowSecond = currentSecond();
  }
  return nowSecond;
}

const noopUnsubscribe = () => {};

/**
 * Unix seconds, re-rendering the caller once per second while the tab is
 * visible. Pass `active=false` to read the current second once without
 * subscribing (no timer, no re-renders).
 */
export function useNowSecond(active = true): number {
  const subscribeActive = useCallback(
    (listener: () => void) => (active ? subscribe(listener) : noopUnsubscribe),
    [active],
  );
  return useSyncExternalStore(subscribeActive, getSnapshot, getSnapshot);
}

/**
 * Runs `onTick` on the shared 1s clock without re-rendering the caller, for
 * components that paint the time with a direct DOM write. Same single timer
 * and the same pause-while-hidden policy as {@link useNowSecond}.
 */
export function useSecondTick(enabled: boolean, onTick: () => void): void {
  const latest = useRef(onTick);
  latest.current = onTick;
  useEffect(() => {
    if (!enabled) return;
    return subscribe(() => latest.current());
  }, [enabled]);
}

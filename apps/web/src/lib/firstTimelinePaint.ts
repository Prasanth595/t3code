import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useEffect, useEffectEvent } from "react";

const SECONDARY_SUBSCRIPTIONS: ReadonlySet<string> = new Set([
  WS_METHODS.subscribeVcsStatus,
  WS_METHODS.subscribeDeviceState,
  WS_METHODS.subscribePreviewEvents,
  WS_METHODS.scheduledTasksSubscribe,
  WS_METHODS.subscribeProjectClones,
  WS_METHODS.subscribeTerminalMetadata,
  WS_METHODS.subscribeDiscoveredLocalServers,
  WS_METHODS.subscribeResourceTelemetry,
]);

let released = false;
let pending: Promise<void> | undefined;
let release: (() => void) | undefined;
let fallback: number | undefined;

function releaseSecondarySubscriptions(): void {
  released = true;
  if (fallback !== undefined) window.clearTimeout(fallback);
  window.removeEventListener("pointerdown", releaseSecondarySubscriptions, true);
  window.removeEventListener("keydown", releaseSecondarySubscriptions, true);
  release?.();
  release = undefined;
  pending = undefined;
  fallback = undefined;
}

function firstTimelinePaint(): Promise<void> {
  pending ??= new Promise<void>((resolve) => {
    release = resolve;
    // Missing threads and hidden windows must still receive their secondary state.
    fallback = window.setTimeout(releaseSecondarySubscriptions, 1_000);
    // A user opening a secondary surface takes priority over startup ordering.
    window.addEventListener("pointerdown", releaseSecondarySubscriptions, {
      once: true,
      capture: true,
    });
    window.addEventListener("keydown", releaseSecondarySubscriptions, {
      once: true,
      capture: true,
    });
  });
  return pending;
}

/** Keeps secondary snapshot decoding and publication behind the initial timeline commit. */
export function waitForFirstTimelinePaint(method: string): Effect.Effect<void> {
  return Effect.suspend(() =>
    released || !SECONDARY_SUBSCRIPTIONS.has(method) || typeof window === "undefined"
      ? Effect.void
      : Effect.promise(firstTimelinePaint),
  );
}

/** Cancel stale mount effects while sharing the subscription gate and its interaction escape. */
export function afterFirstTimelinePaint(callback: () => void): () => void {
  if (released || typeof window === "undefined") {
    callback();
    return () => {};
  }
  let active = true;
  void firstTimelinePaint().then(() => {
    if (active) callback();
  });
  return () => {
    active = false;
  };
}

/** Release after a frame has painted; non-thread routes release after their own commit. */
export function useFirstTimelinePaint(ready: boolean, onPaint?: () => void): void {
  const painted = useEffectEvent(() => onPaint?.());
  useEffect(() => {
    if (!ready || (released && onPaint === undefined)) return;
    let nextFrame: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      nextFrame = window.requestAnimationFrame(() => {
        painted();
        releaseSecondarySubscriptions();
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (nextFrame !== undefined) window.cancelAnimationFrame(nextFrame);
    };
  }, [ready, onPaint]);
}

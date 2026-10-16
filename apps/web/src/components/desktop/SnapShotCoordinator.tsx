import {
  type DesktopPendingSnapShot,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import {
  type DraftId,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useClientSettings } from "../../hooks/useSettings";
import { readThreadShell } from "../../state/entities";
import { environmentThreadShells } from "../../state/threads";
import { environmentShell } from "../../state/shell";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { compressImageToByteLimit, dataUrlToFile } from "../../lib/imageCompression";
import { resolveThreadActionProjectRef } from "../../lib/chatThreadActions";
import {
  beginSnapShotAnimation,
  dismissAllSnapShotAnimations,
  dismissSnapShotAnimation,
  finishSnapShotAnimation,
  getPendingSnapShotAnimations,
  updateSnapShotAnimationSource,
  waitForSnapShotAnimationDestination,
} from "../../lib/snapShotAnimation";
import { resizeSnapShotSource } from "../../lib/snapShotSource";
import { playSnapShotSound } from "../../lib/snapShotSound";
import {
  dispatchSnapShotComposerFocus,
  getDesktopSnapShotBridge,
  type DesktopSnapShotBridge,
} from "../../lib/desktopSnapShot";
import { readFileAsDataUrl } from "../ChatView.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";

type CaptureTarget = DraftId | ScopedThreadRef;

export function resolveExistingSnapShotTarget(
  target: CaptureTarget,
  routeThreadRef: ScopedThreadRef | null,
): CaptureTarget | null {
  const store = useComposerDraftStore.getState();
  if (typeof target === "string") {
    const draftSession = store.getDraftSession(target);
    if (draftSession?.promotedTo) return draftSession.promotedTo;
    return draftSession ? target : null;
  }
  const targetIsCurrentRoute =
    routeThreadRef !== null &&
    routeThreadRef.environmentId === target.environmentId &&
    routeThreadRef.threadId === target.threadId;
  return targetIsCurrentRoute ||
    store.getDraftSessionByRef(target) !== null ||
    readThreadShell(target) !== null
    ? target
    : null;
}

type SnapShotCaptureContext = Pick<
  ReturnType<typeof useHandleNewThread>,
  "activeDraftThread" | "activeThread" | "defaultProjectRef" | "handleNewThread" | "routeThreadRef"
>;

// Reuses the last target while it is still valid for the given route, otherwise creates a draft
// in the context's project. Drain passes pass the context they started with, so navigation during
// `listPendingSnapShots` cannot redirect an unpinned capture.
async function resolveSnapShotCaptureTarget(
  context: SnapShotCaptureContext,
  lastTarget: CaptureTarget | null,
): Promise<CaptureTarget | null> {
  if (lastTarget) {
    const existingTarget = resolveExistingSnapShotTarget(lastTarget, context.routeThreadRef);
    if (existingTarget) return existingTarget;
  }
  const projectRef = resolveThreadActionProjectRef({
    activeDraftThread: context.activeDraftThread,
    activeThread: context.activeThread ?? undefined,
    defaultProjectRef: context.defaultProjectRef,
    handleNewThread: context.handleNewThread,
  });
  if (!projectRef) return null;
  const created = await context.handleNewThread(projectRef);
  return created?.draftId ?? null;
}

const NEXT_PAINT_FALLBACK_MS = 100;

export async function beginSnapShotAnimationWhenReady(
  id: string,
  target: Promise<CaptureTarget | null>,
  pendingStarts: Set<string>,
): Promise<void> {
  pendingStarts.add(id);
  try {
    const resolvedTarget = await target;
    if (pendingStarts.delete(id) && resolvedTarget) {
      beginSnapShotAnimation(id, resolvedTarget);
    }
  } finally {
    pendingStarts.delete(id);
  }
}

export function dismissFailedSnapShot(
  id: string | undefined,
  soundedIds: Set<string>,
  pendingStarts: Set<string>,
): void {
  if (id) {
    pendingStarts.delete(id);
    soundedIds.delete(id);
    void dismissSnapShotAnimation(id);
  } else {
    pendingStarts.clear();
    dismissAllSnapShotAnimations();
  }
}

export function resolveSnapShotTargetOnce(
  resolutionRef: { current: Promise<CaptureTarget | null> | null },
  resolveTarget: () => Promise<CaptureTarget | null>,
): Promise<CaptureTarget | null> {
  if (resolutionRef.current) return resolutionRef.current;
  const resolution = resolveTarget().finally(() => {
    if (resolutionRef.current === resolution) resolutionRef.current = null;
  });
  resolutionRef.current = resolution;
  return resolution;
}

export function resolveSnapShotDeliveryTarget(
  targets: Map<string, Promise<CaptureTarget | null>>,
  id: string,
  resolveTarget: () => Promise<CaptureTarget | null>,
): Promise<CaptureTarget | null> {
  const existing = targets.get(id);
  if (existing) return existing;
  const target = resolveTarget().catch(() => null);
  targets.set(id, target);
  void target.then((resolved) => {
    if (!resolved && targets.get(id) === target) targets.delete(id);
  });
  return target;
}

async function afterNextPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    const fallback = window.setTimeout(resolve, NEXT_PAINT_FALLBACK_MS);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.clearTimeout(fallback);
        resolve();
      });
    });
  });
}

export async function deliverSnapShot(
  bridge: DesktopSnapShotBridge,
  item: DesktopPendingSnapShot,
  target: CaptureTarget,
): Promise<void> {
  const store = useComposerDraftStore.getState();
  updateSnapShotAnimationSource(item.id, item.source);
  const capture = await bridge.readSnapShot(item.id);
  const original = dataUrlToFile(capture.dataUrl, capture.name, capture.mimeType);
  const compressed = await compressImageToByteLimit(original, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
  if (!compressed.ok) {
    finishSnapShotAnimation(item.id);
    throw new Error("The captured window is too large to attach.");
  }
  const file = compressed.file;
  const source = resizeSnapShotSource(capture.source, compressed.imageSize);
  const dataUrl = compressed.recompressed ? await readFileAsDataUrl(file) : capture.dataUrl;
  const alreadyAttached =
    store.getComposerDraft(target)?.images.some(({ id }) => id === capture.id) ?? false;
  if (
    !alreadyAttached &&
    !store.addImage(target, {
      type: "image",
      id: capture.id,
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      previewUrl: dataUrl,
      file,
      source,
    })
  ) {
    throw new Error("Remove an attachment, then try this capture again.");
  }
  const persisted: PersistedComposerImageAttachment = {
    id: capture.id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    dataUrl,
    source,
  };
  const persistedAttachments =
    store
      .getComposerDraft(target)
      ?.persistedAttachments.filter((attachment) => attachment.id !== capture.id) ?? [];
  await store.syncPersistedAttachments(target, [...persistedAttachments, persisted]);
  if (!store.getComposerDraft(target)?.persistedAttachments.some(({ id }) => id === capture.id)) {
    throw new Error("The captured window could not be saved to the draft.");
  }

  // Reveal the attachment under the flying capture before the desktop tears the overlay down,
  // otherwise the tile is missing for the frames between the landing and its first paint.
  if (getPendingSnapShotAnimations().some((animation) => animation.id === capture.id)) {
    await afterNextPaint();
    await waitForSnapShotAnimationDestination(capture.id).catch(() => undefined);
    finishSnapShotAnimation(capture.id);
    await afterNextPaint();
  }
  await bridge.acknowledgeSnapShot(capture.id);
  dispatchSnapShotComposerFocus();
}

export function SnapShotCoordinator() {
  const {
    activeDraftThread,
    activeThread,
    defaultProjectRef,
    handleNewThread,
    routeDraftId,
    routeThreadRef,
  } = useHandleNewThread();
  const captureSound = useClientSettings((settings) =>
    settings.snapShotPlaySound ? settings.snapShotSound : null,
  );
  const animateCaptures = useClientSettings((settings) => settings.snapShotAnimations);
  const captureTargetsRef = useRef(new Map<string, Promise<CaptureTarget | null>>());
  const lastTargetRef = useRef<CaptureTarget | null>(null);
  const targetResolutionRef = useRef<Promise<CaptureTarget | null> | null>(null);
  const drainingRef = useRef<Promise<void> | null>(null);
  const rerunRequestedRef = useRef(false);
  const soundedCaptureIdsRef = useRef(new Set<string>());
  const pendingAnimationStartsRef = useRef(new Set<string>());
  const waitingThreadShellsRef = useRef(new Map<string, () => void>());
  const stopWaitingForThreadShell = useCallback((id?: string) => {
    if (id) {
      waitingThreadShellsRef.current.get(id)?.();
      waitingThreadShellsRef.current.delete(id);
    } else {
      for (const unsubscribe of waitingThreadShellsRef.current.values()) unsubscribe();
      waitingThreadShellsRef.current.clear();
    }
  }, []);

  const currentTarget = routeThreadRef ?? routeDraftId;
  const routeHref = useLocation({ select: (location) => location.href });
  const defaultProjectKey = defaultProjectRef
    ? `${defaultProjectRef.environmentId}:${defaultProjectRef.projectId}`
    : null;
  const latestContextRef = useRef({
    activeDraftThread,
    activeThread,
    animateCaptures,
    captureSound,
    defaultProjectRef,
    handleNewThread,
    routeThreadRef,
    routeHref,
    defaultProjectKey,
  });

  useLayoutEffect(() => {
    if (currentTarget) {
      lastTargetRef.current = currentTarget;
    }
    latestContextRef.current = {
      activeDraftThread,
      activeThread,
      animateCaptures,
      captureSound,
      defaultProjectRef,
      handleNewThread,
      routeThreadRef,
      routeHref,
      defaultProjectKey,
    };
  }, [
    activeDraftThread,
    activeThread,
    animateCaptures,
    captureSound,
    currentTarget,
    defaultProjectRef,
    handleNewThread,
    routeThreadRef,
    routeHref,
    defaultProjectKey,
  ]);

  const resolveCaptureTarget = useCallback(
    () =>
      resolveSnapShotTargetOnce(targetResolutionRef, async () => {
        const context = latestContextRef.current;
        const lastTarget = lastTargetRef.current;
        const target = await resolveSnapShotCaptureTarget(context, lastTarget);
        // A committed navigation owns the live target, even if an older creation finishes later.
        if (
          context.routeHref === latestContextRef.current.routeHref &&
          context.defaultProjectKey === latestContextRef.current.defaultProjectKey &&
          lastTargetRef.current === lastTarget
        ) {
          lastTargetRef.current = target;
        }
        return target;
      }),
    [],
  );

  const playCaptureSound = useCallback((id: string) => {
    const sound = latestContextRef.current.captureSound;
    if (!sound || soundedCaptureIdsRef.current.has(id)) return;
    soundedCaptureIdsRef.current.add(id);
    try {
      playSnapShotSound(sound);
    } catch {}
  }, []);

  const drain = useCallback(
    async function drainPendingSnapShots(): Promise<void> {
      const bridge = getDesktopSnapShotBridge();
      if (!bridge) return;
      if (drainingRef.current) {
        rerunRequestedRef.current = true;
        return drainingRef.current;
      }

      const operation = (async () => {
        do {
          rerunRequestedRef.current = false;
          // Resolve and validate against the context this pass started on: a capture for a routed
          // thread whose shell has not loaded yet must not be dropped or redirected because the
          // user navigated mid-pass.
          const passContext = latestContextRef.current;
          let passLastTarget = lastTargetRef.current;
          const passResolutionRef = { current: null as Promise<CaptureTarget | null> | null };
          const resolvePassTarget = () =>
            resolveSnapShotTargetOnce(passResolutionRef, async () => {
              passLastTarget = await resolveSnapShotCaptureTarget(passContext, passLastTarget);
              return passLastTarget;
            });
          const pending = await bridge.listPendingSnapShots();
          for (const item of pending) {
            playCaptureSound(item.id);
            let capturedTarget = await resolveSnapShotDeliveryTarget(
              captureTargetsRef.current,
              item.id,
              resolvePassTarget,
            );
            // An animated capture may still be waiting on creation abandoned before this ready pass.
            // Its null result is evicted by resolveSnapShotDeliveryTarget; retry from this pass's route.
            if (!capturedTarget) {
              if (
                passContext.routeHref !== latestContextRef.current.routeHref ||
                passContext.defaultProjectKey !== latestContextRef.current.defaultProjectKey
              ) {
                rerunRequestedRef.current = true;
                continue;
              }
              capturedTarget = await resolveSnapShotDeliveryTarget(
                captureTargetsRef.current,
                item.id,
                resolvePassTarget,
              );
            }
            const target = capturedTarget
              ? resolveExistingSnapShotTarget(capturedTarget, passContext.routeThreadRef)
              : null;
            if (!target) {
              if (capturedTarget && typeof capturedTarget !== "string") {
                const waitingTarget = capturedTarget;
                const availability = Atom.make((get) => {
                  if (get(environmentThreadShells.threadShellAtom(waitingTarget)) !== null) {
                    return "available";
                  }
                  const shell = get(environmentShell.stateValueAtom(waitingTarget.environmentId));
                  return shell.status === "live" &&
                    Option.isSome(shell.snapshot) &&
                    !shell.snapshot.value.threads.some(
                      (thread) => thread.id === waitingTarget.threadId,
                    )
                    ? "missing"
                    : "waiting";
                });
                if (appAtomRegistry.get(availability) === "missing") {
                  stopWaitingForThreadShell(item.id);
                  await dismissSnapShotAnimation(item.id);
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: "Snapshot failed",
                      description:
                        "The original thread is no longer available. Capture again in an existing thread.",
                    }),
                  );
                  continue;
                }
                if (!waitingThreadShellsRef.current.has(item.id)) {
                  // Only retained captures with an unavailable target need a shell subscription.
                  // Availability changes, including a live snapshot confirming deletion, retry once.
                  const retryWhenAvailable = () => {
                    if (appAtomRegistry.get(availability) === "waiting") return;
                    stopWaitingForThreadShell(item.id);
                    void drainPendingSnapShots();
                  };
                  waitingThreadShellsRef.current.set(
                    item.id,
                    appAtomRegistry.subscribe(availability, retryWhenAvailable),
                  );
                  retryWhenAvailable();
                }
                await dismissSnapShotAnimation(item.id);
                continue;
              }
              await dismissSnapShotAnimation(item.id);
              soundedCaptureIdsRef.current.delete(item.id);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Snapshot taken, but no project is available",
                  description: "Add a project, then capture the window again.",
                }),
              );
              continue;
            }

            stopWaitingForThreadShell(item.id);
            try {
              await deliverSnapShot(bridge, item, target);
              captureTargetsRef.current.delete(item.id);
              soundedCaptureIdsRef.current.delete(item.id);
            } catch (error) {
              await dismissSnapShotAnimation(item.id);
              soundedCaptureIdsRef.current.delete(item.id);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Snapshot failed",
                  description: `Capture ${item.id}: ${
                    error instanceof Error ? error.message : "Try the capture again."
                  }`,
                }),
              );
            }
          }
        } while (rerunRequestedRef.current);
      })()
        .catch((error: unknown) => {
          dismissAllSnapShotAnimations();
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Snapshot failed",
              description: error instanceof Error ? error.message : "Try the capture again.",
            }),
          );
        })
        .finally(() => {
          drainingRef.current = null;
        });
      drainingRef.current = operation;
      return operation;
    },
    [playCaptureSound, stopWaitingForThreadShell],
  );

  useEffect(() => () => stopWaitingForThreadShell(), [stopWaitingForThreadShell]);

  useEffect(() => {
    const bridge = getDesktopSnapShotBridge();
    if (!bridge) return;
    void drain();
    const unsubscribe = bridge.onSnapShotEvent((event) => {
      switch (event.type) {
        case "requested": {
          const current = lastTargetRef.current;
          const target = current
            ? resolveExistingSnapShotTarget(current, latestContextRef.current.routeThreadRef)
            : null;
          // Creating a new draft would navigate the renderer before a self-capture finishes.
          if (target) {
            void resolveSnapShotDeliveryTarget(captureTargetsRef.current, event.id, () =>
              Promise.resolve(target),
            );
          }
          return;
        }
        case "started": {
          playCaptureSound(event.id);
          if (
            latestContextRef.current.animateCaptures &&
            !window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ) {
            void beginSnapShotAnimationWhenReady(
              event.id,
              resolveSnapShotDeliveryTarget(
                captureTargetsRef.current,
                event.id,
                resolveCaptureTarget,
              ),
              pendingAnimationStartsRef.current,
            );
          }
          return;
        }
        case "ready":
          void drain();
          return;
        case "failed": {
          if (event.id) {
            stopWaitingForThreadShell(event.id);
            captureTargetsRef.current.delete(event.id);
          }
          dismissFailedSnapShot(
            event.id,
            soundedCaptureIdsRef.current,
            pendingAnimationStartsRef.current,
          );
          void bridge.getSnapShotState().then((state) => {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Snapshot failed",
                description: state.message ?? "Try the capture again.",
              }),
            );
          });
          return;
        }
        case "shortcut-changed":
          return;
      }
    });
    return unsubscribe;
  }, [drain, playCaptureSound, resolveCaptureTarget, stopWaitingForThreadShell]);

  // Captures persisted before the route bootstrapped, or whose draft creation was abandoned by
  // navigation, get no new `ready` event. Retry when the location or default project changes,
  // which streaming updates to the same thread never do.
  const retryKey = currentTarget || defaultProjectKey ? `${routeHref} ${defaultProjectKey}` : null;
  const previousRetryKeyRef = useRef(retryKey);
  useEffect(() => {
    const previousRetryKey = previousRetryKeyRef.current;
    previousRetryKeyRef.current = retryKey;
    if (retryKey !== null && retryKey !== previousRetryKey) void drain();
  }, [drain, retryKey]);

  useEffect(() => {
    const dismissOnBlur = () => {
      pendingAnimationStartsRef.current.clear();
      dismissAllSnapShotAnimations();
    };
    const drainOnFocus = () => void drain();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") dismissOnBlur();
      else void drain();
    };
    window.addEventListener("blur", dismissOnBlur);
    window.addEventListener("focus", drainOnFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", dismissOnBlur);
      window.removeEventListener("focus", drainOnFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [drain]);

  return null;
}

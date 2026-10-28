import { completeTemporaryChatLaunch } from "../temporaryChatViews";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  createTemporaryThreadView,
  isTemporaryThread,
} from "@t3tools/client-runtime/temporary-threads";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useEffect, useRef, useState } from "react";
import { useComposerDraftStore } from "../composerDraftStore";
import { useThreadRouteTarget } from "./useThreadRouteTarget";
import { useQuietThreadShell } from "../state/entities";
import { useEnvironmentShellStatus } from "../state/shell";
import { useConnectedEnvironmentIds } from "../state/environments";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useStableCallback } from "./useStableCallback";
import { isElectron } from "../env";

type TemporaryViewPayload = ReturnType<
  ReturnType<typeof createTemporaryThreadView>["reconnect"]
>[number];

const pendingViewUpdates = new Map<string, TemporaryViewPayload>();
const environmentViewQueues = new Map<string, Promise<boolean>>();

let completeOpenViewLaunch: ((threadRef: ScopedThreadRef) => Promise<boolean>) | undefined;

export function captureTemporaryChatLaunch() {
  return completeOpenViewLaunch;
}

let reconcileOpenView: (() => Promise<boolean>) | undefined;

export function reconcileTemporaryChatViews(): Promise<boolean> {
  return reconcileOpenView?.() ?? Promise.resolve(true);
}

export function useTemporaryChatViews() {
  const target = useThreadRouteTarget();
  const draft = useComposerDraftStore((state) =>
    target?.kind === "draft" ? state.getDraftSession(target.draftId) : null,
  );
  const draftRedirect = useComposerDraftStore((state) =>
    target?.kind === "draft" ? state.getPromotedDraftRedirect(target.draftId) : null,
  );
  const ref =
    target?.kind === "server"
      ? target.threadRef
      : draft
        ? scopeThreadRef(draft.environmentId, draft.threadId)
        : draftRedirect;
  const shell = useQuietThreadShell(ref);
  const status = useEnvironmentShellStatus(ref?.environmentId ?? null);
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const [view] = useState(() => createTemporaryThreadView());
  const update = useAtomCommand(threadEnvironment.updateTemporaryViews, {
    reportFailure: false,
  });
  const unloading = useRef(false);
  const mounted = useRef(true);
  const send = useStableCallback((payloads: ReturnType<typeof view.reconnect>) => {
    const key = (payload: ReturnType<typeof view.reconnect>[number]) =>
      JSON.stringify([payload.environmentId, payload.input.viewId]);
    const updates = [
      ...[...pendingViewUpdates.values()].filter(
        (previous) => !payloads.some((payload) => key(previous) === key(payload)),
      ),
      ...payloads,
    ];
    for (const payload of payloads) pendingViewUpdates.set(key(payload), payload);
    const results = updates.map((payload) => {
      const queue = environmentViewQueues.get(payload.environmentId) ?? Promise.resolve(true);
      const next = queue.then(async () => {
        const result = await update(payload);
        if (result._tag === "Failure") return false;
        if (pendingViewUpdates.get(key(payload)) === payload)
          pendingViewUpdates.delete(key(payload));
        return true;
      });
      environmentViewQueues.set(payload.environmentId, next);
      return next;
    });
    return Promise.all(results).then((results) => results.every(Boolean));
  });
  const previousDraftId = useRef(target?.kind === "draft" ? target.draftId : null);
  const currentDraftId = target?.kind === "draft" ? target.draftId : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release abandoned drafts only after the route change settles.
  useEffect(() => {
    const previous = previousDraftId.current;
    previousDraftId.current = currentDraftId;
    if (previous === null || previous === currentDraftId) return;
    const store = useComposerDraftStore.getState();
    const previousDraft = store.getDraftSession(previous);
    if (
      previousDraft?.temporary &&
      !previousDraft.promotedTo &&
      previousDraft.threadId !== ref?.threadId
    )
      store.clearDraftThread(previous);
  }, [currentDraftId, ref?.threadId]);
  const environmentId = ref?.environmentId ?? null;
  const threadId = ref?.threadId ?? null;
  const temporary =
    shell?.temporary === true ||
    draft?.temporary === true ||
    (ref !== null && isTemporaryThread(ref.environmentId, ref.threadId));
  const reconcile = useStableCallback(
    (environmentId: string | null, threadId: string | null, temporary: boolean) => {
      if (environmentId === null || !temporary || threadId === null) {
        const previous = view.reconnect()[0];
        if (!previous || previous.input.threadIds.length === 0) return send([]);
        return send(view.update({ environmentId: previous.environmentId, threadIds: [] }));
      }
      const changed = view.update({
        environmentId,
        threadIds: [threadId],
        background: isElectron && document.visibilityState === "hidden",
      });
      return send(changed.length > 0 ? changed : view.reconnect());
    },
  );
  const reconcileCurrent = useStableCallback(() => reconcile(environmentId, threadId, temporary));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronize the current route with temporary server view ownership.
  useEffect(() => {
    if (status !== null || environmentId === null)
      void reconcile(environmentId, threadId, temporary);
  }, [environmentId, threadId, temporary, status, reconcile]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Retry pending server view updates when environment connections change.
  useEffect(() => {
    if (connectedEnvironmentIds.length > 0 && pendingViewUpdates.size > 0) void send([]);
  }, [connectedEnvironmentIds, send]);
  const completeLaunch = useStableCallback((created: ScopedThreadRef) =>
    completeTemporaryChatLaunch({
      threadRef: created,
      isCurrent:
        mounted.current && environmentId === created.environmentId && threadId === created.threadId,
      view,
      background: isElectron && document.visibilityState === "hidden",
      send,
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronize server ownership with page lifecycle and DOM events.
  useEffect(() => {
    mounted.current = true;
    completeOpenViewLaunch = completeLaunch;
    reconcileOpenView = reconcileCurrent;
    const visibility = () => void reconcileCurrent();
    const pagehide = () => {
      unloading.current = true;
      void send(
        view
          .reconnect()
          .map((payload) => ({ ...payload, input: { ...payload.input, background: false } })),
      );
    };
    const pageshow = () => {
      unloading.current = false;
      void reconcileCurrent();
    };
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("pageshow", pageshow);
    window.addEventListener("online", visibility);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      mounted.current = false;
      if (completeOpenViewLaunch === completeLaunch) completeOpenViewLaunch = undefined;
      if (reconcileOpenView === reconcileCurrent) reconcileOpenView = undefined;
      window.removeEventListener("pagehide", pagehide);
      window.removeEventListener("pageshow", pageshow);
      window.removeEventListener("online", visibility);
      document.removeEventListener("visibilitychange", visibility);
      if (!unloading.current) {
        const previous = previousDraftId.current;
        if (previous !== null) {
          const store = useComposerDraftStore.getState();
          const draft = store.getDraftSession(previous);
          if (draft?.temporary && !draft.promotedTo) store.clearDraftThread(previous);
        }
        send(
          view
            .reconnect()
            .map((payload) => ({ ...payload, input: { ...payload.input, threadIds: [] } })),
        );
      }
    };
  }, [completeLaunch, reconcileCurrent, send, view]);
}

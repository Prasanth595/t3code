import { useEffect, useLayoutEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import type { NavigationState } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  createTemporaryThreadView,
  isTemporaryThread,
  setTemporaryThread,
} from "@t3tools/client-runtime/temporary-threads";
import { AsyncResult } from "effect/reactivity";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import {
  openThreadView,
  hasOpenThreadDraft,
  selectedChatRoute,
  draftRouteIdentity,
  isDraftThreadRoute,
  type ThreadNavigationState,
} from "../features/threads/thread-route-state";
import { appAtomRegistry } from "./atom-registry";
import { threadEnvironment } from "./threads";
import { useRemoteConnectionStatus } from "./use-remote-environment-registry";
import { useThreadShells } from "./entities";
import {
  clearComposerDraft,
  composerDraftsAtom,
  isTemporaryComposerDraft,
} from "./use-composer-drafts";
import { uuidv4 } from "../lib/uuid";
import { scopedThreadKey } from "../lib/scopedEntities";
import {
  enqueueThreadOutboxMessage,
  threadOutboxManager,
  type QueuedThreadMessage,
} from "./thread-outbox";
import { clearPendingThreadCreationOutcome } from "./pending-thread-creation";

const view = createTemporaryThreadView({ viewId: uuidv4() });
let queue = Promise.resolve(true);
const pending = new Map<string, ReturnType<typeof view.reconnect>[number]>();

function sendViews(updates: ReturnType<typeof view.reconnect>): Promise<boolean> {
  for (const update of updates) {
    pending.delete(update.environmentId);
    pending.set(update.environmentId, update);
  }
  queue = queue.then(
    async () => {
      let complete = true;
      for (const update of Array.from(pending.values())) {
        const result = await runAtomCommand(
          appAtomRegistry,
          threadEnvironment.updateTemporaryViews,
          {
            environmentId: EnvironmentId.make(update.environmentId),
            input: {
              ...update.input,
              threadIds: update.input.threadIds.map((id) => ThreadId.make(id)),
            },
          },
          { reportFailure: false, reportDefect: false },
        );
        if (AsyncResult.isFailure(result)) {
          complete = false;
          continue;
        }
        if (pending.get(update.environmentId) === update) pending.delete(update.environmentId);
      }
      return complete;
    },
    () => false,
  );
  return queue;
}

type ThreadView = NonNullable<ReturnType<typeof openThreadView>>;
let current: ThreadView | null = null;
let getNavigationState: (() => ThreadNavigationState | undefined) | null = null;
let reservation: {
  readonly owner: ThreadView;
  readonly routeKey: string | undefined;
  readonly identity: string;
} | null = null;

function sameView(left: ThreadView | null, right: ThreadView | null): boolean {
  return left?.environmentId === right?.environmentId && left?.threadId === right?.threadId;
}

function selectedTemporaryThreadView(): ThreadView | null {
  if (getNavigationState === null) return null;
  const state = getNavigationState();
  const route = selectedChatRoute(state, Platform.OS);
  if (reservation !== null && isDraftThreadRoute(route)) {
    const draft = route.params.draft;
    return route.key === reservation.routeKey && draftRouteIdentity(draft) === reservation.identity
      ? reservation.owner
      : null;
  }
  const owner = openThreadView(state, Platform.OS);
  return owner !== null && isTemporaryThread(owner.environmentId, owner.threadId) ? owner : null;
}

function syncTemporaryThreadViews(): Promise<boolean> {
  const old = current;
  const next = selectedTemporaryThreadView();
  current = next;
  if (
    reservation !== null &&
    (!sameView(next, reservation.owner) ||
      (getNavigationState !== null &&
        !isDraftThreadRoute(selectedChatRoute(getNavigationState(), Platform.OS))))
  )
    reservation = null;
  if (
    old !== null &&
    isTemporaryThread(old.environmentId, old.threadId) &&
    !sameView(old, next) &&
    !sameView(old, openThreadView(getNavigationState?.(), Platform.OS))
  ) {
    const key = scopedThreadKey(EnvironmentId.make(old.environmentId), ThreadId.make(old.threadId));
    for (const draftKey of Object.keys(appAtomRegistry.get(composerDraftsAtom))) {
      if (draftKey === key || draftKey.startsWith(`${key}~queued-edit~`))
        clearComposerDraft(draftKey);
    }
    clearPendingThreadCreationOutcome(key);
    const messages =
      appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom)[key] ?? [];
    for (const message of messages) {
      clearComposerDraft(`pending-task:${message.messageId}`);
      void threadOutboxManager.remove(message);
    }
  }
  const owner = next ?? old;
  return sendViews(
    owner === null
      ? []
      : view.update({
          environmentId: owner.environmentId,
          threadIds: next === null ? [] : [next.threadId],
          background: next !== null && AppState.currentState !== "active",
        }),
  );
}

export function isTemporaryThreadViewOpen(environmentId: string, threadId: string): boolean {
  return sameView(selectedTemporaryThreadView(), { environmentId, threadId });
}

export function openTemporaryThreadView(
  environmentId: string,
  threadId: string,
  getState: () => ThreadNavigationState | undefined,
): Promise<boolean> {
  getNavigationState = getState;
  const route = selectedChatRoute(getState(), Platform.OS);
  if (!isDraftThreadRoute(route)) return Promise.resolve(false);
  reservation = {
    owner: { environmentId, threadId },
    routeKey: route.key,
    identity: draftRouteIdentity(route.params.draft),
  };
  return syncTemporaryThreadViews();
}

export async function enqueueTemporaryDraftThread(
  message: QueuedThreadMessage,
  getState: () => ThreadNavigationState | undefined,
  onQueued: () => void,
): Promise<"queued" | "left" | "unavailable"> {
  setTemporaryThread(message.environmentId, message.threadId, true);
  const opening = openTemporaryThreadView(message.environmentId, message.threadId, getState);
  const claim = reservation;
  const ownsClaim = () =>
    claim !== null &&
    reservation === claim &&
    isTemporaryThreadViewOpen(message.environmentId, message.threadId);
  const opened = await opening;
  if (!ownsClaim()) {
    await syncTemporaryThreadViews();
    return "left";
  }
  if (!opened) {
    reservation = null;
    await syncTemporaryThreadViews();
    return "unavailable";
  }
  try {
    await enqueueThreadOutboxMessage(message);
  } catch (error) {
    if (reservation === claim) reservation = null;
    await syncTemporaryThreadViews();
    throw error;
  }
  if (!ownsClaim()) {
    await threadOutboxManager.remove(message);
    await syncTemporaryThreadViews();
    return "left";
  }
  onQueued();
  return "queued";
}

export async function reconcileTemporaryThreadViews(): Promise<boolean> {
  await syncTemporaryThreadViews();
  return sendViews(view.reconnect());
}

export async function startThreadTurnWithTemporaryView<A>(
  message: Pick<QueuedThreadMessage, "environmentId" | "threadId" | "temporary">,
  start: () => Promise<A>,
): Promise<
  | { readonly status: "left" }
  | { readonly status: "retry" }
  | { readonly status: "started"; readonly result: A }
> {
  const needsView = () =>
    message.temporary && isTemporaryThread(message.environmentId, message.threadId);
  if (needsView()) {
    const reconciled = await reconcileTemporaryThreadViews();
    if (needsView() && !isTemporaryThreadViewOpen(message.environmentId, message.threadId))
      return { status: "left" };
    if (needsView() && !reconciled) return { status: "retry" };
  }
  const result = await start();
  if (needsView() && !isTemporaryThreadViewOpen(message.environmentId, message.threadId)) {
    await syncTemporaryThreadViews();
    return { status: "left" };
  }
  return { status: "started", result };
}

export function useTemporaryThreadViews(
  state: NavigationState,
  draftKey: string | null,
  navigation: {
    readonly getState: () => NavigationState | undefined;
    readonly addListener: (event: "state", listener: () => void) => () => void;
  },
): void {
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const shells = useThreadShells();
  const selected = openThreadView(state, Platform.OS);
  const environmentId = selected?.environmentId ?? null;
  const threadId = selected?.threadId ?? null;
  const temporary = shells.some(
    (shell) => shell.environmentId === environmentId && shell.id === threadId && shell.temporary,
  );
  const connected = connectedEnvironments
    .map((environment) => `${environment.environmentId}:${environment.connectionState}`)
    .join("|");
  const draftOpen = hasOpenThreadDraft(state, Platform.OS);
  const previousDraftKey = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release abandoned temporary drafts after native navigation settles.
  useEffect(() => {
    const old = previousDraftKey.current;
    if (old !== null && (!draftOpen || old !== draftKey) && isTemporaryComposerDraft(old))
      clearComposerDraft(old);
    previousDraftKey.current = draftOpen ? draftKey : null;
  }, [draftKey, draftOpen]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Track native navigation events before publishing server view leases.
  useLayoutEffect(() => {
    getNavigationState = () => navigation.getState();
    void syncTemporaryThreadViews();
    return navigation.addListener("state", () => {
      void syncTemporaryThreadViews();
    });
  }, [navigation]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronize the server view lease with app background changes.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", () => {
      void syncTemporaryThreadViews();
    });
    return () => subscription.remove();
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronize temporary ownership when the selected native thread changes.
  useEffect(() => {
    if (temporary && environmentId !== null && threadId !== null)
      setTemporaryThread(environmentId, threadId, true);
    void syncTemporaryThreadViews();
  }, [environmentId, threadId, temporary]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Replay view ownership after environment connections recover.
  useEffect(() => {
    if (connected.length > 0) void reconcileTemporaryThreadViews();
  }, [connected]);
}

import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  decideComposerDraftSync,
  NEW_TASK_COMPOSER_DRAFT_PREFIX,
  THREAD_COMPOSER_DRAFT_PREFIX,
  type ComposerDraftSyncKey,
  type ComposerDraftSyncLocal,
  type EnvironmentId,
  type ProjectId,
  type SyncedComposerDraft,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { composerDraftHasUserContent, DraftId, useComposerDraftStore } from "./composerDraftStore";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { serverEnvironment } from "./state/server";
import { environmentSummaries } from "./state/presentation";

const STAMP_STORAGE_KEY = "t3code:composer-draft-sync-stamps:v1";

interface Stamp {
  readonly signature: string;
  readonly updatedAt: string;
}

const stamps = new Map<string, Stamp>();
const remoteByEnvironment = new Map<EnvironmentId, Map<string, SyncedComposerDraft>>();
const readyEnvironments = new Set<EnvironmentId>();
let applying = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

function stampId(environmentId: EnvironmentId, key: string): string {
  return `${environmentId}\n${key}`;
}

function loadStamps(): void {
  if (typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(STAMP_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, Stamp>;
    for (const [id, stamp] of Object.entries(parsed)) {
      if (stamp && typeof stamp.signature === "string" && typeof stamp.updatedAt === "string") {
        stamps.set(id, stamp);
      }
    }
  } catch {
    // A corrupt stamp file only makes the next edit win; drafts themselves stay put.
  }
}

function saveStamps(): void {
  if (typeof localStorage === "undefined") return;
  const record: Record<string, Stamp> = {};
  for (const [id, stamp] of stamps) record[id] = stamp;
  localStorage.setItem(STAMP_STORAGE_KEY, JSON.stringify(record));
}

function signatureOf(draft: ComposerDraftSyncLocal): string {
  return JSON.stringify([
    draft.deleted,
    draft.prompt,
    draft.projectId ?? null,
    draft.threadId ?? null,
    draft.modelSelection ?? null,
    draft.runtimeMode ?? null,
    draft.interactionMode ?? null,
  ]);
}

function remember(environmentId: EnvironmentId, draft: SyncedComposerDraft): void {
  stamps.set(stampId(environmentId, draft.key), {
    signature: signatureOf(draft),
    updatedAt: draft.updatedAt,
  });
  saveStamps();
}

function localDrafts(environmentId: EnvironmentId): Map<string, ComposerDraftSyncLocal> {
  const state = useComposerDraftStore.getState();
  const drafts = new Map<string, ComposerDraftSyncLocal>();
  for (const [key, draft] of Object.entries(state.draftsByThreadKey)) {
    const session = state.draftThreadsByThreadKey[key];
    if (session?.environmentId === environmentId) {
      const syncKey = `${NEW_TASK_COMPOSER_DRAFT_PREFIX}${key}`;
      const local: ComposerDraftSyncLocal = {
        prompt: draft.prompt,
        updatedAt: null,
        deleted: !composerDraftHasUserContent(draft),
        projectId: session.projectId,
        ...(draft.activeProvider && draft.modelSelectionByProvider[draft.activeProvider]
          ? { modelSelection: draft.modelSelectionByProvider[draft.activeProvider] }
          : {}),
        ...(draft.runtimeMode ? { runtimeMode: draft.runtimeMode } : {}),
        ...(draft.interactionMode ? { interactionMode: draft.interactionMode } : {}),
      };
      const stamp = stamps.get(stampId(environmentId, syncKey));
      drafts.set(syncKey, {
        ...local,
        updatedAt: stamp?.signature === signatureOf(local) ? stamp.updatedAt : null,
      });
      continue;
    }
    const threadRef = parseScopedThreadKey(key);
    if (!threadRef || threadRef.environmentId !== environmentId || session) continue;
    const syncKey = `${THREAD_COMPOSER_DRAFT_PREFIX}${threadRef.threadId}`;
    const local: ComposerDraftSyncLocal = {
      prompt: draft.prompt,
      updatedAt: null,
      deleted: !composerDraftHasUserContent(draft),
      threadId: threadRef.threadId,
      ...(draft.activeProvider && draft.modelSelectionByProvider[draft.activeProvider]
        ? { modelSelection: draft.modelSelectionByProvider[draft.activeProvider] }
        : {}),
      ...(draft.runtimeMode ? { runtimeMode: draft.runtimeMode } : {}),
      ...(draft.interactionMode ? { interactionMode: draft.interactionMode } : {}),
    };
    const stamp = stamps.get(stampId(environmentId, syncKey));
    drafts.set(syncKey, {
      ...local,
      updatedAt: stamp?.signature === signatureOf(local) ? stamp.updatedAt : null,
    });
  }
  return drafts;
}

function applyDraft(environmentId: EnvironmentId, draft: SyncedComposerDraft): void {
  applying = true;
  try {
    const store = useComposerDraftStore.getState();
    if (draft.key.startsWith(NEW_TASK_COMPOSER_DRAFT_PREFIX)) {
      const draftId = DraftId.make(draft.key.slice(NEW_TASK_COMPOSER_DRAFT_PREFIX.length));
      if (draft.projectId && store.getDraftSession(draftId) === null && !draft.deleted) {
        store.setProjectDraftThreadId(
          { environmentId, projectId: draft.projectId as ProjectId },
          draftId,
          {
            ...(draft.runtimeMode ? { runtimeMode: draft.runtimeMode } : {}),
            ...(draft.interactionMode ? { interactionMode: draft.interactionMode } : {}),
          },
        );
      }
      store.setPrompt(draftId, draft.deleted ? "" : draft.prompt);
      if (draft.modelSelection) {
        store.setModelSelection(draftId, draft.modelSelection, { explicit: true });
      }
      const current = useComposerDraftStore.getState().getComposerDraft(draftId);
      if (draft.deleted && !composerDraftHasUserContent(current)) {
        useComposerDraftStore.getState().clearDraftThread(draftId);
      }
      return;
    }
    const threadId = ThreadId.make(draft.key.slice(THREAD_COMPOSER_DRAFT_PREFIX.length));
    store.setPrompt({ environmentId, threadId }, draft.deleted ? "" : draft.prompt);
    if (draft.modelSelection && !draft.deleted) {
      store.setModelSelection({ environmentId, threadId }, draft.modelSelection, {
        explicit: true,
      });
    }
  } finally {
    applying = false;
  }
}

async function reconcile(environmentId: EnvironmentId): Promise<void> {
  if (!readyEnvironments.has(environmentId)) return;
  const remote = remoteByEnvironment.get(environmentId) ?? new Map<string, SyncedComposerDraft>();
  const local = localDrafts(environmentId);
  const now = new Date().toISOString();
  const pushing: SyncedComposerDraft[] = [];
  const keys = new Set([...remote.keys(), ...local.keys()]);
  for (const key of keys) {
    const decision = decideComposerDraftSync({
      key: key as ComposerDraftSyncKey,
      local: local.get(key) ?? null,
      remote: remote.get(key) ?? null,
      now,
    });
    if (decision.action === "apply") {
      remember(environmentId, decision.draft);
      applyDraft(environmentId, decision.draft);
    } else if (decision.action === "push") {
      remember(environmentId, decision.draft);
      pushing.push(decision.draft);
    } else if (decision.action === "remember") {
      const remoteDraft = remote.get(key);
      if (remoteDraft) {
        remember(environmentId, { ...remoteDraft, updatedAt: decision.updatedAt });
      }
    }
  }
  if (pushing.length === 0) return;
  for (let index = 0; index < pushing.length; index += 32) {
    await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.putComposerDrafts,
      { environmentId, input: { drafts: pushing.slice(index, index + 32) } },
      { label: "composer draft sync", reportFailure: false },
    );
  }
}

function scheduleReconcile(environmentIds: ReadonlyArray<EnvironmentId>): void {
  if (pushTimer !== null) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (applying) return;
    for (const environmentId of environmentIds) void reconcile(environmentId);
  }, 600);
}

function acceptEvent(
  environmentId: EnvironmentId,
  event: { type: string; drafts?: ReadonlyArray<SyncedComposerDraft>; draft?: SyncedComposerDraft },
): void {
  const remote = remoteByEnvironment.get(environmentId) ?? new Map<string, SyncedComposerDraft>();
  if (event.type === "snapshot" && event.drafts) {
    remote.clear();
    for (const draft of event.drafts) remote.set(draft.key, draft);
    readyEnvironments.add(environmentId);
  } else if (event.type === "upsert" && event.draft) {
    remote.set(event.draft.key, event.draft);
  }
  remoteByEnvironment.set(environmentId, remote);
  void reconcile(environmentId);
}

/**
 * Keeps unsent composer text on this environment, so a desktop and the mobile
 * app show the same draft. Attachment bytes stay on the device that added them.
 */
export function startComposerDraftSync(): void {
  loadStamps();
  const unsubscribers = new Map<EnvironmentId, () => void>();
  appAtomRegistry.subscribe(
    environmentSummaries.connectedEnvironmentIdsAtom,
    (environmentIds) => {
      const connected = new Set(environmentIds);
      for (const [environmentId, unsubscribe] of unsubscribers) {
        if (!connected.has(environmentId)) {
          unsubscribe();
          unsubscribers.delete(environmentId);
          readyEnvironments.delete(environmentId);
          remoteByEnvironment.delete(environmentId);
        }
      }
      for (const environmentId of environmentIds) {
        if (unsubscribers.has(environmentId)) continue;
        unsubscribers.set(
          environmentId,
          appAtomRegistry.subscribe(
            serverEnvironment.composerDraftsLive({ environmentId, input: {} }),
            (result) => {
              const value = Option.getOrNull(AsyncResult.value(result));
              if (value === null) return;
              acceptEvent(environmentId, value);
            },
            { immediate: true },
          ),
        );
      }
    },
    { immediate: true },
  );
  useComposerDraftStore.subscribe(() => {
    if (applying) return;
    scheduleReconcile([...readyEnvironments]);
  });
}

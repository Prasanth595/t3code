import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  decideComposerDraftSync,
  NEW_TASK_COMPOSER_DRAFT_PREFIX,
  THREAD_COMPOSER_DRAFT_PREFIX,
  type ComposerDraftSyncKey,
  type ComposerDraftSyncLocal,
  type EnvironmentId,
  type SyncedComposerDraft,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";
import { serverEnvironment } from "./server";
import {
  clearComposerDraft,
  composerDraftsAtom,
  getComposerDraftSnapshot,
  isComposerDraftEmpty,
  setComposerDraftText,
  updateComposerDraftSettings,
  type ComposerDraft,
} from "./use-composer-drafts";
import { isNewTaskDraftKey } from "./new-task-draft-key";
import { isQueuedEditDraftKey } from "./queued-edit-draft-key";
import { workspaceConnections } from "./workspace";

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
}

function syncKeyFor(
  environmentId: EnvironmentId,
  key: string,
  draft: ComposerDraft,
): string | null {
  if (isQueuedEditDraftKey(key)) return null;
  if (isNewTaskDraftKey(key)) {
    return draft.project?.environmentId === environmentId ? key : null;
  }
  const threadRef = parseScopedThreadKey(key);
  if (!threadRef || threadRef.environmentId !== environmentId) return null;
  return `${THREAD_COMPOSER_DRAFT_PREFIX}${threadRef.threadId}`;
}

function localDrafts(environmentId: EnvironmentId): Map<string, ComposerDraftSyncLocal> {
  const drafts = new Map<string, ComposerDraftSyncLocal>();
  for (const [key, draft] of Object.entries(appAtomRegistry.get(composerDraftsAtom))) {
    const syncKey = syncKeyFor(environmentId, key, draft);
    if (syncKey === null) continue;
    const threadRef = parseScopedThreadKey(key);
    const local: ComposerDraftSyncLocal = {
      prompt: draft.text,
      updatedAt: null,
      deleted: isComposerDraftEmpty(draft),
      ...(draft.project?.projectId === undefined ? {} : { projectId: draft.project.projectId }),
      ...(threadRef ? { threadId: threadRef.threadId } : {}),
      ...(draft.modelSelection === undefined ? {} : { modelSelection: draft.modelSelection }),
      ...(draft.runtimeMode === undefined ? {} : { runtimeMode: draft.runtimeMode }),
      ...(draft.interactionMode === undefined ? {} : { interactionMode: draft.interactionMode }),
    };
    const stamp = stamps.get(stampId(environmentId, syncKey));
    drafts.set(syncKey, {
      ...local,
      updatedAt: stamp?.signature === signatureOf(local) ? stamp.updatedAt : null,
    });
  }
  return drafts;
}

function applyRemoteTombstone(draftKey: string): void {
  setComposerDraftText(draftKey, "");
  if (isComposerDraftEmpty(getComposerDraftSnapshot(draftKey))) {
    clearComposerDraft(draftKey);
  }
}

function applyDraft(environmentId: EnvironmentId, draft: SyncedComposerDraft): void {
  applying = true;
  try {
    if (draft.key.startsWith(NEW_TASK_COMPOSER_DRAFT_PREFIX)) {
      if (draft.deleted) {
        applyRemoteTombstone(draft.key);
        return;
      }
      setComposerDraftText(draft.key, draft.prompt);
      if (draft.projectId) {
        updateComposerDraftSettings(draft.key, {
          project: {
            environmentId,
            projectId: draft.projectId,
            createdAt: draft.updatedAt,
          },
          ...(draft.modelSelection === undefined ? {} : { modelSelection: draft.modelSelection }),
          ...(draft.runtimeMode === undefined ? {} : { runtimeMode: draft.runtimeMode }),
          ...(draft.interactionMode === undefined
            ? {}
            : { interactionMode: draft.interactionMode }),
        });
      }
      return;
    }
    const threadId = ThreadId.make(draft.key.slice(THREAD_COMPOSER_DRAFT_PREFIX.length));
    const draftKey = `${environmentId}:${threadId}`;
    if (draft.deleted) {
      applyRemoteTombstone(draftKey);
      return;
    }
    setComposerDraftText(draftKey, draft.prompt);
    updateComposerDraftSettings(draftKey, {
      ...(draft.modelSelection === undefined ? {} : { modelSelection: draft.modelSelection }),
      ...(draft.runtimeMode === undefined ? {} : { runtimeMode: draft.runtimeMode }),
      ...(draft.interactionMode === undefined ? {} : { interactionMode: draft.interactionMode }),
    });
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
  for (const key of new Set([...remote.keys(), ...local.keys()])) {
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
      if (remoteDraft) remember(environmentId, { ...remoteDraft, updatedAt: decision.updatedAt });
    }
  }
  for (let index = 0; index < pushing.length; index += 32) {
    await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.putComposerDrafts,
      { environmentId, input: { drafts: pushing.slice(index, index + 32) } },
      { label: "composer draft sync", reportFailure: false },
    );
  }
}

function acceptEvent(
  environmentId: EnvironmentId,
  event: {
    readonly type: string;
    readonly drafts?: ReadonlyArray<SyncedComposerDraft>;
    readonly draft?: SyncedComposerDraft;
  },
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

/** Shares unsent composer text with desktop clients of the same environment. */
export function installComposerDraftSync(): () => void {
  const unsubscribers = new Map<EnvironmentId, () => void>();
  const stopEnvironments = appAtomRegistry.subscribe(
    workspaceConnections.environmentsAtom,
    (environments) => {
      const connected = environments
        .filter((environment) => environment.connectionState === "connected")
        .map((environment) => environment.environmentId);
      const connectedSet = new Set(connected);
      for (const [environmentId, unsubscribe] of unsubscribers) {
        if (!connectedSet.has(environmentId)) {
          unsubscribe();
          unsubscribers.delete(environmentId);
          readyEnvironments.delete(environmentId);
          remoteByEnvironment.delete(environmentId);
        }
      }
      for (const environmentId of connected) {
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
  const stopDrafts = appAtomRegistry.subscribe(composerDraftsAtom, () => {
    if (applying) return;
    if (pushTimer !== null) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      for (const environmentId of readyEnvironments) void reconcile(environmentId);
    }, 600);
  });
  return () => {
    stopEnvironments();
    stopDrafts();
    if (pushTimer !== null) clearTimeout(pushTimer);
    for (const unsubscribe of unsubscribers.values()) unsubscribe();
  };
}

import AsyncStorage from "@react-native-async-storage/async-storage";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import { AppState } from "react-native";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentCatalog } from "../../connection/catalog";
import { environmentShell } from "../../state/shell";
import { orchestrationEnvironment } from "../../state/orchestration";
import { SerializedAsyncQueue } from "../../lib/serialized-async-queue";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { selectWorkspaceDetail } from "../workspace/workspace-detail-selection";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { supportsDurableWatchActions, watchBridge } from "./bridge";
import { createWatchInbox } from "./inbox";
import {
  EMPTY_INBOX,
  WatchRecording,
  boundWatchText,
  buildWatchSnapshot,
  prepareWatchHandoff,
  prepareWatchMutation,
  validateWatchMutation,
  validateWatchTarget,
  type InboxEntry,
  type WatchThread,
} from "./model";

const decodeRecordings = Schema.decodeUnknownSync(Schema.Array(WatchRecording));
const actionImports = new SerializedAsyncQueue();

export const watchInboxAtom = Atom.make(EMPTY_INBOX).pipe(Atom.keepAlive);
export const watchErrorAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive);
export const watchOwnerAtom = Atom.make((get) =>
  hasCloudPublicConfig() ? (get(managedRelaySessionAtom)?.accountId ?? null) : "local-device",
);

export const watchInbox = createWatchInbox({
  read: () => AsyncStorage.getItem("t3code.watch-companion.v1"),
  write: (json) => AsyncStorage.setItem("t3code.watch-companion.v1", json),
  changed: (state) => appAtomRegistry.set(watchInboxAtom, state),
  digest: (source) => digestStringAsync(CryptoDigestAlgorithm.SHA256, source),
});

export const watchThreadsAtom = Atom.make((get): ReadonlyArray<WatchThread> => {
  const owner = get(watchOwnerAtom);
  const inbox = get(watchInboxAtom);
  if (owner === null || inbox.enabledOwner !== owner) return [];
  const catalog = get(environmentCatalog.catalogValueAtom);
  const threads: WatchThread[] = [];
  for (const [environmentId, entry] of catalog.entries) {
    if (
      !entry.enabled ||
      entry.unsupportedReason ||
      (inbox.owners[environmentId] !== undefined && inbox.owners[environmentId] !== owner)
    )
      continue;
    const shell = get(environmentShell.stateValueAtom(environmentId));
    if (shell.status !== "live" || Option.isNone(shell.snapshot) || Option.isSome(shell.error))
      continue;
    const snapshot = shell.snapshot.value;
    const projectTitles = new Map(snapshot.projects.map((project) => [project.id, project.title]));
    for (const thread of snapshot.threads) {
      if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
      const request = thread.pendingRuntimeRequest;
      threads.push({
        id: thread.id,
        environmentId,
        title: boundWatchText(thread.title, 256),
        projectTitle: boundWatchText(projectTitles.get(thread.projectId) ?? "Project", 256),
        status: thread.status,
        updatedAt: DateTime.formatIso(thread.updatedAt),
        latestMessage: thread.latestVisibleMessage
          ? `${thread.latestVisibleMessage.role} message available on iPhone`
          : "",
        ...(request
          ? {
              pendingRequest: {
                id: request.id,
                kind: request.kind === "user_input" ? ("question" as const) : ("approval" as const),
                title:
                  request.kind === "user_input"
                    ? "Question needs review"
                    : "Permission needs review",
                detail:
                  "Open this thread on iPhone to review the full request. Watch choices do not submit a response.",
              },
            }
          : {}),
      });
    }
  }
  return threads.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
});

function report(error: unknown): void {
  appAtomRegistry.set(
    watchErrorAtom,
    error instanceof Error
      ? error.message
      : "Watch companion operation failed. Audio has been retained.",
  );
}

export async function refreshWatchRecordings(): Promise<void> {
  if (!watchBridge) return;
  const recordings = decodeRecordings(await watchBridge.listRecordings());
  for (const recording of recordings) {
    const state = await watchInbox.load();
    await watchInbox.ingest({
      id: `recording:${recording.id}`,
      owner: recording.environmentId ? (state.owners[recording.environmentId] ?? null) : null,
      recording,
      commandId: randomUUID(),
      state: "review",
    });
  }
}

export function refreshWatchActions(): Promise<void> {
  return actionImports.run(async () => {
    const bridge = watchBridge;
    if (!bridge) return;
    const listPendingActions = bridge.listPendingActions?.bind(bridge);
    const removeAction = bridge.removeAction?.bind(bridge);
    if (!listPendingActions || !removeAction) return;
    await watchInbox.importActions(await listPendingActions(), {
      commandId: randomUUID,
      acknowledge: removeAction,
      report,
    });
  });
}

export async function refreshWatchInbox(): Promise<void> {
  await Promise.all([refreshWatchRecordings(), refreshWatchActions()]);
}

export async function enableWatchSync(): Promise<void> {
  const owner = appAtomRegistry.get(watchOwnerAtom);
  if (!owner) throw new Error("Sign in before enabling Watch sync.");
  await watchInbox.update((current) => ({ ...current, enabledOwner: owner }));
}

export async function disableWatchSync(): Promise<void> {
  await watchInbox.update(({ enabledOwner: _enabledOwner, ...current }) => current);
}

export function installWatchCompanion(linkToPath: (path: string) => void): () => void {
  const bridge = watchBridge;
  if (!bridge) return () => {};
  openWatchComposer = linkToPath;
  let active = true;
  let lastPublished: string | null = null;
  const publications = new SerializedAsyncQueue();
  const publish = () => {
    void publications
      .run(async () => {
        if (!active) return;
        const owner = appAtomRegistry.get(watchOwnerAtom);
        const threads = appAtomRegistry.get(watchThreadsAtom).slice(0, 20);
        const inbox = appAtomRegistry.get(watchInboxAtom);
        if (owner && threads.some((thread) => inbox.owners[thread.environmentId] === undefined)) {
          await watchInbox.update((current) => {
            if (current.enabledOwner !== owner || appAtomRegistry.get(watchOwnerAtom) !== owner)
              return current;
            return {
              ...current,
              owners: {
                ...current.owners,
                ...Object.fromEntries(
                  threads
                    .filter((thread) => current.owners[thread.environmentId] === undefined)
                    .map((thread) => [thread.environmentId, owner]),
                ),
              },
            };
          });
        }
        if (!active || appAtomRegistry.get(watchOwnerAtom) !== owner) return;
        const json = buildWatchSnapshot(
          owner,
          appAtomRegistry.get(watchInboxAtom),
          appAtomRegistry.get(watchThreadsAtom),
        );
        if (json === lastPublished) return;
        await bridge.publishSnapshot(json);
        lastPublished = json;
      })
      .catch(report);
  };
  const stopSnapshot = appAtomRegistry.subscribe(watchThreadsAtom, publish);
  const stopOwner = appAtomRegistry.subscribe(watchOwnerAtom, publish);
  const recordings = bridge.addListener("onRecordingsChanged", () => {
    void refreshWatchRecordings().catch(report);
  });
  const actions = bridge.addListener("onAction", () => {
    if (!supportsDurableWatchActions) {
      report(
        new Error(
          "Rebuild the iPhone companion to enable durable Watch action recovery. Review this thread on iPhone.",
        ),
      );
      return;
    }
    void refreshWatchActions().catch(report);
  });
  const foreground = AppState.addEventListener("change", (state) => {
    if (state !== "active") return;
    lastPublished = null;
    publish();
    void refreshWatchInbox().catch(report);
  });
  void watchInbox
    .load()
    .then(() => {
      publish();
      return refreshWatchInbox();
    })
    .catch(report);
  publish();
  return () => {
    active = false;
    openWatchComposer = null;
    stopSnapshot();
    stopOwner();
    recordings.remove();
    actions.remove();
    foreground.remove();
  };
}

let openWatchComposer: ((path: string) => void) | null = null;

async function currentEntry(id: string): Promise<InboxEntry> {
  const state = await watchInbox.load();
  const entry = state.entries.find((entry) => entry.id === id);
  if (!entry) throw new Error("Watch inbox item no longer exists.");
  return entry;
}

function requireOwner(entry: InboxEntry): void {
  const owner = appAtomRegistry.get(watchOwnerAtom);
  if (owner === null || entry.owner !== owner)
    throw new Error("This recording belongs to another account or needs explicit claiming.");
}

export async function claimWatchCapture(id: string): Promise<void> {
  const owner = appAtomRegistry.get(watchOwnerAtom);
  if (!owner) throw new Error("Sign in first.");
  await watchInbox.edit(id, (entry) => {
    if (entry.owner !== null || entry.recording?.kind !== "new-thread")
      throw new Error("Only unassigned new-thread captures can be claimed.");
    return { ...entry, owner };
  });
}

export async function transcribeWatchCapture(id: string): Promise<void> {
  const entry = await currentEntry(id);
  requireOwner(entry);
  if (!entry.recording) return;
  const transcriber = getLocalVoiceTranscriber();
  if (!transcriber)
    throw new Error(
      "Local transcription is unavailable on this iPhone. The recording is retained.",
    );
  const options = { signal: new AbortController().signal };
  const prepared = await transcriber.prepare(options);
  const transcript = await prepared.transcribe(entry.recording.uri, options);
  requireOwner(entry);
  if (!transcript.trim()) throw new Error("No speech was found. The recording is retained.");
  await watchInbox.edit(id, (current) => ({ ...current, transcript }));
}

export async function handoffWatchCapture(id: string): Promise<void> {
  const entry = await currentEntry(id);
  requireOwner(entry);
  if (entry.recording?.kind === "reply")
    validateWatchTarget(
      entry,
      appAtomRegistry.get(watchOwnerAtom),
      appAtomRegistry.get(watchThreadsAtom),
    );
  if (!openWatchComposer) throw new Error("Navigation is not ready.");
  const payload = prepareWatchHandoff(entry);
  await watchInbox.edit(id, (current) => ({ ...current, payload, state: "handed-off" }));
  requireOwner(entry);
  openWatchComposer(payload);
}

export async function reviewWatchAction(id: string): Promise<void> {
  const entry = await currentEntry(id);
  const thread = validateWatchTarget(
    entry,
    appAtomRegistry.get(watchOwnerAtom),
    appAtomRegistry.get(watchThreadsAtom),
    false,
  );
  if (!rootNavigationRef.isReady()) throw new Error("Navigation is not ready.");
  rootNavigationRef.dispatch(
    selectWorkspaceDetail({
      name: "Thread",
      params: {
        environmentId: EnvironmentId.make(thread.environmentId),
        threadId: ThreadId.make(thread.id),
      },
    }),
  );
}

export async function confirmWatchMutation(id: string): Promise<void> {
  const entry = await currentEntry(id);
  if (entry.state === "completed") return;
  const thread = validateWatchTarget(
    entry,
    appAtomRegistry.get(watchOwnerAtom),
    appAtomRegistry.get(watchThreadsAtom),
  );
  const retry = entry.state === "prepared" && entry.payload !== undefined;
  const command = prepareWatchMutation(entry, thread);
  if (!retry) {
    const payload = JSON.stringify(command);
    await watchInbox.edit(id, (current) => ({ ...current, payload, state: "prepared" }));
  }
  await watchInbox.dispatch(
    id,
    () => appAtomRegistry.get(watchOwnerAtom),
    async (stored) => {
      const current = validateWatchTarget(
        stored,
        appAtomRegistry.get(watchOwnerAtom),
        appAtomRegistry.get(watchThreadsAtom),
      );
      if (!retry) validateWatchMutation(stored, current);
      const result = await runAtomCommand(
        appAtomRegistry,
        orchestrationEnvironment.v2.dispatchCommand,
        {
          environmentId: EnvironmentId.make(current.environmentId),
          input: prepareWatchMutation(stored, current),
        },
        { reportFailure: false },
      );
      if (result._tag !== "Success")
        throw new Error(
          "The server did not confirm the action. Its command ID is retained; retry only after review, or open the thread.",
        );
    },
  );
}

export async function deleteWatchItem(id: string): Promise<void> {
  const entry = await currentEntry(id);
  requireOwner(entry);
  if (entry.recording) {
    if (!watchBridge) throw new Error("The native Watch bridge is unavailable.");
    await watchBridge.removeRecording(entry.recording.id);
  }
  await watchInbox.dismiss(id);
}

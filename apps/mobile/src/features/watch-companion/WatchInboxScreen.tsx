import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { orchestrationEnvironment } from "../../state/orchestration";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { supportsDurableWatchActions, watchBridge } from "./bridge";
import { type InboxEntry } from "./model";
import {
  claimWatchCapture,
  confirmWatchMutation,
  deleteWatchItem,
  disableWatchSync,
  enableWatchSync,
  handoffWatchCapture,
  refreshWatchInbox,
  reviewWatchAction,
  transcribeWatchCapture,
  watchErrorAtom,
  watchInboxAtom,
  watchOwnerAtom,
  watchThreadsAtom,
} from "./service";

export function WatchInboxScreen() {
  const inbox = useAtomValue(watchInboxAtom);
  const owner = useAtomValue(watchOwnerAtom);
  const error = useAtomValue(watchErrorAtom);
  const [busy, setBusy] = useState(false);
  const enabled = owner !== null && inbox.enabledOwner === owner;
  const entries = inbox.entries.filter(
    (entry) =>
      entry.state !== "dismissed" &&
      ((entry.owner === owner && owner !== null) ||
        (entry.owner === null && entry.recording?.kind === "new-thread")),
  );
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    try {
      await operation();
    } catch (error) {
      Dialog.alert(
        "Watch companion",
        error instanceof Error ? error.message : "Could not complete this operation.",
      );
    }
    setBusy(false);
  };
  return (
    <SettingsScreen title="Watch companion">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 px-5 py-4"
      >
        <AppText className="text-foreground-muted">
          Review Watch recordings and requests. Nothing sends until you confirm.
        </AppText>
        {!watchBridge ? (
          <AppText>Watch support is not included in this app build.</AppText>
        ) : (
          <View className="gap-3">
            <AppText>
              Share thread titles and request types with Watch. Messages stay on iPhone.
            </AppText>
            <Button
              label={enabled ? "Turn off Watch sync" : "Enable Watch sync"}
              disabled={busy || owner === null}
              onPress={() => {
                void run(enabled ? disableWatchSync : enableWatchSync);
              }}
            />
            <Button
              label="Refresh inbox"
              loading={busy}
              disabled={busy}
              onPress={() => {
                void run(refreshWatchInbox);
              }}
            />
          </View>
        )}
        {owner === null ? <AppText>Sign in to enable sync and review recordings.</AppText> : null}
        {watchBridge && !supportsDurableWatchActions ? (
          <AppText>
            Update the iPhone app to review Watch thread actions. Recording review is available.
          </AppText>
        ) : null}
        {error ? <AppText accessibilityRole="alert">{error}</AppText> : null}
        {entries.length === 0 ? (
          <AppText>No recordings or requests. Record an idea on Watch to get started.</AppText>
        ) : null}
        {entries.map((entry) => (
          <WatchInboxItem key={entry.id} entry={entry} />
        ))}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function WatchInboxItem({ entry }: { readonly entry: InboxEntry }) {
  const [busy, setBusy] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const threads = useAtomValue(watchThreadsAtom);
  const thread = threads.find(
    (thread) =>
      thread.id === (entry.action ?? entry.recording)?.threadId &&
      thread.environmentId === (entry.action ?? entry.recording)?.environmentId,
  );
  const canOperate = useAtomValue(
    orchestrationEnvironment.v2.dispatchCommand.permissionAtom(
      entry.action ? EnvironmentId.make(entry.action.environmentId) : null,
      { type: entry.action?.kind === "settle" ? "thread.settle" : "thread.unsettle" },
    ),
  );
  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await operation();
    } catch (error) {
      Dialog.alert(
        "Watch item retained",
        error instanceof Error ? error.message : "Try again. Nothing was automatically sent.",
      );
    }
    setBusy(false);
  };
  const claim = () =>
    Dialog.alert(
      "Claim this recording?",
      "New Watch captures have no account identity. Only claim this audio if you recorded it for the account currently signed in.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Claim recording",
          onPress: () => {
            void run(() => claimWatchCapture(entry.id));
          },
        },
      ],
    );
  const mutation = () =>
    Dialog.alert(
      entry.action?.kind === "settle" ? "Mark this thread done?" : "Reopen this thread?",
      `${thread?.title ?? "Thread unavailable"}\n${thread?.projectTitle ?? ""}\nEnvironment: ${entry.action?.environmentId}\nUpdated: ${thread?.updatedAt ?? "unavailable"}\n\n${entry.action?.kind === "settle" ? "Marking done also stops pull-request watching and cancels automatic queued wakes and nonblocking questions. Running work and blocking requests are rejected by the server." : "This changes the thread to active; it does not start an agent turn."}`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Confirm on iPhone",
          onPress: () => {
            void run(() => confirmWatchMutation(entry.id));
          },
        },
      ],
    );
  const remove = () =>
    Dialog.alert(
      "Delete Watch inbox item?",
      "This deletes the recording and transcript from this iPhone. Copies already sent in a thread or still on Watch are not deleted.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void run(() => deleteWatchItem(entry.id));
          },
        },
      ],
    );
  return (
    <View className="gap-3 rounded-2xl bg-grouped-card p-4">
      <AppText className="font-t3-semibold">
        {entry.recording
          ? entry.recording.kind === "reply"
            ? "Voice reply"
            : "New-thread recording"
          : entry.action?.kind === "approval"
            ? "Permission review"
            : entry.action?.kind === "answer"
              ? "Question review"
              : entry.action?.kind === "settle"
                ? "Mark done request"
                : "Reopen request"}
      </AppText>
      {entry.recording ? (
        <AppText className="text-foreground-muted">
          {Number.isNaN(Date.parse(entry.recording.createdAt))
            ? "Date unavailable"
            : new Date(entry.recording.createdAt).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
        </AppText>
      ) : null}
      {thread ? (
        <AppText>
          {thread.projectTitle} · {thread.title} · {thread.status}
        </AppText>
      ) : null}
      {entry.state === "completed" ? <AppText>Confirmed by server.</AppText> : null}
      {entry.state === "prepared" ? (
        <AppText>
          We could not confirm the result. Check the thread before retrying. Nothing retries in the
          background.
        </AppText>
      ) : null}
      {entry.state === "handed-off" ? <AppText>Opened in composer. Not sent.</AppText> : null}
      {entry.owner === null ? (
        <Button label="Claim new recording" disabled={busy} onPress={claim} />
      ) : entry.recording ? (
        <View className="gap-3">
          {entry.transcript ? (
            <>
              <AppText selectable>{entry.transcript}</AppText>
              <Button
                label="Review in composer"
                disabled={busy}
                onPress={() => {
                  void run(() => handoffWatchCapture(entry.id));
                }}
              />
              <Button
                label="Copy transcript"
                disabled={busy}
                onPress={() => {
                  void run(async () => {
                    if (
                      !(await tryCopyTextWithHaptic(entry.transcript ?? "", {
                        target: "Watch transcript",
                      }))
                    )
                      throw new Error("Could not copy the transcript.");
                  });
                }}
              />
            </>
          ) : (
            <Button
              label={transcribing ? "Transcribing…" : "Transcribe on iPhone"}
              loading={transcribing}
              disabled={busy}
              onPress={() => {
                void run(async () => {
                  setTranscribing(true);
                  try {
                    await transcribeWatchCapture(entry.id);
                  } finally {
                    setTranscribing(false);
                  }
                });
              }}
            />
          )}
        </View>
      ) : (
        <View className="gap-3">
          {entry.action?.answer ? (
            <AppText selectable>
              Watch suggested answer (not submitted): {entry.action.answer}
            </AppText>
          ) : null}
          <Button
            label="Review current thread on iPhone"
            disabled={busy || !thread}
            onPress={() => {
              void run(() => reviewWatchAction(entry.id));
            }}
          />
          {(entry.action?.kind === "settle" || entry.action?.kind === "reopen") &&
          entry.state !== "completed" ? (
            <Button
              label={entry.action.kind === "settle" ? "Review marking done" : "Review reopening"}
              disabled={busy || !thread || !canOperate}
              onPress={mutation}
            />
          ) : null}
        </View>
      )}
      {entry.owner !== null ? (
        <Button label="Delete inbox item" tone="text" disabled={busy} onPress={remove} />
      ) : null}
    </View>
  );
}

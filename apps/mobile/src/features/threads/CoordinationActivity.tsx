import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  type ChatAttachment,
  type CoordinationEntry,
  type CoordinationKind,
  type CoordinationPreferencesInput,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  coordinationPresenceLabel,
  coordinationTopics,
  mergeCoordinationEntries,
} from "@t3tools/client-runtime/state/coordination";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Linking, Pressable, ScrollView, View } from "react-native";
import { Sheet } from "../../components/ui/Sheet";
import { AppText, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useRefreshAssetUrl } from "../../state/assets";
import { coordinationEnvironment } from "../../state/coordination";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";

type ActivityProps = { environmentId: EnvironmentId; projectId: ProjectId; threadId: ThreadId };

export function CoordinationActivity(props: ActivityProps) {
  const [open, setOpen] = useState(false);
  const inbox = useEnvironmentQuery(
    coordinationEnvironment.snapshot({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, threadId: props.threadId, limit: 100 },
    }),
  );
  const unread = inbox.data?.unreadCount ?? 0;
  return (
    <>
      <View className="items-end px-3 py-1">
        <Button
          tone="text"
          label={`Activity${unread ? ` (${unread} unread topics)` : ""}`}
          onPress={() => setOpen(true)}
        />
      </View>
      {open ? (
        <Sheet title="Activity" onClose={() => setOpen(false)}>
          <ActivityContent {...props} />
        </Sheet>
      ) : null}
    </>
  );
}

function ActivityContent({ environmentId, projectId, threadId }: ActivityProps) {
  const [scope, setScope] = useState<"thread" | "project">("thread");
  const [showThreads, setShowThreads] = useState(false);
  const [olderEntries, setOlderEntries] = useState<CoordinationEntry[]>([]);
  const [olderCursor, setOlderCursor] = useState<number | null | undefined>(undefined);
  const [topic, setTopic] = useState("");
  const [text, setText] = useState("");
  const [kind, setKind] = useState<CoordinationKind>("update");
  const [target, setTarget] = useState<ThreadId | null>(null);
  const [reply, setReply] = useState<CoordinationEntry | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inbox = useEnvironmentQuery(
    coordinationEnvironment.snapshot({ environmentId, input: { projectId, threadId, limit: 100 } }),
  );
  const board = useEnvironmentQuery(
    scope === "project"
      ? coordinationEnvironment.snapshot({ environmentId, input: { projectId, limit: 100 } })
      : null,
  );
  const query = scope === "thread" ? inbox : board;
  const snapshot = query.data;
  const preferences = inbox.data?.preferences;
  const topics = useMemo(
    () =>
      coordinationTopics(mergeCoordinationEntries(olderEntries, snapshot?.entries ?? []), threadId),
    [olderEntries, snapshot?.entries, threadId],
  );
  const replyBlocked =
    reply !== null &&
    !topics.some((group) => group.rows.some((row) => row.entry.id === reply.id && row.canReply));
  const liveEntries = snapshot?.entries;
  // Once paging, retain the live page as it moves so new posts cannot create a gap in history.
  useEffect(() => {
    if (olderCursor === undefined || !liveEntries) return;
    setOlderEntries((entries) => mergeCoordinationEntries(entries, liveEntries));
  }, [liveEntries, olderCursor]);
  const nextBeforeRevision = olderCursor === undefined ? snapshot?.nextBeforeRevision : olderCursor;
  const loadOlder = useAtomCommand(coordinationEnvironment.loadOlder, { reportFailure: false });
  const post = useAtomCommand(coordinationEnvironment.post, { reportFailure: false });
  const handle = useAtomCommand(coordinationEnvironment.handle, { reportFailure: false });
  const resolve = useAtomCommand(coordinationEnvironment.resolve, { reportFailure: false });
  const savePreferences = useAtomCommand(coordinationEnvironment.preferences, {
    reportFailure: false,
  });
  const canPost = useAtomValue(coordinationEnvironment.post.permissionAtom(environmentId));
  const canHandle = useAtomValue(coordinationEnvironment.handle.permissionAtom(environmentId));
  const canResolve = useAtomValue(coordinationEnvironment.resolve.permissionAtom(environmentId));
  const canSetPreferences = useAtomValue(
    coordinationEnvironment.preferences.permissionAtom(environmentId),
  );
  const threads = snapshot?.threads ?? [];
  const threadTitle = (id: ThreadId | null) =>
    id === null ? "Agent" : (threads.find((thread) => thread.threadId === id)?.title ?? "Thread");
  async function perform<A, E>(
    action: () => Promise<AtomCommandResult<A, E>>,
    onSuccess?: (value: A) => void,
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      if (result._tag === "Success") onSuccess?.(result.value);
      else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error ? failure.message : "Could not save activity. Try again.",
        );
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  function handleRequest(
    action: "handle_now" | "handle_after" | "return_to_task",
    entryId?: string,
  ) {
    return perform(
      () =>
        handle({
          environmentId,
          input: { projectId, threadId, ...(entryId ? { entryId } : {}), action },
        }),
      () =>
        setNotice(
          action === "handle_after"
            ? "Queued for this thread after its current work."
            : action === "return_to_task"
              ? "Asked this thread to return to its original task."
              : "Sent to this thread to handle now.",
        ),
    );
  }
  function updatePreferences(update: Omit<CoordinationPreferencesInput, "projectId" | "threadId">) {
    return perform(() =>
      savePreferences({ environmentId, input: { projectId, threadId, ...update } }),
    );
  }
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled">
      <View className="gap-4 p-4">
        <View className="flex-row flex-wrap gap-2">
          {(["thread", "project"] as const).map((value) => (
            <Button
              key={value}
              label={value === "thread" ? "This thread" : "Project"}
              tone={scope === value ? "primary" : "secondary"}
              disabled={pending}
              onPress={() => {
                setScope(value);
                setOlderEntries([]);
                setOlderCursor(undefined);
              }}
            />
          ))}
        </View>
        <View className="flex-row flex-wrap gap-2">
          <Button
            label="Mark read"
            tone="text"
            disabled={pending || !canSetPreferences || !inbox.data?.unreadCount}
            onPress={() => void updatePreferences({ readRevision: inbox.data?.revision ?? 0 })}
          />
          <Button
            label={preferences?.paused ? "Resume delivery" : "Pause delivery"}
            tone="text"
            disabled={pending || !canSetPreferences || !preferences}
            onPress={() => void updatePreferences({ paused: !preferences?.paused })}
          />
          <Button
            label="Return to original task"
            tone="text"
            disabled={pending || !canHandle}
            onPress={() => void handleRequest("return_to_task")}
          />
        </View>
        <AppText className="text-sm text-foreground-muted">
          Handle actions send the request to this thread.
        </AppText>
        {notice ? (
          <AppText accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
            {notice}
          </AppText>
        ) : null}
        {preferences?.paused ? (
          <AppText className="text-sm text-foreground-muted">
            Automatic delivery to this thread is paused. Activity stays here.
          </AppText>
        ) : null}
        {query.error ? (
          <View>
            <AppText accessibilityRole="alert">{query.error}</AppText>
            <Button label="Retry" onPress={query.refresh} />
          </View>
        ) : null}
        {!snapshot && !query.error ? <AppText>Loading activity...</AppText> : null}
        {snapshot ? (
          <View className="gap-2">
            <Button
              label={`${showThreads ? "Hide" : "Show"} threads (${threads.length})`}
              tone="text"
              onPress={() => setShowThreads((value) => !value)}
            />
            {showThreads
              ? threads.map((thread) => (
                  <View key={thread.threadId}>
                    <AppText className="font-t3-medium">
                      {thread.title}
                      {thread.threadId === threadId ? " (this thread)" : ""}
                    </AppText>
                    <AppText className="text-xs text-foreground-muted">
                      {coordinationPresenceLabel(thread.status)} ·{" "}
                      {new Date(thread.updatedAt).toLocaleString()}
                    </AppText>
                  </View>
                ))
              : null}
          </View>
        ) : null}
        {snapshot && topics.length === 0 ? (
          <AppText className="text-foreground-muted">
            No activity yet. Post an update or ask another thread for help.
          </AppText>
        ) : null}
        {topics.map((group) => {
          const muted = preferences?.mutedTopics.includes(group.topic) ?? false;
          return (
            <View key={group.topic} className="gap-3 rounded-2xl border border-input-border p-3">
              <AppText accessibilityRole="header" className="font-t3-medium">
                {group.topic}
              </AppText>
              <Button
                label={muted ? "Unmute topic" : "Mute topic"}
                tone="text"
                disabled={pending || !canSetPreferences || !preferences}
                onPress={() =>
                  void updatePreferences({
                    mutedTopics: muted
                      ? (preferences?.mutedTopics.filter((value) => value !== group.topic) ?? [])
                      : [...(preferences?.mutedTopics ?? []), group.topic],
                  })
                }
              />
              {group.rows.map(({ entry, depth, canReply }) => (
                <View
                  key={entry.id}
                  className={depth ? "ml-3 gap-2 border-l border-input-border pl-3" : "gap-2"}
                >
                  <AppText className="text-xs text-foreground-muted">
                    {entry.kind} ·{" "}
                    {entry.createdBy === "user" ? "You" : threadTitle(entry.senderThreadId)} →{" "}
                    {entry.targetThreadId ? threadTitle(entry.targetThreadId) : "Project"}
                    {entry.updateCount > 1 ? ` · ${entry.updateCount} updates` : ""}
                    {entry.status !== "open" ? ` · ${entry.status}` : ""}
                  </AppText>
                  <AppText className="text-xs text-foreground-muted">
                    {new Date(entry.updatedAt).toLocaleString()}
                  </AppText>
                  <AppText selectable>{entry.text}</AppText>
                  {entry.attachments.map((attachment) => (
                    <ActivityAttachment
                      key={attachment.id}
                      environmentId={environmentId}
                      attachment={attachment}
                    />
                  ))}
                  <View className="flex-row flex-wrap gap-1">
                    <Button
                      label="Reply"
                      tone="text"
                      disabled={pending || !canPost || !canReply}
                      onPress={() => {
                        setReply(entry);
                        setTopic(entry.topic);
                        setTarget(
                          entry.senderThreadId === threadId
                            ? entry.targetThreadId
                            : entry.senderThreadId,
                        );
                        setKind("update");
                      }}
                    />
                    {entry.replyToId === null && entry.status === "open" ? (
                      <>
                        <Button
                          label="Handle now"
                          tone="secondary"
                          disabled={pending || !canHandle || !canReply}
                          onPress={() => void handleRequest("handle_now", entry.id)}
                        />
                        <Button
                          label="After current work"
                          tone="text"
                          disabled={pending || !canHandle || !canReply}
                          onPress={() => void handleRequest("handle_after", entry.id)}
                        />

                        <Button
                          label="Resolve"
                          tone="text"
                          disabled={pending || !canResolve}
                          onPress={() =>
                            void perform(() =>
                              resolve({
                                environmentId,
                                input: {
                                  projectId,
                                  entryId: entry.id,
                                  status: "resolved",
                                  actorThreadId: threadId,
                                },
                              }),
                            )
                          }
                        />
                        {entry.kind !== "update" ? (
                          <Button
                            label="Decline"
                            tone="text"
                            disabled={pending || !canResolve}
                            onPress={() =>
                              void perform(() =>
                                resolve({
                                  environmentId,
                                  input: {
                                    projectId,
                                    entryId: entry.id,
                                    status: "declined",
                                    actorThreadId: threadId,
                                  },
                                }),
                              )
                            }
                          />
                        ) : null}
                      </>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          );
        })}
        {nextBeforeRevision !== null && nextBeforeRevision !== undefined ? (
          <Button
            label="Load older"
            disabled={pending}
            onPress={() =>
              void perform(
                () =>
                  loadOlder({
                    environmentId,
                    input: {
                      projectId,
                      ...(scope === "thread" ? { threadId } : {}),
                      beforeRevision: nextBeforeRevision,
                      limit: 100,
                    },
                  }),
                (page) => {
                  setOlderEntries((entries) =>
                    mergeCoordinationEntries(
                      entries,
                      mergeCoordinationEntries(snapshot?.entries ?? [], page.entries),
                    ),
                  );
                  setOlderCursor(page.nextBeforeRevision);
                },
              )
            }
          />
        ) : null}
        <View className="gap-3 border-t border-input-border pt-4">
          {reply ? (
            <View>
              <AppText>
                Replying to {reply.createdBy === "user" ? "You" : threadTitle(reply.senderThreadId)}{" "}
                on {reply.topic}
              </AppText>
              <Button label="Cancel reply" tone="text" onPress={() => setReply(null)} />
            </View>
          ) : null}
          {!reply ? (
            <>
              <View className="flex-row flex-wrap gap-2">
                {(["update", "request", "blocker"] as const).map((value) => (
                  <Button
                    key={value}
                    label={
                      value === "update" ? "Update" : value === "request" ? "Request" : "Blocker"
                    }
                    tone={kind === value ? "primary" : "secondary"}
                    disabled={pending || !canPost}
                    onPress={() => setKind(value)}
                  />
                ))}
              </View>
              <AppText className="text-sm">
                Send to: {target ? threadTitle(target) : "Project"}
              </AppText>
              <ScrollView horizontal>
                <View className="flex-row gap-2">
                  <Button
                    label="Project"
                    tone={target === null ? "primary" : "secondary"}
                    disabled={pending || !canPost}
                    onPress={() => setTarget(null)}
                  />
                  {threads
                    .filter((thread) => thread.threadId !== threadId)
                    .map((thread) => (
                      <Button
                        key={thread.threadId}
                        label={thread.title}
                        tone={target === thread.threadId ? "primary" : "secondary"}
                        disabled={pending || !canPost}
                        onPress={() => setTarget(thread.threadId)}
                      />
                    ))}
                </View>
              </ScrollView>
            </>
          ) : null}
          <AppTextInput
            accessibilityLabel="Topic"
            placeholder="Topic"
            value={topic}
            maxLength={160}
            editable={!pending && canPost && reply === null}
            onChangeText={setTopic}
          />
          <AppTextInput
            accessibilityLabel="Activity message"
            placeholder="Share an update, request, or blocker..."
            value={text}
            maxLength={16000}
            multiline
            editable={!pending && canPost}
            onChangeText={setText}
          />
          {replyBlocked ? (
            <AppText accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
              This discussion is closed or its original post is not loaded. Load older activity or
              cancel the reply.
            </AppText>
          ) : null}
          {error ? (
            <AppText accessibilityRole="alert" className="text-danger">
              {error}
            </AppText>
          ) : null}
          <AppText className="text-xs text-foreground-muted">
            Posting does not start an agent turn.
          </AppText>
          <Button
            label={pending ? "Saving..." : reply ? "Reply" : "Post"}
            tone="primary"
            disabled={pending || !canPost || replyBlocked || !topic.trim() || !text.trim()}
            onPress={() => {
              if (!topic.trim() || !text.trim() || !canPost || replyBlocked) return;
              void perform(
                () =>
                  post({
                    environmentId,
                    input: {
                      commandId: CommandId.make(uuidv4()),
                      projectId,
                      senderThreadId: threadId,
                      ...(target ? { targetThreadId: target } : {}),
                      ...(reply ? { replyToId: reply.id } : {}),
                      topic: topic.trim(),
                      kind,
                      text: text.trim(),
                    },
                  }),
                () => {
                  setText("");
                  setTopic("");
                  setReply(null);
                },
              );
            }}
          />
        </View>
      </View>
    </ScrollView>
  );
}

function ActivityAttachment({
  environmentId,
  attachment,
}: {
  environmentId: EnvironmentId;
  attachment: ChatAttachment;
}) {
  const supported = attachment.type === "image" || attachment.type === "file";
  const refreshUrl = useRefreshAssetUrl(
    environmentId,
    supported
      ? {
          _tag: "attachment",
          attachmentId: attachment.id,
          fileName: attachment.name,
          mimeType: attachment.mimeType,
        }
      : null,
  );
  const openingRef = useRef(false);
  const [opening, setOpening] = useState(false);
  async function openAttachment() {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    try {
      const url = await refreshUrl();
      if (!url) throw new Error("The attachment is unavailable. Reconnect and try again.");
      await Linking.openURL(url);
    } catch (error) {
      Alert.alert(
        "Could not open attachment",
        error instanceof Error ? error.message : "Try again.",
      );
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  }
  if (!supported)
    return (
      <AppText className="text-xs text-foreground-muted">
        {attachment.name} (unsupported attachment)
      </AppText>
    );
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${attachment.name}`}
      accessibilityState={{ disabled: opening, busy: opening }}
      disabled={opening}
      onPress={() => void openAttachment()}
      className="min-h-11 justify-center"
    >
      <AppText className="text-sm text-foreground underline">
        {attachment.name}
        {opening ? " (opening...)" : ""}
      </AppText>
    </Pressable>
  );
}

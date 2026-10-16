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
  coordinationMentionQuery,
  hasCoordinationMention,
  coordinationPostContent,
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
import { Menu } from "../../components/ui/Menu";
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
  const [scope, setScope] = useState<"thread" | "project">("project");
  const [showThreads, setShowThreads] = useState(false);
  const [olderEntries, setOlderEntries] = useState<CoordinationEntry[]>([]);
  const [olderCursor, setOlderCursor] = useState<number | null | undefined>(undefined);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<CoordinationKind>("update");
  const [target, setTarget] = useState<ThreadId | null>(null);
  const [caret, setCaret] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [reply, setReply] = useState<CoordinationEntry | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const replyText = reply === null ? "" : (replyDrafts[reply.id] ?? "");
  function setReplyText(text: string) {
    if (reply !== null) setReplyDrafts((drafts) => ({ ...drafts, [reply.id]: text }));
  }
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
  const mention = coordinationMentionQuery(text, caret, threads);
  const mentionPending = hasCoordinationMention(text, threads);
  const targetMissing = target !== null && !threads.some((thread) => thread.threadId === target);
  const mentionCandidates = mention
    ? threads
        .filter((item) => item.title.toLowerCase().includes(mention.query.toLowerCase()))
        .slice(0, 5)
    : [];
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
    root?: CoordinationEntry,
  ) {
    return perform(
      () =>
        handle({
          environmentId,
          input: {
            projectId,
            threadId,
            ...(root ? { entryId: root.id, entryRevision: root.revision } : {}),
            action,
          },
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
        <Menu
          title="Activity feed"
          actions={[
            {
              id: "project",
              title: "Project feed",
              state: scope === "project" ? "on" : "off",
              attributes: { disabled: pending },
            },
            {
              id: "thread",
              title: "For this thread",
              state: scope === "thread" ? "on" : "off",
              attributes: { disabled: pending },
            },
          ]}
          onPressAction={({ nativeEvent }) => {
            if (pending) return;
            setScope(nativeEvent.event === "thread" ? "thread" : "project");
            setReply(null);
            setOlderEntries([]);
            setOlderCursor(undefined);
          }}
        >
          <Button
            label={scope === "project" ? "Project feed⌄" : "For this thread⌄"}
            tone="secondary"
            disabled={pending}
            onPress={() => {}}
          />
        </Menu>
        <Menu
          title="Activity options"
          actions={[
            {
              id: "read",
              title: "Mark read",
              attributes: { disabled: pending || !canSetPreferences || !inbox.data?.unreadCount },
            },
            {
              id: "pause",
              title: preferences?.paused ? "Resume delivery" : "Pause delivery",
              attributes: { disabled: pending || !canSetPreferences || !preferences },
            },
            {
              id: "return",
              title: "Return to original task",
              attributes: { disabled: pending || !canHandle },
            },
          ]}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "read")
              void updatePreferences({ readRevision: inbox.data?.revision ?? 0 });
            else if (nativeEvent.event === "pause")
              void updatePreferences({ paused: !preferences?.paused });
            else if (nativeEvent.event === "return") void handleRequest("return_to_task");
          }}
        >
          <Button label="Options" tone="text" disabled={pending} onPress={() => {}} />
        </Menu>
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
            <View key={group.topic} className="gap-3">
              {group.rows
                .filter(
                  ({ entry }) =>
                    entry.replyToId === null ||
                    entry.id === reply?.id ||
                    !group.rows.some((row) => row.entry.id === entry.replyToId) ||
                    expanded.has(
                      group.rows.find((row) => row.entry.id === entry.replyToId)?.entry.id ?? "",
                    ),
                )
                .map(({ entry, depth, canReply }) => (
                  <View
                    key={entry.id}
                    className={
                      depth
                        ? "ml-3 gap-2 border-l border-input-border pl-3"
                        : "gap-2 rounded-2xl border border-input-border p-3"
                    }
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
                      {entry.replyToId === null &&
                      group.rows.some((row) => row.entry.replyToId === entry.id) ? (
                        <Button
                          label={`${expanded.has(entry.id) ? "Hide" : "Show"} ${group.rows.filter((row) => row.entry.replyToId === entry.id).length} replies`}
                          tone="text"
                          onPress={() =>
                            setExpanded((value) => {
                              const next = new Set(value);
                              if (next.has(entry.id)) next.delete(entry.id);
                              else next.add(entry.id);
                              return next;
                            })
                          }
                        />
                      ) : null}
                      <Button
                        label="Reply"
                        tone="text"
                        disabled={pending || !canPost || !canReply}
                        onPress={() => {
                          setReply(
                            entry.replyToId === null
                              ? entry
                              : (group.rows.find((row) => row.entry.id === entry.replyToId)
                                  ?.entry ?? entry),
                          );
                        }}
                      />
                      {entry.replyToId === null ? (
                        <Menu
                          title="Activity actions"
                          actions={[
                            {
                              id: "resolve",
                              title: "Resolve",
                              attributes: { disabled: pending || !canResolve || !canReply },
                            },
                            ...(entry.kind !== "update"
                              ? [
                                  {
                                    id: "decline",
                                    title: "Decline",
                                    attributes: { disabled: pending || !canResolve || !canReply },
                                  },
                                ]
                              : []),
                            {
                              id: "mute",
                              title: muted ? "Unmute topic" : "Mute topic",
                              attributes: {
                                disabled: pending || !canSetPreferences || !preferences,
                              },
                            },
                          ]}
                          onPressAction={({ nativeEvent }) => {
                            if (pending) return;
                            if (nativeEvent.event === "mute") {
                              if (!canSetPreferences || !preferences) return;
                              void updatePreferences({
                                mutedTopics: muted
                                  ? preferences.mutedTopics.filter((topic) => topic !== entry.topic)
                                  : [...preferences.mutedTopics, entry.topic],
                              });
                            } else if (
                              canResolve &&
                              canReply &&
                              (nativeEvent.event === "resolve" || nativeEvent.event === "decline")
                            ) {
                              void perform(() =>
                                resolve({
                                  environmentId,
                                  input: {
                                    projectId,
                                    entryId: entry.id,
                                    status:
                                      nativeEvent.event === "resolve" ? "resolved" : "declined",
                                    actorThreadId: threadId,
                                  },
                                }),
                              );
                            }
                          }}
                        >
                          <Button label="•••" tone="text" disabled={pending} onPress={() => {}} />
                        </Menu>
                      ) : null}
                      {entry.replyToId === null &&
                      entry.kind !== "update" &&
                      entry.status === "open" ? (
                        <>
                          <Button
                            label="Ask this agent to handle it"
                            tone="secondary"
                            disabled={pending || !canHandle || !canReply}
                            onPress={() => void handleRequest("handle_after", entry)}
                          />
                          <Menu
                            title="Handle timing"
                            actions={[
                              {
                                id: "now",
                                title: "Handle now",
                                attributes: { disabled: pending || !canHandle || !canReply },
                              },
                            ]}
                            onPressAction={() => {
                              if (!pending && canHandle && canReply)
                                void handleRequest("handle_now", entry);
                            }}
                          >
                            <Button
                              label="⌄"
                              accessibilityHint="Handle timing"
                              tone="text"
                              disabled={pending || !canHandle || !canReply}
                              onPress={() => {}}
                            />
                          </Menu>
                        </>
                      ) : null}
                    </View>
                    {reply?.id === entry.id ? (
                      <View className="gap-2 rounded-xl bg-subtle p-3">
                        <View className="flex-row items-center justify-between">
                          <AppText>Replying in this discussion</AppText>
                          <Button
                            label="Cancel"
                            tone="text"
                            disabled={pending}
                            onPress={() => {
                              setReply(null);
                            }}
                          />
                        </View>
                        <AppTextInput
                          autoFocus
                          accessibilityLabel="Reply message"
                          placeholder="Write a reply..."
                          value={replyText}
                          onChangeText={setReplyText}
                          multiline
                          maxLength={16000}
                          editable={!pending && canPost && canReply}
                        />
                        {error ? <AppText className="text-danger">{error}</AppText> : null}
                        <Button
                          label={pending ? "Saving..." : "Reply"}
                          tone="primary"
                          disabled={pending || !canPost || !canReply || !replyText.trim()}
                          onPress={() => {
                            if (!replyText.trim() || !canPost || !canReply) return;
                            void perform(
                              () =>
                                post({
                                  environmentId,
                                  input: {
                                    commandId: CommandId.make(uuidv4()),
                                    projectId,
                                    senderThreadId: threadId,
                                    ...coordinationPostContent({
                                      text: replyText,
                                      kind: "update",
                                      reply: entry,
                                    }),
                                  },
                                }),
                              () => {
                                setReply(null);
                                setReplyText("");
                              },
                            );
                          }}
                        />
                      </View>
                    ) : null}
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
          <Menu
            title="Post type"
            actions={[
              {
                id: "update",
                title: "Update",
                state: kind === "update" ? "on" : "off",
                attributes: { disabled: pending || !canPost },
              },
              {
                id: "request",
                title: "Request help",
                state: kind === "request" ? "on" : "off",
                attributes: { disabled: pending || !canPost },
              },
              {
                id: "blocker",
                title: "Blocked",
                state: kind === "blocker" ? "on" : "off",
                attributes: { disabled: pending || !canPost },
              },
            ]}
            onPressAction={({ nativeEvent }) => {
              if (pending || !canPost) return;
              if (
                nativeEvent.event === "update" ||
                nativeEvent.event === "request" ||
                nativeEvent.event === "blocker"
              )
                setKind(nativeEvent.event);
            }}
          >
            <Button
              label={kind === "update" ? "＋" : kind === "request" ? "Request help⌄" : "Blocked⌄"}
              tone="secondary"
              disabled={pending || !canPost}
              onPress={() => {}}
            />
          </Menu>
          <View className="flex-row items-center gap-2">
            <AppText>{target ? threadTitle(target) : "Project"}</AppText>
            {target ? (
              <Button
                label="×"
                accessibilityHint="Remove recipient"
                tone="text"
                disabled={pending}
                onPress={() => setTarget(null)}
              />
            ) : null}
          </View>
          <AppTextInput
            accessibilityLabel="Activity message"
            placeholder="Share an update, or @ a thread..."
            value={text}
            maxLength={16000}
            multiline
            editable={!pending && canPost}
            onChangeText={setText}
            onSelectionChange={({ nativeEvent }) => setCaret(nativeEvent.selection.start)}
          />
          {mention && mentionCandidates.length ? (
            <View className="gap-1 rounded-xl border border-input-border p-2">
              <AppText className="text-xs text-foreground-muted">Mention a thread</AppText>
              {mentionCandidates.map((candidate) => (
                <Button
                  key={candidate.threadId}
                  label={`${candidate.title} · ${coordinationPresenceLabel(candidate.status)}`}
                  disabled={pending || !canPost}
                  tone="text"
                  onPress={() => {
                    const replacement = `${text.slice(0, mention.start)}${text.slice(mention.end)}`;
                    setText(replacement);
                    setTarget(candidate.threadId);
                    setCaret(mention.start);
                  }}
                />
              ))}
            </View>
          ) : null}

          {mentionPending && !mention ? (
            <AppText>Choose a thread for the @mention or remove @ before posting.</AppText>
          ) : null}
          {targetMissing ? (
            <AppText accessibilityRole="alert" className="text-danger">
              This thread is no longer available. Remove the recipient to share with the project.
            </AppText>
          ) : null}
          {mention && !mentionCandidates.length ? (
            <AppText>No matching thread. The @ text will stay in your post.</AppText>
          ) : null}
          {error ? (
            <AppText accessibilityRole="alert" className="text-danger">
              {error}
            </AppText>
          ) : null}
          <AppText className="text-xs text-foreground-muted">
            {target ? "Sharing with this thread." : "Sharing with the project."}
          </AppText>
          <Button
            label={pending ? "Saving..." : "Post"}
            tone="primary"
            disabled={pending || !canPost || mentionPending || targetMissing || !text.trim()}
            onPress={() => {
              if (pending || !text.trim() || !canPost || mentionPending || targetMissing) return;
              void perform(
                () =>
                  post({
                    environmentId,
                    input: {
                      commandId: CommandId.make(uuidv4()),
                      projectId,
                      senderThreadId: threadId,
                      ...coordinationPostContent({
                        text,
                        kind,
                        ...(target ? { targetThreadId: target } : {}),
                      }),
                    },
                  }),
                () => {
                  setText("");
                  setTarget(null);
                  setCaret(0);
                  setKind("update");
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

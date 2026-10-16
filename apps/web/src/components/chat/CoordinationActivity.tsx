import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  type ChatAttachment,
  type CoordinationEntry,
  type CoordinationKind,
  type CoordinationSnapshot,
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
import {
  ActivityIcon,
  ChevronDownIcon,
  FilterIcon,
  MoreHorizontalIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { randomUUID } from "~/lib/utils";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { coordinationEnvironment } from "../../state/coordination";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { AttachmentFilePreview } from "../files/AttachmentFilePreview";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { Sheet, SheetPopup, SheetHeader, SheetTitle, SheetDescription } from "../ui/sheet";

type ActivityProps = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
};

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
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`Activity${unread ? `, ${unread} unread topics` : ""}`}
      >
        <ActivityIcon aria-hidden />
        <span>Activity</span>
        {unread > 0 ? (
          <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
            {unread}
          </span>
        ) : null}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetPopup side="right">
          <SheetHeader>
            <SheetTitle>Activity</SheetTitle>
            <SheetDescription>
              Updates, requests, and blockers across this project.
            </SheetDescription>
          </SheetHeader>
          {open ? <ActivityContent {...props} /> : null}
        </SheetPopup>
      </Sheet>
    </>
  );
}

function ActivityContent({ environmentId, projectId, threadId }: ActivityProps) {
  const [scope, setScope] = useState<"thread" | "project">("project");
  const [olderEntries, setOlderEntries] = useState<CoordinationEntry[]>([]);
  const [olderCursor, setOlderCursor] = useState<number | null | undefined>();
  const [replyId, setReplyId] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inbox = useEnvironmentQuery(
    coordinationEnvironment.snapshot({
      environmentId,
      input: { projectId, threadId, limit: 100 },
    }),
  );
  const board = useEnvironmentQuery(
    scope === "project"
      ? coordinationEnvironment.snapshot({
          environmentId,
          input: { projectId, limit: 100 },
        })
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
  // Retain the live page while paging so new posts cannot leave a gap in history.
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
            ? "Queued for this agent after its current work."
            : action === "return_to_task"
              ? "Asked this agent to return to its original task."
              : "Sent to this agent to handle now.",
        ),
    );
  }
  function updatePreferences(update: Omit<CoordinationPreferencesInput, "projectId" | "threadId">) {
    return perform(() =>
      savePreferences({ environmentId, input: { projectId, threadId, ...update } }),
    );
  }
  const submit = (content: ReturnType<typeof coordinationPostContent>, onSuccess: () => void) => {
    void perform(
      () =>
        post({
          environmentId,
          input: {
            commandId: CommandId.make(randomUUID()),
            projectId,
            senderThreadId: threadId,
            ...content,
          },
        }),
      onSuccess,
    );
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-6 pb-3">
        <Button
          size="sm"
          variant={scope === "thread" ? "secondary" : "ghost"}
          aria-pressed={scope === "thread"}
          disabled={pending}
          onClick={() => {
            setScope(scope === "project" ? "thread" : "project");
            setOlderEntries([]);
            setOlderCursor(undefined);
            setReplyId(null);
          }}
        >
          <FilterIcon aria-hidden /> For this thread
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Activity options"
                disabled={pending}
              />
            }
          >
            <MoreHorizontalIcon aria-hidden />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              disabled={!canSetPreferences || !inbox.data?.unreadCount}
              onClick={() => void updatePreferences({ readRevision: inbox.data?.revision ?? 0 })}
            >
              Mark read
            </MenuItem>
            <MenuItem
              disabled={!canSetPreferences || !preferences}
              onClick={() => void updatePreferences({ paused: !preferences?.paused })}
            >
              {preferences?.paused ? "Resume delivery" : "Pause delivery"}
            </MenuItem>
            <MenuItem disabled={!canHandle} onClick={() => void handleRequest("return_to_task")}>
              Return to original task
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-4">
        {notice ? (
          <p role="status" className="text-xs text-muted-foreground">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {preferences?.paused ? (
          <p className="text-xs text-muted-foreground">Delivery to this agent is paused.</p>
        ) : null}
        {query.error ? (
          <div role="alert">
            <p>{query.error}</p>
            <Button variant="outline" size="sm" onClick={query.refresh}>
              Retry
            </Button>
          </div>
        ) : null}
        {!snapshot && !query.error ? <p role="status">Loading activity...</p> : null}
        {snapshot ? (
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Threads ({threads.length})
            </summary>
            <ul className="mt-2 space-y-2">
              {threads.map((thread) => (
                <li key={thread.threadId} className="text-xs">
                  <span className="font-medium">
                    {thread.title}
                    {thread.threadId === threadId ? " (this thread)" : ""}
                  </span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {coordinationPresenceLabel(thread.status)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {snapshot && topics.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            No activity yet. Share an update below.
          </p>
        ) : null}
        {topics.map((group) => (
          <div key={group.topic} className="space-y-4">
            {group.rows
              .filter(({ depth }) => depth === 0)
              .map(({ entry, canReply }) => {
                const replies = group.rows.filter((row) => row.entry.replyToId === entry.id);
                const muted = preferences?.mutedTopics.includes(entry.topic) ?? false;
                return (
                  <article key={entry.id} className="space-y-2 rounded-lg border border-border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">
                          {entry.createdBy === "user" ? "You" : threadTitle(entry.senderThreadId)}
                        </span>
                        {entry.targetThreadId
                          ? ` → ${threadTitle(entry.targetThreadId)}`
                          : " · Project"}
                        {" · "}
                        <time
                          dateTime={entry.updatedAt}
                          aria-label={new Date(entry.updatedAt).toLocaleString()}
                        >
                          {new Date(entry.updatedAt).toLocaleString([], {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </time>
                        {entry.status !== "open" ? ` · ${entry.status}` : ""}
                        {muted ? " · Muted" : ""}
                      </p>
                      <Menu>
                        <MenuTrigger
                          render={
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label="Discussion options"
                              disabled={pending}
                            />
                          }
                        >
                          <MoreHorizontalIcon aria-hidden />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuItem
                            disabled={!canSetPreferences || !preferences}
                            onClick={() =>
                              void updatePreferences({
                                mutedTopics: muted
                                  ? preferences!.mutedTopics.filter(
                                      (topic) => topic !== entry.topic,
                                    )
                                  : [...(preferences?.mutedTopics ?? []), entry.topic],
                              })
                            }
                          >
                            {muted ? "Unmute topic" : "Mute topic"}
                          </MenuItem>
                          <MenuItem
                            disabled={!canResolve || !canReply}
                            onClick={() =>
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
                          >
                            Resolve
                          </MenuItem>
                          {entry.kind !== "update" ? (
                            <MenuItem
                              disabled={!canResolve || !canReply}
                              onClick={() =>
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
                            >
                              Decline
                            </MenuItem>
                          ) : null}
                        </MenuPopup>
                      </Menu>
                    </div>
                    {entry.kind !== "update" ? (
                      <p className="text-xs font-medium">
                        {entry.kind === "request" ? "Request help" : "Blocked"}
                      </p>
                    ) : null}
                    {entry.createdBy === "agent" ? (
                      <h3 className="text-sm font-medium">{entry.topic}</h3>
                    ) : null}
                    <p className="whitespace-pre-wrap break-words text-sm">{entry.text}</p>
                    {entry.attachments.map((attachment) => (
                      <ActivityAttachment
                        key={attachment.id}
                        environmentId={environmentId}
                        attachment={attachment}
                      />
                    ))}
                    <div className="flex flex-wrap items-center gap-1">
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={pending || !canPost || !canReply}
                        onClick={() => setReplyId(entry.id)}
                      >
                        Reply
                      </Button>
                      {entry.kind !== "update" && entry.status === "open" ? (
                        <>
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={pending || !canHandle || !canReply}
                            onClick={() => void handleRequest("handle_after", entry)}
                          >
                            Ask this agent to handle it
                          </Button>
                          <Menu>
                            <MenuTrigger
                              render={
                                <Button
                                  size="icon-xs"
                                  variant="ghost"
                                  aria-label="Handle timing"
                                  disabled={pending || !canHandle || !canReply}
                                />
                              }
                            >
                              <ChevronDownIcon aria-hidden />
                            </MenuTrigger>
                            <MenuPopup>
                              <MenuItem onClick={() => void handleRequest("handle_now", entry)}>
                                Handle now
                              </MenuItem>
                            </MenuPopup>
                          </Menu>
                        </>
                      ) : null}
                    </div>
                    {replies.length ? (
                      <details>
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                          {replies.length} {replies.length === 1 ? "reply" : "replies"}
                        </summary>
                        <div className="mt-3 space-y-3 border-l border-border pl-3">
                          {replies.map(({ entry: response }) => (
                            <div key={response.id} className="space-y-1">
                              <p className="text-xs text-muted-foreground">
                                {response.createdBy === "user"
                                  ? "You"
                                  : threadTitle(response.senderThreadId)}
                              </p>
                              <p className="whitespace-pre-wrap break-words text-sm">
                                {response.text}
                              </p>
                              {response.attachments.map((attachment) => (
                                <ActivityAttachment
                                  key={attachment.id}
                                  environmentId={environmentId}
                                  attachment={attachment}
                                />
                              ))}
                            </div>
                          ))}
                        </div>
                      </details>
                    ) : null}
                    {replyId === entry.id ? (
                      <ActivityComposer
                        key={entry.id}
                        threads={threads}
                        disabled={pending || !canPost || !canReply}
                        pending={pending}
                        reply={entry}
                        replyText={replyDrafts[entry.id] ?? ""}
                        onReplyTextChange={(text) =>
                          setReplyDrafts((drafts) => ({ ...drafts, [entry.id]: text }))
                        }
                        onPost={(content, clear) =>
                          submit(content, () => {
                            clear();
                            setReplyId(null);
                          })
                        }
                        onCancel={() => setReplyId(null)}
                      />
                    ) : null}
                  </article>
                );
              })}
            {group.rows
              .filter(
                ({ depth, entry }) =>
                  depth === 1 && !group.rows.some((row) => row.entry.id === entry.replyToId),
              )
              .map(({ entry }) => (
                <article key={entry.id} className="space-y-2 rounded-lg border border-border p-3">
                  <p className="text-xs text-muted-foreground">
                    Earlier discussion · {group.topic}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-sm">{entry.text}</p>
                  {entry.attachments.map((attachment) => (
                    <ActivityAttachment
                      key={attachment.id}
                      environmentId={environmentId}
                      attachment={attachment}
                    />
                  ))}
                </article>
              ))}
          </div>
        ))}
        {nextBeforeRevision != null ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() =>
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
          >
            Load older
          </Button>
        ) : null}
      </div>
      <div className="border-t border-border p-4">
        <ActivityComposer
          threads={threads}
          disabled={pending || !canPost}
          pending={pending}
          onPost={submit}
        />
      </div>
    </div>
  );
}

function ActivityComposer({
  threads,
  disabled,
  pending,
  reply,
  onPost,
  onCancel,
  replyText,
  onReplyTextChange,
}: {
  threads: CoordinationSnapshot["threads"];
  disabled: boolean;
  pending: boolean;
  reply?: CoordinationEntry;
  replyText?: string;
  onReplyTextChange?: (text: string) => void;
  onPost: (content: ReturnType<typeof coordinationPostContent>, clear: () => void) => void;
  onCancel?: () => void;
}) {
  const [mainText, setMainText] = useState("");
  const text = replyText ?? mainText;
  const setText = onReplyTextChange ?? setMainText;
  const [kind, setKind] = useState<CoordinationKind>("update");
  const [target, setTarget] = useState<ThreadId | null>(null);
  const [caret, setCaret] = useState(0);
  const [suggestion, setSuggestion] = useState(0);
  const editor = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const mention = reply ? null : coordinationMentionQuery(text, caret, threads);
  const mentionPending = !reply && hasCoordinationMention(text, threads);
  const candidates = mention
    ? threads
        .filter((thread) => thread.title.toLowerCase().includes(mention.query.toLowerCase()))
        .slice(0, 6)
    : [];
  const recipient = threads.find((thread) => thread.threadId === target);
  const targetMissing = target !== null && recipient === undefined;
  function chooseThread(threadId: ThreadId) {
    if (!mention) return;
    setText(text.slice(0, mention.start) + text.slice(mention.end));
    setCaret(mention.start);
    setTarget(threadId);
    setSuggestion(0);
    editor.current?.focus();
  }
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || !text.trim() || mentionPending || targetMissing) return;
        onPost(
          coordinationPostContent({
            text,
            kind,
            ...(target ? { targetThreadId: target } : {}),
            ...(reply ? { reply } : {}),
          }),
          () => {
            setText("");
            setTarget(null);
            setKind("update");
            setCaret(0);
          },
        );
      }}
    >
      {reply ? (
        <div className="flex items-center justify-between text-xs">
          <span>Reply in this discussion</span>
          <Button size="xs" variant="ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      ) : null}
      {target ? (
        <div className="flex items-center gap-1 text-xs">
          <span>To: @{recipient?.title ?? "Unavailable thread"}</span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Remove recipient"
            disabled={disabled}
            onClick={() => setTarget(null)}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      ) : null}
      <Textarea
        ref={editor}
        autoFocus={reply !== undefined}
        aria-label={reply ? "Reply message" : "Activity message"}
        placeholder={reply ? "Write a reply..." : "Share an update, or @ a thread..."}
        value={text}
        maxLength={16000}
        size="sm"
        disabled={disabled}
        role={reply ? undefined : "combobox"}
        aria-multiline="true"
        aria-expanded={mention !== null}
        aria-controls={mention ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={candidates[suggestion] ? `${listId}-${suggestion}` : undefined}
        onChange={(event) => {
          setText(event.target.value);
          setCaret(event.target.selectionStart);
          setSuggestion(0);
        }}
        onSelect={(event) => {
          setCaret(event.currentTarget.selectionStart);
        }}
        onKeyDown={(event) => {
          if (!mention || !candidates.length) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setSuggestion(
              (index) =>
                (index + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) %
                candidates.length,
            );
          } else if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            chooseThread(candidates[suggestion]?.threadId ?? candidates[0]!.threadId);
          }
        }}
      />
      {mention ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Threads"
          className="space-y-1 rounded-lg border border-border p-2"
        >
          {candidates.length ? (
            candidates.map((thread, index) => (
              <Button
                key={thread.threadId}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={suggestion === index}
                variant={suggestion === index ? "secondary" : "ghost"}
                size="sm"
                disabled={disabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseThread(thread.threadId)}
              >
                {thread.title} · {coordinationPresenceLabel(thread.status)}
              </Button>
            ))
          ) : (
            <p className="text-xs text-muted-foreground">
              No matching thread. The @ text will stay in your post.
            </p>
          )}
        </div>
      ) : null}
      {mentionPending && !mention ? (
        <p role="status" className="text-xs text-muted-foreground">
          Choose a thread for the @mention or remove @ before posting.
        </p>
      ) : null}
      {targetMissing ? (
        <p role="status" className="text-xs text-destructive">
          This thread is no longer available. Remove the recipient to share with the project.
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        {reply ? (
          <span />
        ) : (
          <Menu>
            <MenuTrigger
              render={
                <Button variant="ghost" size="xs" aria-label="Post options" disabled={disabled} />
              }
            >
              {kind === "update" ? (
                <PlusIcon aria-hidden />
              ) : kind === "request" ? (
                "Request help"
              ) : (
                "Blocked"
              )}
              <ChevronDownIcon aria-hidden />
            </MenuTrigger>
            <MenuPopup side="top" align="start">
              {(["update", "request", "blocker"] as const).map((value) => (
                <MenuItem key={value} onClick={() => setKind(value)}>
                  {value === "update" ? "Update" : value === "request" ? "Request help" : "Blocked"}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        )}
        <span className="text-xs text-muted-foreground">
          {reply
            ? "Reply stays in this discussion."
            : target
              ? "Sharing with this thread."
              : "Sharing with the project."}
        </span>
        <Button
          type="submit"
          size="sm"
          disabled={disabled || !text.trim() || mentionPending || targetMissing}
        >
          {pending ? "Saving..." : reply ? "Reply" : "Post"}
        </Button>
      </div>
    </form>
  );
}

function ActivityAttachment({
  environmentId,
  attachment,
}: {
  environmentId: EnvironmentId;
  attachment: ChatAttachment;
}) {
  const [expanded, setExpanded] = useState(false);
  if (attachment.type !== "image" && attachment.type !== "file") {
    return (
      <p className="break-words text-xs text-muted-foreground">
        {attachment.name} (unsupported attachment)
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <Button
        variant="link"
        size="xs"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="whitespace-normal break-all text-left">{attachment.name}</span>
      </Button>
      {expanded ? (
        <div className="h-80 overflow-hidden rounded-lg border border-border">
          <AttachmentFilePreview
            name={attachment.name}
            mimeType={attachment.mimeType}
            sizeBytes={attachment.sizeBytes}
            asset={{ environmentId, attachmentId: attachment.id }}
            origin="Activity"
            onClose={() => setExpanded(false)}
          />
        </div>
      ) : null}
    </div>
  );
}

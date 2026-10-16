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
import { ActivityIcon } from "lucide-react";
import { randomUUID } from "~/lib/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import { coordinationEnvironment } from "../../state/coordination";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { AttachmentFilePreview } from "../files/AttachmentFilePreview";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
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
  const [scope, setScope] = useState<"thread" | "project">("thread");
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
  const replyBlocked =
    reply !== null &&
    !topics.some((group) => group.rows.some((row) => row.entry.id === reply.id && row.canReply));
  const liveEntries = snapshot?.entries;
  // Once paging, retain the live page as it moves so new posts cannot create a gap in history.
  useEffect(() => {
    if (olderCursor === undefined || !liveEntries) return;
    setOlderEntries((entries) => mergeCoordinationEntries(entries, liveEntries));
  }, [liveEntries, olderCursor]);
  const loadOlder = useAtomCommand(coordinationEnvironment.loadOlder, { reportFailure: false });
  const nextBeforeRevision = olderCursor === undefined ? snapshot?.nextBeforeRevision : olderCursor;
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
  function startReply(entry: CoordinationEntry) {
    setReply(entry);
    setTopic(entry.topic);
    setTarget(entry.senderThreadId === threadId ? entry.targetThreadId : entry.senderThreadId);
    setKind("update");
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-6 pb-3">
        <div className="flex gap-1" role="group" aria-label="Activity scope">
          <Button
            size="sm"
            variant={scope === "thread" ? "secondary" : "ghost"}
            disabled={pending}
            aria-pressed={scope === "thread"}
            onClick={() => {
              setScope("thread");
              setOlderEntries([]);
              setOlderCursor(undefined);
            }}
          >
            This thread
          </Button>
          <Button
            size="sm"
            variant={scope === "project" ? "secondary" : "ghost"}
            disabled={pending}
            aria-pressed={scope === "project"}
            onClick={() => {
              setScope("project");
              setOlderEntries([]);
              setOlderCursor(undefined);
            }}
          >
            Project
          </Button>
        </div>
        <Button
          size="xs"
          variant="ghost"
          disabled={pending || !canSetPreferences || !inbox.data?.unreadCount}
          onClick={() => void updatePreferences({ readRevision: inbox.data?.revision ?? 0 })}
        >
          Mark read
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={pending || !canSetPreferences || !preferences}
          aria-pressed={preferences?.paused ?? false}
          onClick={() => void updatePreferences({ paused: !preferences?.paused })}
        >
          {preferences?.paused ? "Resume delivery" : "Pause delivery"}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={pending || !canHandle}
          onClick={() => void handleRequest("return_to_task")}
        >
          Return to original task
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-4">
        <p className="text-xs text-muted-foreground">
          Handle actions send the request to this thread.
        </p>
        {notice ? (
          <p role="status" className="text-xs text-muted-foreground">
            {notice}
          </p>
        ) : null}
        {preferences?.paused ? (
          <p className="text-xs text-muted-foreground">
            Automatic delivery to this thread is paused. Activity stays here.
          </p>
        ) : null}
        {query.error ? (
          <div role="alert" className="space-y-2 text-sm">
            <p>{query.error}</p>
            <Button variant="outline" size="sm" onClick={query.refresh}>
              Retry
            </Button>
          </div>
        ) : null}
        {!snapshot && !query.error ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading activity...
          </p>
        ) : null}
        {snapshot ? (
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              Threads ({threads.length})
            </summary>
            <ul className="mt-2 space-y-2">
              {threads.map((thread) => (
                <li key={thread.threadId} className="text-xs">
                  <p className="truncate font-medium">
                    {thread.title}
                    {thread.threadId === threadId ? " (this thread)" : ""}
                  </p>
                  <p className="text-muted-foreground">
                    {coordinationPresenceLabel(thread.status)} ·{" "}
                    <time dateTime={thread.updatedAt}>
                      {new Date(thread.updatedAt).toLocaleString()}
                    </time>
                  </p>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {snapshot && topics.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            No activity yet. Post an update or ask another thread for help.
          </p>
        ) : null}
        {topics.map((group) => {
          const muted = preferences?.mutedTopics.includes(group.topic) ?? false;
          return (
            <section
              key={group.topic}
              className="space-y-3 rounded-lg border border-border p-3"
              aria-label={group.topic}
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="min-w-0 break-words text-sm font-medium">{group.topic}</h3>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={pending || !canSetPreferences || !preferences}
                  aria-label={`${muted ? "Unmute" : "Mute"} topic ${group.topic}`}
                  onClick={() =>
                    void updatePreferences({
                      mutedTopics: muted
                        ? (preferences?.mutedTopics.filter((value) => value !== group.topic) ?? [])
                        : [...(preferences?.mutedTopics ?? []), group.topic],
                    })
                  }
                >
                  {muted ? "Unmute" : "Mute"}
                </Button>
              </div>
              {group.rows.map(({ entry, depth, canReply }) => (
                <article
                  key={entry.id}
                  className={depth ? "ml-3 space-y-2 border-l border-border pl-3" : "space-y-2"}
                >
                  <div className="text-xs text-muted-foreground">
                    <span
                      className={
                        entry.kind === "blocker" && entry.status === "open"
                          ? "font-medium text-destructive"
                          : ""
                      }
                    >
                      {entry.kind}
                    </span>
                    {" · "}
                    {entry.createdBy === "user" ? "You" : threadTitle(entry.senderThreadId)}
                    {entry.targetThreadId
                      ? ` → ${threadTitle(entry.targetThreadId)}`
                      : " → Project"}
                    {entry.updateCount > 1 ? ` · ${entry.updateCount} updates` : ""}
                    {entry.status !== "open" ? ` · ${entry.status}` : ""}
                    <p>
                      <time dateTime={entry.updatedAt}>
                        {new Date(entry.updatedAt).toLocaleString()}
                      </time>
                    </p>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm">{entry.text}</p>
                  {entry.attachments.map((attachment) => (
                    <ActivityAttachment
                      key={attachment.id}
                      environmentId={environmentId}
                      attachment={attachment}
                    />
                  ))}
                  <div className="flex flex-wrap gap-1">
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={pending || !canPost || !canReply}
                      onClick={() => startReply(entry)}
                    >
                      Reply
                    </Button>
                    {entry.replyToId === null && entry.status === "open" ? (
                      <>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={pending || !canHandle || !canReply}
                          onClick={() => void handleRequest("handle_now", entry.id)}
                        >
                          Handle now
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={pending || !canHandle || !canReply}
                          onClick={() => void handleRequest("handle_after", entry.id)}
                        >
                          After current work
                        </Button>

                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={pending || !canResolve}
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
                        </Button>
                        {entry.kind !== "update" ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={pending || !canResolve}
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
                          </Button>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                </article>
              ))}
            </section>
          );
        })}
        {nextBeforeRevision !== null && nextBeforeRevision !== undefined ? (
          <Button
            variant="outline"
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
      <form
        className="space-y-3 border-t border-border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!topic.trim() || !text.trim() || !canPost || replyBlocked) return;
          void perform(
            () =>
              post({
                environmentId,
                input: {
                  commandId: CommandId.make(randomUUID()),
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
      >
        {reply ? (
          <div className="flex items-center justify-between gap-2 text-xs">
            <span>
              Replying to {reply.createdBy === "user" ? "You" : threadTitle(reply.senderThreadId)}{" "}
              on {reply.topic}
            </span>
            <Button type="button" variant="ghost" size="xs" onClick={() => setReply(null)}>
              Cancel reply
            </Button>
          </div>
        ) : null}
        {!reply ? (
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <Select
                value={kind}
                onValueChange={(value) => {
                  if (value) setKind(value);
                }}
                disabled={pending || !canPost}
              >
                <SelectTrigger aria-label="Post type">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {(["update", "request", "blocker"] as const).map((value) => (
                    <SelectItem key={value} value={value}>
                      {value === "update" ? "Update" : value === "request" ? "Request" : "Blocker"}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="min-w-0 flex-1">
              <Select
                value={target ?? "project"}
                onValueChange={(value) =>
                  setTarget(threads.find((thread) => thread.threadId === value)?.threadId ?? null)
                }
                disabled={pending || !canPost}
              >
                <SelectTrigger aria-label="Send to">
                  <SelectValue>{target ? threadTitle(target) : "Project"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="project">Project</SelectItem>
                  {threads
                    .filter((thread) => thread.threadId !== threadId)
                    .map((thread) => (
                      <SelectItem key={thread.threadId} value={thread.threadId}>
                        {thread.title}
                      </SelectItem>
                    ))}
                </SelectPopup>
              </Select>
            </div>
          </div>
        ) : null}
        <Input
          aria-label="Topic"
          placeholder="Topic"
          value={topic}
          maxLength={160}
          disabled={pending || !canPost || reply !== null}
          onChange={(event) => setTopic(event.target.value)}
        />
        <Textarea
          aria-label="Activity message"
          placeholder="Share an update, request, or blocker..."
          value={text}
          maxLength={16000}
          disabled={pending || !canPost}
          onChange={(event) => setText(event.target.value)}
        />
        {replyBlocked ? (
          <p role="status" className="text-xs text-muted-foreground">
            This discussion is closed or its original post is not loaded. Load older activity or
            cancel the reply.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">Posting does not start an agent turn.</p>
          <Button
            type="submit"
            size="sm"
            disabled={pending || !canPost || replyBlocked || !topic.trim() || !text.trim()}
          >
            {pending ? "Saving..." : reply ? "Reply" : "Post"}
          </Button>
        </div>
      </form>
    </div>
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

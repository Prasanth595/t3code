import type { LegendListRef } from "@legendapp/list/react";
import type { ChatReplyError } from "@t3tools/client-runtime/chat";
import { EnvironmentId, MessageId } from "@t3tools/contracts";
import type { SaasChatConversation } from "@t3tools/contracts/saas";
import { useNavigate } from "@tanstack/react-router";
import { createRef, useEffect, useRef, useState, type KeyboardEvent } from "react";

import {
  hasAgenticAccess,
  miraChatHistory,
  useMiraAccess,
  useMiraChatHistory,
} from "~/cloud/miraChat";
import { isElectron } from "~/env";
import { useIncrementalTimelineEntries } from "~/hooks/useIncrementalTimelineEntries";
import { useTheme } from "~/hooks/useTheme";
import type { ChatMessage } from "~/types";
import type { ChatComposerHandle } from "../chat/ChatComposer";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { ComposerSurface } from "../chat/ComposerSurface";
import { MessagesTimeline } from "../chat/MessagesTimeline";
import { ScrollToEndButton } from "../chat/TimelineOverlays";
import { useTimelineFollow } from "../chat/useTimelineFollow";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { AgenticUpgradeDialog } from "./AgenticUpgradeDialog";
import { ChatModeSwitch } from "./ChatModeSwitch";

// The timeline keys rows by environment; nothing behind this id loads, as on the guest page.
const CHAT_ENVIRONMENT_ID = EnvironmentId.make("mira-chat");
const NO_COMPOSER = createRef<ChatComposerHandle>();
const NO_TURN_DIFFS: ReadonlyArray<never> = [];
const NO_TURN_ITEMS: ReadonlyArray<never> = [];
const ignore = () => {};
const ignoreImage = (_preview: ExpandedImagePreview) => {};

const toTimelineMessages = (
  chat: SaasChatConversation | undefined,
  streaming: { readonly chatId: string; readonly text: string } | null,
): ReadonlyArray<ChatMessage> => {
  const messages: Array<ChatMessage> = (chat?.messages ?? []).map((message) => ({
    id: MessageId.make(message.id),
    role: message.role,
    text: message.content,
    runId: null,
    streaming: false,
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
  }));
  if (chat !== undefined && streaming?.chatId === chat.id && streaming.text !== "") {
    const at = chat.updatedAt;
    messages.push({
      id: MessageId.make(`streaming-${chat.id}`),
      role: "assistant",
      text: streaming.text,
      runId: null,
      streaming: true,
      createdAt: at,
      updatedAt: at,
    });
  }
  return messages;
};

/** Chat mode: Mira answers from the account's model, with no computer or tools behind it. */
export function ChatModeView({ chatId }: { readonly chatId: string | null }) {
  const navigate = useNavigate();
  const history = useMiraChatHistory();
  const access = useMiraAccess();
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const chat = chatId === null ? undefined : history.chats.find((item) => item.id === chatId);
  const missing = chatId !== null && history.loaded && chat === undefined;

  useEffect(() => {
    if (missing) void navigate({ to: "/ask", replace: true });
  }, [missing, navigate]);

  const send = async (text: string) => {
    const sentChatId = await miraChatHistory.send(chat?.id ?? null, text);
    if (sentChatId !== chatId) {
      void navigate({
        to: "/ask/$chatId",
        params: { chatId: sentChatId },
        replace: chatId === null,
      });
    }
  };

  const busy = history.streaming !== null;
  const error = history.error !== null && history.error.chatId === chat?.id ? history.error : null;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron}>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{chat?.title ?? "New chat"}</h1>
        <ChatModeSwitch
          mode="chat"
          onAgentic={() => {
            if (hasAgenticAccess(access)) void navigate({ to: "/" });
            else setUpgradeOpen(true);
          }}
        />
      </WorkspacePageHeader>
      {chat === undefined ? (
        <div className="m-auto flex max-w-md flex-col items-center gap-2 px-6 text-center">
          <p className="text-2xl font-medium">What can I help with?</p>
          <p className="text-sm text-muted-foreground">
            Ask anything. Chat works without a connected computer.
          </p>
        </div>
      ) : (
        <ChatTimeline chat={chat} streaming={history.streaming} />
      )}
      <div className="chat-composer-lane w-full shrink-0 pt-1.5 pb-3 sm:pt-2 sm:pb-4">
        {error !== null ? (
          <ChatReplyErrorNotice
            error={error}
            onSignIn={access.openSignIn}
            onUpgrade={() => setUpgradeOpen(true)}
          />
        ) : null}
        <ChatModeComposer busy={busy} onSend={send} />
      </div>
      <AgenticUpgradeDialog open={upgradeOpen} onOpenChange={setUpgradeOpen} />
    </SidebarInset>
  );
}

function ChatTimeline({
  chat,
  streaming,
}: {
  readonly chat: SaasChatConversation;
  readonly streaming: { readonly chatId: string; readonly text: string } | null;
}) {
  const threadKey = `mira-chat-${chat.id}`;
  const listRef = useRef<LegendListRef | null>(null);
  const { resolvedTheme } = useTheme();
  const messages = toTimelineMessages(chat, streaming);
  const entries = useIncrementalTimelineEntries(threadKey, {
    visibleTurnItems: NO_TURN_ITEMS,
    optimisticMessages: messages,
  });
  const isWorking = streaming?.chatId === chat.id;
  const lastUserMessage = chat.messages.findLast((message) => message.role === "user");
  const follow = useTimelineFollow({
    legendListRef: listRef,
    composerRef: NO_COMPOSER,
    composerOverlayElement: null,
    composerTimelineInset: 0,
    routeThreadKey: threadKey,
    activeThreadKey: threadKey,
    activeThreadId: undefined,
    isServerThread: false,
    serverProjection: null,
    threadStatus: "live",
    activeActivityRun: null,
    activeRunningTurnId: null,
    timelineEntries: entries,
    timelineAnchorMessageId: null,
    setTimelineAnchor: ignore,
  });
  return (
    <div className="relative min-h-0 flex-1">
      <MessagesTimeline
        listRef={listRef}
        timelineEntries={entries}
        isWorking={isWorking}
        activeTurnInProgress={isWorking}
        activeTurnStartedAt={isWorking ? (lastUserMessage?.createdAt ?? null) : null}
        latestRun={null}
        runningRunId={null}
        turnDiffSummaries={NO_TURN_DIFFS}
        runs={NO_TURN_ITEMS}
        routeThreadKey={threadKey}
        onOpenThread={ignore}
        onRollbackCheckpoint={ignore}
        supportsConversationRollback={false}
        onRevertToTurnCount={ignore}
        isRevertingCheckpoint={false}
        onImageExpand={ignoreImage}
        activeThreadEnvironmentId={CHAT_ENVIRONMENT_ID}
        markdownCwd={undefined}
        resolvedTheme={resolvedTheme}
        timestampFormat="locale"
        workspaceRoot={undefined}
        anchorMessageId={null}
        onAnchorReady={ignore}
        onAnchorSizeChanged={ignore}
        contentInsetEndAdjustment={0}
        emptyPlaceholderInset={0}
        liveFollowEnabled={follow.timelineLiveFollowEnabled}
        onIsAtEndChange={follow.onIsAtEndChangeStable}
        onManualNavigation={follow.cancelTimelineLiveFollowForUserNavigationStable}
        cancelPositionRestoreRef={follow.cancelPositionRestoreRef}
      />
      {follow.showScrollToBottom ? (
        <ScrollToEndButton bottom={4} onScrollToEnd={() => follow.scrollToEnd(true)} />
      ) : null}
    </div>
  );
}

function ChatReplyErrorNotice({
  error,
  onSignIn,
  onUpgrade,
}: {
  readonly error: ChatReplyError;
  readonly onSignIn: (() => void) | null;
  readonly onUpgrade: () => void;
}) {
  const action =
    error.code === "sign_up_required" || error.code === "session_expired"
      ? onSignIn === null
        ? null
        : {
            label: error.code === "session_expired" ? "Sign in" : "Create free account",
            run: onSignIn,
          }
      : error.code === "daily_limit"
        ? { label: "Upgrade to Pro", run: onUpgrade }
        : null;
  return (
    <div
      role="alert"
      className="mx-auto mb-2 flex w-full max-w-(--chat-content-max-width) items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-sm"
    >
      <p className="min-w-0 flex-1">{error.message}</p>
      {action !== null ? (
        <Button
          size="sm"
          onClick={() => {
            miraChatHistory.clearError();
            action.run();
          }}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

// The thread composer's surface and send button, without attachments or model controls.
function ChatModeComposer({
  busy,
  onSend,
}: {
  readonly busy: boolean;
  readonly onSend: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const canSend = !busy && text.trim() !== "";
  const submit = () => {
    if (!canSend) return;
    const trimmed = text.trim();
    setText("");
    void onSend(trimmed);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Same as the app composer: Enter sends, Shift+Enter adds a line, IME composition is left alone.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <div data-chat-composer-surface="true" className="rounded-2xl">
              <div className="relative px-3 pt-3.5 pb-2 sm:px-4 sm:pt-4">
                <textarea
                  aria-label="Message"
                  placeholder="Ask Mira anything"
                  autoFocus
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={onKeyDown}
                  className="-m-1 block max-h-52 min-h-12 w-[calc(100%+0.5rem)] resize-none bg-transparent p-1 font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm)) leading-relaxed text-foreground outline-none field-sizing-content placeholder:text-placeholder"
                />
              </div>
              <div className="flex min-w-0 items-center justify-end gap-2 px-3 pb-3 sm:px-4 sm:pb-4">
                <button
                  type="submit"
                  aria-label="Send message"
                  disabled={!canSend}
                  className="relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-message-action text-message-action-foreground shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:shadow-message-action/24 enabled:inset-shadow-control-highlight hover:scale-105 hover:bg-message-action-hover active:inset-shadow-control-pressed active:shadow-none disabled:pointer-events-none disabled:bg-foreground/12 disabled:text-muted-foreground disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 [&_svg]:pointer-events-none"
                >
                  {busy ? (
                    <Spinner size="sm" aria-hidden="true" />
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                      <path
                        d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </form>
  );
}

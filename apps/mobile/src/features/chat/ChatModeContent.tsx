import {
  chatAttachmentProblem,
  chatAttachmentUrl,
  isRetryable,
  type ChatReplyError,
} from "@t3tools/client-runtime/chat";
import { EnvironmentId } from "@t3tools/contracts";
import { chatVisualsAsText, splitChatVisuals } from "@t3tools/shared/htmlRender";
import type {
  SaasChatAttachment,
  SaasChatConversation,
  SaasChatMessage,
} from "@t3tools/contracts/saas";
import { Image } from "expo-image";
import { useNavigation } from "@react-navigation/native";
import { useRef, useState } from "react";
import {
  Linking,
  Platform,
  Pressable,
  ScrollView,
  type ScrollViewInstance,
  View,
} from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { FadeIn, FadeInUp, FadeOut, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useResolveClassNames } from "uniwind";

import { ComposerActionButton } from "../../components/ComposerToolbar";
import { ComposerEditor } from "../../components/ComposerEditor";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { ComposerAttachmentButton } from "../threads/ComposerAttachmentButton";
import {
  ComposerAttachmentStrip,
  ComposerAttachmentThumbnail,
} from "../../components/ComposerAttachmentStrip";
import {
  convertPastedImagesToAttachments,
  type DraftComposerAttachment,
} from "../../lib/composerImages";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { CopyTextButton } from "../threads/CopyTextButton";
import { ShimmeringWorkContent } from "../threads/thread-work-log";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import {
  ComposerSurface,
  THREAD_COMPOSER_BOTTOM_GUTTER,
  useCompactComposerEditor,
} from "../threads/ThreadComposer";
import { useMarkdownStyles } from "../threads/ThreadFeed";
import { pickChatDocuments, pickChatPhotos } from "./chatFiles";
import { ChatVisual } from "./ChatVisual";
import {
  miraChatHistory,
  openMiraUpgrade,
  uploadMiraAttachment,
  useMiraChatHistory,
  useMiraRelayUrl,
} from "./miraChat";

// Chat files belong to no environment; the strip only shows their local previews.
const CHAT_ENVIRONMENT_ID = EnvironmentId.make("mira-chat");

const MESSAGE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

/**
 * Chat mode: Mira answers from the account's model with no computer behind it, so it works on
 * a phone with nothing connected. Drawn with the thread feed's bubbles and composer.
 */
export function ChatModeContent(props: {
  readonly chatId: string | null;
  readonly onChatStarted: (chatId: string) => void;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const history = useMiraChatHistory();
  const chat =
    props.chatId === null ? undefined : history.chats.find((item) => item.id === props.chatId);
  const busy = history.streaming !== null;
  const replying = chat !== undefined && history.streaming?.chatId === chat.id;
  const error = history.error !== null && history.error.chatId === chat?.id ? history.error : null;

  const send = (text: string, attachments: ReadonlyArray<SaasChatAttachment>) => {
    void miraChatHistory.send(chat?.id ?? null, text, {
      attachments,
      onStarted: (chatId) => {
        if (chatId !== props.chatId) props.onChatStarted(chatId);
      },
    });
  };
  // Like the thread screen: the composer rides the keyboard and drops its bottom inset there.
  const keyboard = useReanimatedKeyboardAnimation();
  const keyboardStyle = useAnimatedStyle(() => ({
    paddingBottom: Math.max(0, -keyboard.height.value - insets.bottom * keyboard.progress.value),
  }));

  return (
    <Animated.View className="flex-1 bg-screen" style={keyboardStyle}>
      {chat === undefined ? (
        <View className="flex-1 items-center justify-center gap-2 px-8">
          <AppText className="text-center text-2xl font-t3-bold">What can I help with?</AppText>
          <AppText className="text-center text-sm text-foreground-secondary">
            Ask anything. Chat works without a connected computer.
          </AppText>
        </View>
      ) : (
        <ChatMessages
          chat={chat}
          streaming={history.streaming?.chatId === chat.id ? history.streaming : null}
        />
      )}
      {error !== null ? (
        <View className="px-[12px] pb-2">
          <ChatErrorNotice
            error={error}
            onSignIn={() => navigation.navigate("SettingsAuth")}
            onUpgrade={() => void openMiraUpgrade().catch(() => undefined)}
            onRetry={() => void miraChatHistory.retry(error.chatId)}
          />
        </View>
      ) : null}
      <ChatComposer
        busy={busy}
        replying={replying}
        bottomInset={insets.bottom}
        onSend={send}
        onStop={() => miraChatHistory.stop()}
      />
    </Animated.View>
  );
}

const FOLLOW_THRESHOLD = 80;

function ChatMessages(props: {
  readonly chat: SaasChatConversation;
  readonly streaming: {
    readonly messageId: string;
    readonly text: string;
    readonly searching?: boolean;
  } | null;
}) {
  const scrollRef = useRef<ScrollViewInstance>(null);
  // Follow new content only from the bottom, so a visual resizing above (a tab switch) keeps its place.
  const atBottom = useRef(true);
  const followedMessages = useRef(props.chat.messages.length);
  return (
    <ScrollView
      ref={scrollRef}
      className="flex-1"
      contentContainerClassName="px-4 pt-3 pb-4"
      keyboardDismissMode="interactive"
      scrollEventThrottle={64}
      onScroll={({ nativeEvent }) => {
        const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
        atBottom.current =
          contentSize.height - contentOffset.y - layoutMeasurement.height < FOLLOW_THRESHOLD;
      }}
      onContentSizeChange={() => {
        const newMessage = props.chat.messages.length !== followedMessages.current;
        followedMessages.current = props.chat.messages.length;
        if (newMessage || atBottom.current) scrollRef.current?.scrollToEnd({ animated: true });
      }}
      // The keyboard shrinks the list; keep the latest message in view, as threads do.
      onLayout={() => scrollRef.current?.scrollToEnd({ animated: false })}
    >
      {/* One list, so the streamed reply keeps its row (and its visuals) once it is saved. */}
      {[
        ...props.chat.messages.map((message) => (
          <ChatMessageRow key={message.id} message={message} streaming={false} />
        )),
        props.streaming === null || props.streaming.text === "" ? null : (
          <ChatMessageRow
            key={props.streaming.messageId}
            message={{
              id: props.streaming.messageId,
              role: "assistant",
              content: props.streaming.text,
              createdAt: props.chat.updatedAt,
            }}
            streaming
          />
        ),
      ]}
      {props.streaming !== null && (props.streaming.searching || props.streaming.text === "") ? (
        <ChatWorkingRow searching={props.streaming.searching === true} />
      ) : null}
    </ScrollView>
  );
}

// The thread feed's working row, so chat reads like agentic mode while Mira works.
function ChatWorkingRow(props: { readonly searching: boolean }) {
  const { color: iconColor } = useResolveClassNames("text-icon-subtle");
  return (
    <View className="mb-5 min-h-8 flex-row items-center px-1" accessible>
      <ShimmeringWorkContent
        key={props.searching ? "searching" : "thinking"}
        icon={props.searching ? "globe" : "brain"}
        iconSubtleColor={iconColor ?? "gray"}
        label={props.searching ? "Searching the web" : "Thinking"}
        showIcon
      />
    </View>
  );
}

// Same bubble, spacing and footer as a user message in the thread feed.
function ChatMessageRow(props: { readonly message: SaasChatMessage; readonly streaming: boolean }) {
  const { message } = props;
  const styles = useMarkdownStyles();
  const { color: iconColor } = useResolveClassNames("text-icon-subtle");
  if (message.role !== "user") {
    return <AssistantRow text={message.content} streaming={props.streaming} />;
  }
  return (
    <Animated.View className="mb-5 items-end" entering={FadeInUp.duration(220)}>
      <View className="min-w-0 max-w-[85%] rounded-[20px] bg-user-bubble">
        <View className="gap-2 px-3.5 pt-2.5 pb-2.5">
          {message.attachments?.length ? (
            <MessageAttachments attachments={message.attachments} />
          ) : null}
          {message.content !== "" ? (
            <SelectableMarkdownText
              markdown={message.content}
              textStyle={styles.user.nativeTextStyle}
              onLinkPress={(href) => void Linking.openURL(href)}
            />
          ) : null}
        </View>
      </View>
      <View className="mt-1 flex-row items-center justify-end gap-1 pr-0.5">
        <AppText className="font-t3-medium text-xs tabular-nums text-foreground-secondary">
          {MESSAGE_TIME_FORMATTER.format(Date.parse(message.createdAt))}
        </AppText>
        <CopyTextButton
          accessibilityLabel="Copy message"
          text={message.content}
          tintColor={iconColor}
          buttonSize={28}
          iconSize={13}
        />
      </View>
    </Animated.View>
  );
}

function AssistantRow(props: { readonly text: string; readonly streaming: boolean }) {
  const styles = useMarkdownStyles();
  const { color: iconColor } = useResolveClassNames("text-icon-subtle");
  return (
    <Animated.View
      className={props.streaming ? "mb-1 px-1" : "mb-5 px-1"}
      entering={FadeIn.duration(220)}
    >
      {splitChatVisuals(props.text).map((segment, index) =>
        segment.kind === "visual" ? (
          <ChatVisual key={index} html={segment.html} complete={segment.complete} />
        ) : (
          <SelectableMarkdownText
            key={index}
            markdown={segment.text}
            textStyle={styles.assistant.nativeTextStyle}
            onLinkPress={(href) => void Linking.openURL(href)}
          />
        ),
      )}
      {props.streaming ? null : (
        <View className="mt-1 flex-row items-center gap-1">
          <CopyTextButton
            accessibilityLabel="Copy message"
            text={chatVisualsAsText(props.text)}
            tintColor={iconColor}
            buttonSize={28}
            iconSize={13}
          />
        </View>
      )}
    </Animated.View>
  );
}

function ChatErrorNotice(props: {
  readonly error: ChatReplyError;
  readonly onSignIn: () => void;
  readonly onUpgrade: () => void;
  readonly onRetry: () => void;
}) {
  const action =
    props.error.code === "sign_up_required" || props.error.code === "session_expired"
      ? {
          label: props.error.code === "session_expired" ? "Sign in" : "Create free account",
          run: props.onSignIn,
        }
      : props.error.code === "daily_limit"
        ? { label: "Upgrade to Pro", run: props.onUpgrade }
        : isRetryable(props.error)
          ? { label: "Try again", run: props.onRetry }
          : null;
  return (
    <View
      accessibilityRole="alert"
      className="gap-3 rounded-2xl border border-border bg-card px-4 py-3"
    >
      <AppText className="text-sm">{props.error.message}</AppText>
      {action !== null ? (
        <Button
          label={action.label}
          onPress={() => {
            miraChatHistory.clearError();
            action.run();
          }}
        />
      ) : null}
    </View>
  );
}

function MessageAttachments(props: { readonly attachments: ReadonlyArray<SaasChatAttachment> }) {
  const relayUrl = useMiraRelayUrl();
  return (
    <View className="gap-2">
      {props.attachments.map((attachment) =>
        attachment.kind === "image" && relayUrl !== null ? (
          <Pressable
            key={attachment.id}
            accessibilityRole="imagebutton"
            accessibilityLabel={`Open ${attachment.name}`}
            onPress={() => void Linking.openURL(chatAttachmentUrl(relayUrl, attachment.id))}
          >
            <Image
              source={{ uri: chatAttachmentUrl(relayUrl, attachment.id) }}
              contentFit="cover"
              style={{ width: 220, height: 170, borderRadius: 14 }}
            />
          </Pressable>
        ) : (
          <FileChip key={attachment.id} name={attachment.name} />
        ),
      )}
    </View>
  );
}

function FileChip(props: { readonly name: string }) {
  return (
    <View className="max-w-60 flex-row items-center gap-2 rounded-xl bg-subtle px-2.5 py-2">
      <SymbolView name="doc.text" size={16} tintColorClassName="accent-icon-subtle" />
      <View className="min-w-0 shrink">
        <AppText className="text-sm text-foreground" numberOfLines={1}>
          {props.name}
        </AppText>
      </View>
    </View>
  );
}

interface PendingFile {
  readonly draft: DraftComposerAttachment;
  readonly attachment: SaasChatAttachment | null;
}

/** Picked files upload right away, so sending only waits on the reply. */
function usePendingFiles() {
  const [files, setFiles] = useState<ReadonlyArray<PendingFile>>([]);
  const add = (picked: {
    readonly attachments: ReadonlyArray<DraftComposerAttachment>;
    readonly error: string | null;
  }) => {
    if (picked.error) Dialog.alert("Could not add the file", picked.error);
    for (const draft of picked.attachments) {
      const problem = chatAttachmentProblem(draft);
      if (problem !== null) {
        Dialog.alert("Could not add the file", problem);
        continue;
      }
      setFiles((current) => [...current, { draft, attachment: null }]);
      void uploadMiraAttachment(draft).then((result) => {
        if (result.ok) {
          setFiles((current) =>
            current.map((item) =>
              item.draft.id === draft.id ? { ...item, attachment: result.attachment } : item,
            ),
          );
        } else {
          setFiles((current) => current.filter((item) => item.draft.id !== draft.id));
          Dialog.alert("Could not add the file", result.message);
        }
      });
    }
  };
  return {
    drafts: files.map((item) => item.draft),
    uploading: files.some((item) => item.attachment === null),
    ready: files.flatMap((item) => (item.attachment === null ? [] : [item.attachment])),
    remove: (id: string) => setFiles((current) => current.filter((item) => item.draft.id !== id)),
    add,
    clear: () => setFiles([]),
    pickPhotos: async () => add(await pickChatPhotos(files.length)),
    pickDocuments: async () => add(await pickChatDocuments(files.length)),
  };
}

const COMPACT_ATTACHMENT_LIMIT = 1;

/**
 * The thread composer's layout and motion: a one-row pill that grows with the text, attachments
 * in the row or above it while editing, and the same attach and send buttons. No model control.
 */
function ChatComposer(props: {
  readonly busy: boolean;
  /** Mira is answering this chat, so the send button stops her instead. */
  readonly replying: boolean;
  readonly bottomInset: number;
  readonly onSend: (text: string, attachments: ReadonlyArray<SaasChatAttachment>) => void;
  readonly onStop: () => void;
}) {
  const bodyText = useScaledTextRole("body");
  const { color: foregroundColor } = useResolveClassNames("text-foreground");
  const [text, setText] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const pending = usePendingFiles();
  const compactEditor = useCompactComposerEditor(bodyText, text);
  const isExpanded = isFocused;
  const stripAttachments = pending.drafts;
  const canSend =
    !props.busy && !pending.uploading && (text.trim() !== "" || pending.ready.length > 0);
  const submit = () => {
    if (!canSend) return;
    const trimmed = text.trim();
    const attachments = pending.ready;
    setText("");
    pending.clear();
    props.onSend(trimmed, attachments);
  };

  return (
    <View
      className={Platform.OS === "android" ? "bg-composer-panel px-[12px]" : "px-[12px]"}
      style={{ paddingTop: 6, paddingBottom: props.bottomInset + THREAD_COMPOSER_BOTTOM_GUTTER }}
    >
      <View className="relative w-full self-center">
        <ComposerSurface
          animateLayout={false}
          style={{
            borderRadius: 27,
            borderCurve: "circular",
            overflow: "hidden",
            paddingVertical: 2,
          }}
        >
          {isExpanded && stripAttachments.length > 0 ? (
            <Animated.View
              className="px-[14px] pb-2.5 pt-2"
              entering={FadeIn.duration(160)}
              exiting={FadeOut.duration(120)}
            >
              <ComposerAttachmentStrip
                environmentId={CHAT_ENVIRONMENT_ID}
                attachments={stripAttachments}
                onRemove={pending.remove}
              />
            </Animated.View>
          ) : null}
          <View onLayout={compactEditor.onRowLayout}>
            <View className="flex-row items-end">
              <ComposerAttachmentButton
                supportsFiles
                onPickMedia={pending.pickPhotos}
                onPickFiles={pending.pickDocuments}
              />
              <Animated.View
                className="min-w-0 flex-1"
                onLayout={compactEditor.onEditorLayout}
                style={[
                  {
                    minWidth: compactEditor.isExpanded || stripAttachments.length > 0 ? 0 : "40%",
                  },
                  compactEditor.containerStyle,
                  compactEditor.isExpanded ? { flex: 0, width: 0 } : undefined,
                ]}
              />
              {!isExpanded && stripAttachments.length > 0 ? (
                <View className="h-[44px] shrink-0 flex-row items-center gap-1 pl-1">
                  {stripAttachments.slice(0, COMPACT_ATTACHMENT_LIMIT).map((attachment) => (
                    <ComposerAttachmentThumbnail
                      environmentId={CHAT_ENVIRONMENT_ID}
                      key={attachment.id}
                      attachment={attachment}
                      size={30}
                      borderRadius={8}
                      compact
                    />
                  ))}
                  {stripAttachments.length > COMPACT_ATTACHMENT_LIMIT ? (
                    <View className="size-[30px] items-center justify-center rounded-lg bg-subtle-strong">
                      <AppText className="text-foreground-muted text-2xs font-t3-bold">
                        +{stripAttachments.length - COMPACT_ATTACHMENT_LIMIT}
                      </AppText>
                    </View>
                  ) : null}
                </View>
              ) : null}
              <View
                className="min-w-0 shrink flex-row items-center"
                style={
                  compactEditor.isExpanded ? { flex: 1, justifyContent: "flex-end" } : undefined
                }
              >
                {props.replying ? (
                  <ComposerActionButton
                    accessibilityLabel="Stop answer"
                    icon="stop.fill"
                    variant="danger"
                    onPress={props.onStop}
                  />
                ) : (
                  <ComposerActionButton
                    accessibilityLabel={pending.uploading ? "Uploading files" : "Send message"}
                    icon="arrow.up"
                    variant="primary"
                    disabled={!canSend}
                    onPress={submit}
                  />
                )}
              </View>
            </View>
            <Animated.View style={compactEditor.editorStyle}>
              <ComposerEditor
                multiline
                value={text}
                onChangeText={setText}
                placeholder="Ask anything..."
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                onPasteImages={(uris) =>
                  void convertPastedImagesToAttachments({
                    uris,
                    existingCount: stripAttachments.length,
                  }).then((attachments) => pending.add({ attachments, error: null }))
                }
                submitTitle="Send"
                onSubmit={submit}
                {...compactEditor.editorProps}
                textStyle={{ ...bodyText, color: foregroundColor }}
              />
            </Animated.View>
          </View>
        </ComposerSurface>
      </View>
    </View>
  );
}

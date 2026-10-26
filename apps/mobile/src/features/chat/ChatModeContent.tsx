import {
  chatAttachmentProblem,
  chatAttachmentUrl,
  type ChatReplyError,
} from "@t3tools/client-runtime/chat";
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
import Animated, { FadeIn, FadeInUp, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useResolveClassNames } from "uniwind";

import { ComposerActionButton } from "../../components/ComposerToolbar";
import { ComposerEditor } from "../../components/ComposerEditor";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { ComposerAttachmentButton } from "../threads/ComposerAttachmentButton";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { CopyTextButton } from "../threads/CopyTextButton";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import {
  ComposerSurface,
  THREAD_COMPOSER_BOTTOM_GUTTER,
  useCompactComposerEditor,
} from "../threads/ThreadComposer";
import { useMarkdownStyles } from "../threads/ThreadFeed";
import { pickChatDocuments, pickChatPhotos, type ChatFileToSend } from "./chatFiles";
import {
  miraChatHistory,
  openMiraUpgrade,
  uploadMiraAttachment,
  useMiraChatHistory,
  useMiraRelayUrl,
} from "./miraChat";

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
          />
        </View>
      ) : null}
      <ChatComposer
        busy={busy}
        expanded={chat === undefined}
        bottomInset={insets.bottom}
        onSend={send}
      />
    </Animated.View>
  );
}

function ChatMessages(props: {
  readonly chat: SaasChatConversation;
  readonly streaming: { readonly text: string; readonly searching?: boolean } | null;
}) {
  const scrollRef = useRef<ScrollViewInstance>(null);
  return (
    <ScrollView
      ref={scrollRef}
      className="flex-1"
      contentContainerClassName="px-4 pt-3 pb-4"
      keyboardDismissMode="interactive"
      onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      // The keyboard shrinks the list; keep the latest message in view, as threads do.
      onLayout={() => scrollRef.current?.scrollToEnd({ animated: false })}
    >
      {props.chat.messages.map((message) => (
        <ChatMessageRow key={message.id} message={message} />
      ))}
      {props.streaming === null ? null : props.streaming.text !== "" ? (
        <AssistantRow text={props.streaming.text} streaming />
      ) : null}
      {props.streaming !== null && (props.streaming.searching || props.streaming.text === "") ? (
        <AppText className="mb-5 px-1 text-sm text-foreground-muted">
          {props.streaming.searching ? "Searching the web…" : "Thinking…"}
        </AppText>
      ) : null}
    </ScrollView>
  );
}

// Same bubble, spacing and footer as a user message in the thread feed.
function ChatMessageRow(props: { readonly message: SaasChatMessage }) {
  const { message } = props;
  const styles = useMarkdownStyles();
  const { color: iconColor } = useResolveClassNames("text-icon-subtle");
  if (message.role !== "user") return <AssistantRow text={message.content} streaming={false} />;
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
      <SelectableMarkdownText
        markdown={props.text}
        textStyle={styles.assistant.nativeTextStyle}
        onLinkPress={(href) => void Linking.openURL(href)}
      />
      {props.streaming ? null : (
        <View className="mt-1 flex-row items-center gap-1">
          <CopyTextButton
            accessibilityLabel="Copy message"
            text={props.text}
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
}) {
  const action =
    props.error.code === "sign_up_required" || props.error.code === "session_expired"
      ? {
          label: props.error.code === "session_expired" ? "Sign in" : "Create free account",
          run: props.onSignIn,
        }
      : props.error.code === "daily_limit"
        ? { label: "Upgrade to Pro", run: props.onUpgrade }
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
              className="aspect-[1.3] w-full rounded-[14px] bg-user-bubble-foreground/15"
            />
          </Pressable>
        ) : (
          <FileChip key={attachment.id} name={attachment.name} />
        ),
      )}
    </View>
  );
}

function FileChip(props: {
  readonly name: string;
  readonly status?: string;
  readonly onRemove?: () => void;
}) {
  return (
    <View className="max-w-60 flex-row items-center gap-2 rounded-xl bg-subtle px-2.5 py-2">
      <SymbolView name="doc.text" size={16} tintColorClassName="accent-icon-subtle" />
      <View className="min-w-0 shrink">
        <AppText className="text-sm text-foreground" numberOfLines={1}>
          {props.name}
        </AppText>
        {props.status ? (
          <AppText className="text-xs text-foreground-muted">{props.status}</AppText>
        ) : null}
      </View>
      {props.onRemove ? (
        <Pressable accessibilityLabel={`Remove ${props.name}`} onPress={props.onRemove} hitSlop={8}>
          <SymbolView name="xmark.circle.fill" size={16} tintColorClassName="accent-icon-subtle" />
        </Pressable>
      ) : null}
    </View>
  );
}

interface PendingFile {
  readonly file: ChatFileToSend;
  readonly attachment: SaasChatAttachment | null;
  readonly error: string | null;
}

/** Picked files upload right away, so sending only waits on the reply. */
function usePendingFiles() {
  const [files, setFiles] = useState<ReadonlyArray<PendingFile>>([]);
  const update = (id: string, change: Partial<PendingFile>) =>
    setFiles((current) =>
      current.map((item) => (item.file.id === id ? { ...item, ...change } : item)),
    );
  const add = (picked: {
    readonly files: ReadonlyArray<ChatFileToSend>;
    readonly error: string | null;
  }) => {
    if (picked.error) Dialog.alert("Could not add the file", picked.error);
    for (const file of picked.files) {
      const problem = chatAttachmentProblem(file);
      if (problem !== null) {
        Dialog.alert("Could not add the file", problem);
        continue;
      }
      setFiles((current) => [...current, { file, attachment: null, error: null }]);
      void uploadMiraAttachment(file).then((result) =>
        update(file.id, result.ok ? { attachment: result.attachment } : { error: result.message }),
      );
    }
  };
  return {
    files,
    uploading: files.some((item) => item.attachment === null && item.error === null),
    ready: files.flatMap((item) => (item.attachment === null ? [] : [item.attachment])),
    remove: (id: string) => setFiles((current) => current.filter((item) => item.file.id !== id)),
    clear: () => setFiles([]),
    pickPhotos: async () => add(await pickChatPhotos(files.length)),
    pickDocuments: async () => add(await pickChatDocuments(files.length)),
  };
}

function PendingFiles(props: {
  readonly files: ReadonlyArray<PendingFile>;
  readonly onRemove: (id: string) => void;
}) {
  if (props.files.length === 0) return null;
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2 px-3 pt-2"
    >
      {props.files.map(({ file, attachment, error }) => {
        const status = error ?? (attachment === null ? "Uploading…" : undefined);
        return file.previewUri !== null ? (
          <View key={file.id} className="items-center gap-1">
            <Pressable
              accessibilityLabel={`Remove ${file.name}`}
              onPress={() => props.onRemove(file.id)}
            >
              <Image
                source={{ uri: file.previewUri }}
                contentFit="cover"
                className="size-14 rounded-[10px]"
                style={{ opacity: attachment === null ? 0.5 : 1 }}
              />
            </Pressable>
            {error ? (
              <AppText className="max-w-20 text-2xs text-danger" numberOfLines={2}>
                {error}
              </AppText>
            ) : null}
          </View>
        ) : (
          <FileChip
            key={file.id}
            name={file.name}
            {...(status ? { status } : {})}
            onRemove={() => props.onRemove(file.id)}
          />
        );
      })}
    </ScrollView>
  );
}

/**
 * The thread composer: tall with its toolbar for a new chat, the compact pill afterwards, with
 * the same attach button and editor and no model controls.
 */
function ChatComposer(props: {
  readonly busy: boolean;
  readonly expanded: boolean;
  readonly bottomInset: number;
  readonly onSend: (text: string, attachments: ReadonlyArray<SaasChatAttachment>) => void;
}) {
  const bodyText = useScaledTextRole("body");
  const { color: foregroundColor } = useResolveClassNames("text-foreground");
  const [text, setText] = useState("");
  const pending = usePendingFiles();
  const editor = useCompactComposerEditor(bodyText, text);
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
  const attachButton = (
    <ComposerAttachmentButton
      supportsFiles
      onPickMedia={pending.pickPhotos}
      onPickFiles={pending.pickDocuments}
    />
  );
  const sendButton = (
    <ComposerActionButton
      accessibilityLabel="Send"
      icon="arrow.up"
      variant="primary"
      disabled={!canSend}
      onPress={submit}
    />
  );
  const expanded = props.expanded || editor.isExpanded || pending.files.length > 0;
  return (
    <View
      className={Platform.OS === "android" ? "bg-composer-panel px-[12px]" : "px-[12px]"}
      style={{ paddingTop: 6, paddingBottom: props.bottomInset + THREAD_COMPOSER_BOTTOM_GUTTER }}
    >
      <ComposerSurface
        animateLayout={false}
        style={{
          borderRadius: expanded ? 24 : 27,
          borderCurve: "circular",
          overflow: "hidden",
          paddingVertical: 2,
        }}
      >
        {expanded ? (
          <View>
            <PendingFiles files={pending.files} onRemove={pending.remove} />
            <View className="min-h-[76px] px-[14px] pt-2">
              <ComposerEditor
                multiline
                value={text}
                onChangeText={setText}
                placeholder="Ask anything..."
                submitTitle="Send"
                onSubmit={submit}
                scrollEnabled
                style={{ maxHeight: bodyText.lineHeight * 6 }}
                textStyle={{ ...bodyText, color: foregroundColor }}
              />
            </View>
            <View className="h-[52px] flex-row items-center justify-between px-1.5">
              {attachButton}
              {sendButton}
            </View>
          </View>
        ) : (
          <View onLayout={editor.onRowLayout}>
            <View className="flex-row items-end">
              {attachButton}
              <Animated.View
                className="min-w-0 flex-1"
                onLayout={editor.onEditorLayout}
                style={[{ minWidth: "40%" }, editor.containerStyle]}
              />
              <View className="min-w-0 shrink flex-row items-center">{sendButton}</View>
            </View>
            <Animated.View style={editor.editorStyle}>
              <ComposerEditor
                multiline
                value={text}
                onChangeText={setText}
                placeholder="Ask anything..."
                submitTitle="Send"
                onSubmit={submit}
                {...editor.editorProps}
                textStyle={{ ...bodyText, color: foregroundColor }}
              />
            </Animated.View>
          </View>
        )}
      </ComposerSurface>
    </View>
  );
}

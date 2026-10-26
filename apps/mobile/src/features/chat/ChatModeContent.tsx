import type { ChatReplyError } from "@t3tools/client-runtime/chat";
import type { SaasChatConversation, SaasChatMessage } from "@t3tools/contracts/saas";
import { useNavigation } from "@react-navigation/native";
import { useRef, useState } from "react";
import { Linking, Platform, ScrollView, type ScrollViewInstance, View } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { FadeIn, FadeInUp, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useResolveClassNames } from "uniwind";

import { ComposerActionButton } from "../../components/ComposerToolbar";
import { ComposerEditor } from "../../components/ComposerEditor";
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
import { miraChatHistory, openMiraUpgrade, useMiraChatHistory } from "./miraChat";

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

  const send = (text: string) => {
    void miraChatHistory.send(chat?.id ?? null, text, (chatId) => {
      if (chatId !== props.chatId) props.onChatStarted(chatId);
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
          streamingText={history.streaming?.chatId === chat.id ? history.streaming.text : null}
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
      <ChatComposer busy={busy} bottomInset={insets.bottom} onSend={send} />
    </Animated.View>
  );
}

function ChatMessages(props: {
  readonly chat: SaasChatConversation;
  readonly streamingText: string | null;
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
      {props.streamingText === "" ? (
        <AppText className="mb-5 px-1 text-sm text-foreground-muted">Thinking…</AppText>
      ) : props.streamingText !== null ? (
        <AssistantRow text={props.streamingText} streaming />
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
          <SelectableMarkdownText
            markdown={message.content}
            textStyle={styles.user.nativeTextStyle}
            onLinkPress={(href) => void Linking.openURL(href)}
          />
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

// The thread composer's pill, editor and send button, without attachments or model controls.
function ChatComposer(props: {
  readonly busy: boolean;
  readonly bottomInset: number;
  readonly onSend: (text: string) => void;
}) {
  const bodyText = useScaledTextRole("body");
  const { color: foregroundColor } = useResolveClassNames("text-foreground");
  const [text, setText] = useState("");
  const editor = useCompactComposerEditor(bodyText, text);
  const canSend = !props.busy && text.trim() !== "";
  const submit = () => {
    if (!canSend) return;
    const trimmed = text.trim();
    setText("");
    props.onSend(trimmed);
  };
  return (
    <View
      className={Platform.OS === "android" ? "bg-composer-panel px-[12px]" : "px-[12px]"}
      style={{ paddingTop: 6, paddingBottom: props.bottomInset + THREAD_COMPOSER_BOTTOM_GUTTER }}
    >
      <ComposerSurface
        animateLayout={false}
        style={{
          borderRadius: 27,
          borderCurve: "circular",
          overflow: "hidden",
          paddingVertical: 2,
        }}
      >
        <View onLayout={editor.onRowLayout}>
          <View className="flex-row items-end pl-2">
            <Animated.View
              className="min-w-0 flex-1"
              onLayout={editor.onEditorLayout}
              style={[
                { minWidth: editor.isExpanded ? 0 : "40%" },
                editor.containerStyle,
                editor.isExpanded ? { flex: 0, width: 0 } : undefined,
              ]}
            />
            <View
              className="min-w-0 shrink flex-row items-center"
              style={editor.isExpanded ? { flex: 1, justifyContent: "flex-end" } : undefined}
            >
              <ComposerActionButton
                accessibilityLabel="Send"
                icon="arrow.up"
                variant="primary"
                disabled={!canSend}
                onPress={submit}
              />
            </View>
          </View>
          <Animated.View style={editor.editorStyle}>
            <ComposerEditor
              multiline
              value={text}
              onChangeText={setText}
              placeholder="Ask Mira anything"
              submitTitle="Send"
              onSubmit={submit}
              {...editor.editorProps}
              textStyle={{ ...bodyText, color: foregroundColor }}
            />
          </Animated.View>
        </View>
      </ComposerSurface>
    </View>
  );
}

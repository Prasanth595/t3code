import type { ChatReplyError } from "@t3tools/client-runtime/chat";
import type { SaasChatConversation } from "@t3tools/contracts/saas";
import { useNavigation } from "@react-navigation/native";
import { useRef, useState } from "react";
import { Linking, ScrollView, type ScrollViewInstance, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { IconButton } from "../../components/ui/IconButton";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useMarkdownStyles } from "../threads/ThreadFeed";
import {
  hasAgenticAccess,
  miraChatHistory,
  openMiraUpgrade,
  useMiraAccess,
  useMiraChatHistory,
} from "./miraChat";

/**
 * Chat mode: Mira answers from the account's model with no computer behind it, so it works on
 * a phone with nothing connected.
 */
export function ChatModeContent(props: {
  readonly chatId: string | null;
  readonly onChatStarted: (chatId: string) => void;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const history = useMiraChatHistory();
  const access = useMiraAccess();
  const chat =
    props.chatId === null ? undefined : history.chats.find((item) => item.id === props.chatId);
  const busy = history.streaming !== null;
  const error = history.error !== null && history.error.chatId === chat?.id ? history.error : null;

  const send = async (text: string) => {
    const chatId = await miraChatHistory.send(chat?.id ?? null, text);
    if (chatId !== props.chatId) props.onChatStarted(chatId);
  };

  const openAgentic = () => {
    if (hasAgenticAccess(access)) {
      navigation.navigate("Home");
      return;
    }
    Dialog.confirm({
      title: "Agentic mode is available with Pro",
      message: access.signedIn
        ? "With Pro, Mira works on your computer: it edits files, runs commands, and finishes tasks for you. Chat stays unlimited on every plan."
        : "Create a free account first. Then upgrade to Pro to let Mira work on your computer.",
      cancelText: "Not now",
      confirmText: access.signedIn ? "Upgrade to Pro" : "Create free account",
      onConfirm: () => {
        if (access.signedIn) void openMiraUpgrade().catch(() => undefined);
        else navigation.navigate("SettingsAuth");
      },
    });
  };

  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-screen">
      <View className="items-center px-4 pt-2 pb-1">
        <SegmentedControl
          size="compact"
          options={[
            { value: "chat", label: "Chat" },
            {
              value: "agentic",
              label: hasAgenticAccess(access) ? "Agentic" : "Agentic · Pro",
            },
          ]}
          selected="chat"
          onSelect={(value) => {
            if (value === "agentic") openAgentic();
          }}
        />
      </View>
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
      <View className="gap-2 px-4 pt-2" style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
        {error !== null ? (
          <ChatErrorNotice
            error={error}
            onSignIn={() => navigation.navigate("SettingsAuth")}
            onUpgrade={() => void openMiraUpgrade().catch(() => undefined)}
          />
        ) : null}
        <ChatComposer busy={busy} onSend={send} />
      </View>
    </KeyboardAvoidingView>
  );
}

function ChatMessages(props: {
  readonly chat: SaasChatConversation;
  readonly streamingText: string | null;
}) {
  const styles = useMarkdownStyles();
  const scrollRef = useRef<ScrollViewInstance>(null);
  return (
    <ScrollView
      ref={scrollRef}
      className="flex-1"
      contentContainerClassName="gap-4 px-4 py-4"
      keyboardDismissMode="interactive"
      onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
    >
      {props.chat.messages.map((message) =>
        message.role === "user" ? (
          <View
            key={message.id}
            className="max-w-[85%] self-end rounded-3xl bg-user-bubble px-4 py-2.5"
          >
            <AppText selectable className="text-base text-user-bubble-foreground">
              {message.content}
            </AppText>
          </View>
        ) : (
          <View key={message.id}>
            <SelectableMarkdownText
              markdown={message.content}
              textStyle={styles.assistant.nativeTextStyle}
              onLinkPress={(href) => void Linking.openURL(href)}
            />
          </View>
        ),
      )}
      {props.streamingText !== null ? (
        props.streamingText === "" ? (
          <AppText className="text-sm text-foreground-secondary">Thinking…</AppText>
        ) : (
          <SelectableMarkdownText
            markdown={props.streamingText}
            textStyle={styles.assistant.nativeTextStyle}
          />
        )
      ) : null}
    </ScrollView>
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

function ChatComposer(props: {
  readonly busy: boolean;
  readonly onSend: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const submit = () => {
    const trimmed = text.trim();
    if (trimmed === "" || props.busy) return;
    setText("");
    void props.onSend(trimmed);
  };
  return (
    <View className="flex-row items-end gap-2 rounded-3xl border border-border bg-card px-4 py-2">
      <AppTextInput
        accessibilityLabel="Message"
        placeholder="Ask Mira anything"
        multiline
        value={text}
        onChangeText={setText}
        className="max-h-40 min-h-10 flex-1 py-2 text-base"
      />
      <IconButton
        accessibilityLabel="Send"
        icon="arrow.up"
        variant="primary"
        disabled={props.busy || text.trim() === ""}
        onPress={submit}
      />
    </View>
  );
}

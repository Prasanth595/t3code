import { useNavigation } from "@react-navigation/native";
import type { SaasChatConversation } from "@t3tools/contracts/saas";
import * as Haptics from "expo-haptics";
import { useMemo } from "react";
import { Platform, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useResolveClassNames } from "uniwind";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { FloatingActionButton } from "../../components/ui/FloatingActionButton";
import { IconButton } from "../../components/ui/IconButton";
import { RowPressable } from "../../components/ui/RowPressable";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { androidHomeFabPosition } from "../home/AndroidHomeFab.shared";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { chatListSections, chatPreview, chatTimeLabel } from "./chatList";
import { miraChatHistory, useMiraChatHistory } from "./miraChat";

const confirmDelete = (chat: SaasChatConversation) =>
  Dialog.confirm({
    title: "Delete this chat?",
    message: "It is removed from every device signed in to your account.",
    cancelText: "Cancel",
    confirmText: "Delete",
    destructive: true,
    onConfirm: () => miraChatHistory.remove(chat.id),
  });

/** A chat: title, its latest message, and Delete behind a swipe or long press, as thread rows. */
function ChatListRow(props: {
  readonly chat: SaasChatConversation;
  readonly now: Date;
  readonly last: boolean;
  readonly onOpen: () => void;
}) {
  const { chat } = props;
  const { width } = useWindowDimensions();
  const { backgroundColor } = useResolveClassNames("bg-screen");
  const preview = chatPreview(chat);
  const deleteAction = useMemo(
    () => ({
      accessibilityLabel: `Delete ${chat.title}`,
      destructive: true,
      icon: "trash" as const,
      label: "Delete",
      onPress: () => confirmDelete(chat),
    }),
    [chat],
  );
  return (
    <ThreadSwipeable
      threadKey={chat.id}
      threadTitle={chat.title}
      resetKey={chat.id}
      backgroundColor={backgroundColor ?? "transparent"}
      enableTrackpadSwipe
      fullSwipeAction="primary"
      fullSwipeWidth={width - 32}
      onDelete={() => confirmDelete(chat)}
      primaryAction={deleteAction}
      secondaryAction={null}
    >
      {(_close, open) => (
        <RowPressable
          accessibilityRole="button"
          accessibilityLabel={chat.title}
          accessibilityHint="Opens the chat. Swipe left or long press to delete."
          className="bg-screen"
          interactionClassName="bg-row-hover"
          onPress={props.onOpen}
          onLongPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            open();
          }}
        >
          <View className="px-5 py-3">
            <View className="flex-row items-baseline gap-3">
              <Text
                className="min-w-0 flex-1 font-t3-semibold text-base text-foreground"
                numberOfLines={1}
              >
                {chat.title}
              </Text>
              <Text className="text-xs tabular-nums text-foreground-tertiary">
                {chatTimeLabel(chat.updatedAt, props.now)}
              </Text>
            </View>
            {preview !== "" ? (
              <Text className="mt-0.5 text-sm text-foreground-secondary" numberOfLines={2}>
                {preview}
              </Text>
            ) : null}
          </View>
          {props.last ? null : <View className="ml-5 h-px bg-border-subtle" />}
        </RowPressable>
      )}
    </ThreadSwipeable>
  );
}

function NewChatHeaderButton() {
  const navigation = useNavigation();
  return (
    <IconButton
      accessibilityLabel="New chat"
      icon="square.and.pencil"
      onPress={() => navigation.navigate("Chat", {})}
    />
  );
}

/** The Chats tab: every chat on the account, newest first, with New chat. */
export function ChatHome() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { chats, loaded } = useMiraChatHistory();
  const newChat = () => navigation.navigate("Chat", {});
  // Read per render; the list re-renders whenever a chat changes, which keeps day groups current.
  const now = new Date();
  return (
    <View className={Platform.OS === "android" ? "flex-1 bg-header" : "flex-1 bg-screen"}>
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Chats" />
        </>
      ) : (
        <NativeStackScreenOptions
          options={{
            title: "Chats",
            headerRight: NewChatHeaderButton,
          }}
        />
      )}
      <View
        className={
          Platform.OS === "android" ? "flex-1 overflow-hidden rounded-t-[28px] bg-screen" : "flex-1"
        }
      >
        {!loaded ? null : chats.length === 0 ? (
          <View className="flex-1 items-center justify-center px-4">
            <EmptyState
              variant="plain"
              title="No chats yet"
              detail="Ask Mira anything. Chat works without a connected computer."
              actionLabel={Platform.OS === "android" ? undefined : "New chat"}
              onAction={Platform.OS === "android" ? undefined : newChat}
            />
          </View>
        ) : (
          <ScrollView
            contentContainerClassName="pt-1 pb-28"
            contentInsetAdjustmentBehavior="automatic"
          >
            {chatListSections(chats, now).map((section) => (
              <View key={section.title} className="mb-2">
                <Text className="px-5 pb-1 pt-4 font-t3-semibold text-xs uppercase tracking-wide text-foreground-tertiary">
                  {section.title}
                </Text>
                {section.chats.map((chat, index) => (
                  <ChatListRow
                    key={chat.id}
                    chat={chat}
                    now={now}
                    last={index === section.chats.length - 1}
                    onOpen={() => navigation.navigate("Chat", { chatId: chat.id })}
                  />
                ))}
              </View>
            ))}
          </ScrollView>
        )}
      </View>
      {Platform.OS === "android" ? (
        <FloatingActionButton
          label="New chat"
          icon="plus.bubble"
          variant="extended"
          tone="primary"
          onPress={newChat}
          className="absolute"
          style={androidHomeFabPosition(insets.bottom, false)}
        />
      ) : null}
    </View>
  );
}

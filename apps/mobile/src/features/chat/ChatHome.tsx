import { useNavigation } from "@react-navigation/native";
import type { SaasChatSummary } from "@t3tools/contracts/saas";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { FloatingActionButton } from "../../components/ui/FloatingActionButton";
import { IconButton } from "../../components/ui/IconButton";
import { Menu } from "../../components/ui/Menu";
import { RowPressable } from "../../components/ui/RowPressable";
import { relativeTime } from "../../lib/time";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { androidHomeFabPosition } from "../home/AndroidHomeFab.shared";
import { THREAD_LIST_V2_MONO_FONT } from "../threads/thread-list-v2-row-appearance";
import { miraChatHistory, useMiraChatHistory } from "./miraChat";

const CHAT_ROW_MENU = [{ id: "delete", title: "Delete", attributes: { destructive: true } }];

/** A chat in the list, drawn like a settled thread row. */
function ChatListRow(props: { readonly chat: SaasChatSummary; readonly onOpen: () => void }) {
  return (
    <Menu
      actions={CHAT_ROW_MENU}
      shouldOpenOnLongPress
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event !== "delete") return;
        Dialog.confirm({
          title: "Delete this chat?",
          message: "It is removed from every device signed in to your account.",
          cancelText: "Cancel",
          confirmText: "Delete",
          destructive: true,
          onConfirm: () => miraChatHistory.remove(props.chat.id),
        });
      }}
    >
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={props.chat.title}
        className="bg-screen"
        interactionClassName="bg-row-hover"
        interactionOpacity={1}
        onPress={props.onOpen}
      >
        <View className="min-h-[44px] flex-row items-center gap-2.5 px-5 py-2">
          {/* Where a thread row shows its project icon. */}
          <View className="opacity-40">
            <SymbolView name="bubble.left" size={15} tintColorClassName="accent-foreground" />
          </View>
          <Text className={"min-w-0 flex-1 text-base text-foreground"} numberOfLines={1}>
            {props.chat.title}
          </Text>
          <Text
            className={"text-sm tabular-nums text-foreground-tertiary"}
            style={{ fontFamily: THREAD_LIST_V2_MONO_FONT }}
          >
            {relativeTime(props.chat.updatedAt)}
          </Text>
        </View>
      </RowPressable>
    </Menu>
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
            contentContainerClassName="pt-4 pb-28"
            contentInsetAdjustmentBehavior="automatic"
          >
            {chats.map((chat) => (
              <ChatListRow
                key={chat.id}
                chat={chat}
                onOpen={() => navigation.navigate("Chat", { chatId: chat.id })}
              />
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

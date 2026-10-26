import { useNavigation } from "@react-navigation/native";
import { ScrollView, View } from "react-native";

import { Button } from "../../components/ui/Button";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { ChatModeContent } from "./ChatModeContent";
import { useMiraChatHistory } from "./miraChat";

const RECENT_CHATS_IN_HEADER = 3;

/** The account's chats as a list section; the agentic home shows the latest few above threads. */
export function ChatHomeSection(props: { readonly limit?: number }) {
  const navigation = useNavigation();
  const { chats } = useMiraChatHistory();
  const shown = props.limit === undefined ? chats : chats.slice(0, props.limit);
  return (
    <ListSection
      title="Chats"
      trailing={
        <Button
          label="New chat"
          icon="plus.bubble"
          tone="text"
          onPress={() => navigation.navigate("Chat", {})}
        />
      }
    >
      {shown.map((chat) => (
        <ListRow
          key={chat.id}
          icon="bubble.left"
          label={chat.title}
          onPress={() => navigation.navigate("Chat", { chatId: chat.id })}
        />
      ))}
    </ListSection>
  );
}

export const ChatHomeHeader = () => <ChatHomeSection limit={RECENT_CHATS_IN_HEADER} />;

/**
 * Home for plans without agentic mode: straight into a new chat the first time, then the list
 * of chats.
 */
export function ChatHome() {
  const navigation = useNavigation();
  const { chats, loaded } = useMiraChatHistory();
  if (!loaded) return <View className="flex-1 bg-screen" />;
  if (chats.length === 0) {
    return (
      <ChatModeContent
        chatId={null}
        onChatStarted={(chatId) => navigation.navigate("Chat", { chatId })}
      />
    );
  }
  return (
    <ScrollView className="flex-1 bg-screen" contentContainerClassName="gap-4 px-4 py-4">
      <ChatHomeSection />
    </ScrollView>
  );
}

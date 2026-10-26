import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";

import { NativeStackScreenOptions } from "../../native/StackHeader";
import { ChatModeContent } from "./ChatModeContent";
import { useMiraChatHistory } from "./miraChat";

export function ChatRouteScreen({ route }: StaticScreenProps<{ readonly chatId?: string }>) {
  const navigation = useNavigation();
  const chatId = route.params?.chatId ?? null;
  const { chats } = useMiraChatHistory();
  const title = chats.find((chat) => chat.id === chatId)?.title ?? "New chat";
  return (
    <>
      <NativeStackScreenOptions options={{ title }} />
      <ChatModeContent
        key={chatId ?? "new"}
        chatId={chatId}
        onChatStarted={(id) => navigation.dispatch(StackActions.replace("Chat", { chatId: id }))}
      />
    </>
  );
}

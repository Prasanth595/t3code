import { CommonActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";

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
      {/* A new chat takes its id in place: replacing the screen slid it in again and closed the keyboard. */}
      <ChatModeContent
        chatId={chatId}
        onChatStarted={(id) => navigation.dispatch(CommonActions.setParams({ chatId: id }))}
      />
    </>
  );
}

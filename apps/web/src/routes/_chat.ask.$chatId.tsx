import { createFileRoute } from "@tanstack/react-router";

import { ChatModeView } from "../components/chatMode/ChatModeView";

export const Route = createFileRoute("/_chat/ask/$chatId")({
  component: ChatRouteView,
});

function ChatRouteView() {
  const { chatId } = Route.useParams();
  return <ChatModeView key={chatId} chatId={chatId} />;
}

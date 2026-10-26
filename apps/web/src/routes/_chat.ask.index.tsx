import { createFileRoute } from "@tanstack/react-router";

import { ChatModeView } from "../components/chatMode/ChatModeView";

export const Route = createFileRoute("/_chat/ask/")({
  component: () => <ChatModeView chatId={null} />,
});

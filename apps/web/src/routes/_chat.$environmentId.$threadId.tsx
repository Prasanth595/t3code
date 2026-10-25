import { createFileRoute } from "@tanstack/react-router";

import { retainThreadFindForThread } from "../components/chat/threadFindStore";
import { resolveThreadRouteTarget } from "../threadRoutes";

// The _chat layout owns ChatView so draft promotion keeps it mounted.
export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: () => null,
  // Find belongs to the thread it was opened in: switching threads or leaving closes it.
  onStay: ({ params }) => {
    const target = resolveThreadRouteTarget(params);
    retainThreadFindForThread(target?.kind === "server" ? target.threadRef : null);
  },
  onLeave: () => retainThreadFindForThread(null),
});

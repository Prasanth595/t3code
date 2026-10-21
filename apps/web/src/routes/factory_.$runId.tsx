import { createFileRoute, redirect } from "@tanstack/react-router";

// The run route was /factory/$runId before it carried the environment. Without this route an old
// link matches the chat route's $environmentId/$threadId; with it, the link lands on the runs list.
export const Route = createFileRoute("/factory_/$runId")({
  beforeLoad: () => {
    throw redirect({ to: "/factory", replace: true });
  },
});

import type { NewTaskDraftRouteParams } from "./NewTaskDraftRouteScreen";

export function isDraftThreadRoute(
  route:
    | {
        readonly name: string;
        readonly params?: object;
      }
    | undefined,
) {
  return (
    route?.name === "Thread" &&
    Boolean((route.params as { draft?: NewTaskDraftRouteParams } | undefined)?.draft)
  );
}

export function submittedThreadParams(environmentId: string, threadId: string) {
  return { draft: undefined, environmentId, threadId };
}

import {
  buildAdhdQueue as buildSharedAdhdQueue,
  type AdhdQueueEntry,
  type AdhdQueueThread,
} from "@t3tools/client-runtime/state/adhd-queue";

import { hasUnseenCompletion, resolveSidebarThreadStatus } from "../Sidebar.logic";

type WebAdhdQueueThread = AdhdQueueThread &
  Parameters<typeof resolveSidebarThreadStatus>[0] &
  Parameters<typeof hasUnseenCompletion>[0];

export function buildAdhdQueue<T extends WebAdhdQueueThread>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly lastVisitedAt: (thread: T) => string | undefined;
  /** Keys are `${environmentId}:${projectId}`, in sidebar order. */
  readonly projectOrder: ReadonlyArray<string>;
  readonly now: string;
}): AdhdQueueEntry<T>[] {
  return buildSharedAdhdQueue({
    ...input,
    status: resolveSidebarThreadStatus,
    hasUnseenCompletion: (thread, lastVisitedAt) =>
      hasUnseenCompletion({ ...thread, lastVisitedAt }),
  });
}

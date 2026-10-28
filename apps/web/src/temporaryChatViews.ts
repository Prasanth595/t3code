import { createTemporaryThreadView } from "@t3tools/client-runtime/temporary-threads";
import type { ScopedThreadRef } from "@t3tools/contracts";

type TemporaryView = ReturnType<typeof createTemporaryThreadView>;

export async function completeTemporaryChatLaunch(input: {
  readonly threadRef: ScopedThreadRef;
  readonly isCurrent: boolean;
  readonly view: TemporaryView;
  readonly background: boolean;
  readonly send: (payloads: ReturnType<TemporaryView["reconnect"]>) => Promise<boolean>;
}): Promise<boolean> {
  if (input.isCurrent) {
    input.view.update({
      environmentId: input.threadRef.environmentId,
      threadIds: [input.threadRef.threadId],
      background: input.background,
    });
    return input.send(input.view.reconnect());
  }
  const departedView = createTemporaryThreadView();
  const attach = departedView.update({
    environmentId: input.threadRef.environmentId,
    threadIds: [input.threadRef.threadId],
  });
  const leave = departedView.update({
    environmentId: input.threadRef.environmentId,
    threadIds: [],
  });
  return input.send([...attach, ...leave]);
}

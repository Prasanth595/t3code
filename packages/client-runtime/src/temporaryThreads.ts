import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

const temporaryThreads = new Map<string, Map<string, "temporary" | "deleted">>();
const listeners = new Map<string, Set<() => void>>();
const threadKey = (environmentId: string, threadId: string) =>
  JSON.stringify([environmentId, threadId]);

const notifyThread = (environmentId: string, threadId: string) => {
  for (const notify of listeners.get(threadKey(environmentId, threadId)) ?? []) notify();
};

export const temporaryThreadAtom = Atom.family((ref: ScopedThreadRef) =>
  Atom.make((get) => {
    const key = threadKey(ref.environmentId, ref.threadId);
    const notify = () => get.setSelf(isTemporaryThread(ref.environmentId, ref.threadId));
    const subscribers = listeners.get(key) ?? new Set<() => void>();
    listeners.set(key, subscribers);
    subscribers.add(notify);
    get.addFinalizer(() => {
      subscribers.delete(notify);
      if (subscribers.size === 0) listeners.delete(key);
    });
    return isTemporaryThread(ref.environmentId, ref.threadId);
  }),
);

export function setTemporaryThread(
  environmentId: string,
  threadId: string,
  temporary: boolean,
): void {
  if (!temporary) {
    if (temporaryThreads.get(environmentId)?.get(threadId) !== "deleted") {
      forgetTemporaryThread(environmentId, threadId);
    }
    return;
  }
  let threads = temporaryThreads.get(environmentId);
  if (threads === undefined) {
    threads = new Map();
    temporaryThreads.set(environmentId, threads);
  }
  if (!threads.has(threadId)) {
    threads.set(threadId, "temporary");
    notifyThread(environmentId, threadId);
  }
}

export function markTemporaryThreadDeleted(environmentId: string, threadId: string): void {
  const threads = temporaryThreads.get(environmentId);
  if (threads?.has(threadId)) threads.set(threadId, "deleted");
}

export function isTemporaryThread(environmentId: string, threadId: string): boolean {
  return temporaryThreads.get(environmentId)?.has(threadId) === true;
}

export function forgetTemporaryThread(environmentId: string, threadId: string): void {
  const threads = temporaryThreads.get(environmentId);
  if (threads?.delete(threadId)) {
    if (threads.size === 0) temporaryThreads.delete(environmentId);
    notifyThread(environmentId, threadId);
  }
}

export function createTemporaryThreadView(
  options: { readonly viewId?: string; readonly generation?: number } = {},
) {
  const viewId =
    options.viewId ??
    Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  let generation = options.generation ?? 0;
  let current:
    | { environmentId: string; threadIds: ReadonlyArray<string>; background: boolean }
    | undefined;
  const payload = (value: NonNullable<typeof current>) => ({
    environmentId: EnvironmentId.make(value.environmentId),
    input: {
      viewId,
      generation,
      threadIds: value.threadIds.map((id) => ThreadId.make(id)),
      background: value.background,
    },
  });
  return {
    viewId,
    update(next: {
      readonly environmentId: string;
      readonly threadIds: ReadonlyArray<string>;
      readonly background?: boolean;
    }) {
      const value = {
        ...next,
        threadIds: [...new Set(next.threadIds)],
        background: next.background ?? false,
      };
      const previous = current;
      current = value;
      if (
        previous?.environmentId === value.environmentId &&
        previous.background === value.background &&
        previous.threadIds.length === value.threadIds.length &&
        previous.threadIds.every((id, index) => id === value.threadIds[index])
      )
        return [];
      if (previous !== undefined) generation += 1;
      return [
        payload(value),
        ...(previous !== undefined && previous.environmentId !== value.environmentId
          ? [payload({ environmentId: previous.environmentId, threadIds: [], background: false })]
          : []),
      ];
    },
    reconnect() {
      generation += 1;
      return current === undefined ? [] : [payload(current)];
    },
  };
}

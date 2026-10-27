import {
  ChatHistory,
  type ChatHistoryState,
  type MiraAccess,
  MiraAccessStore,
  relayChatHistoryRemote,
  requestChatReply,
  uploadChatAttachment,
  type ChatUploadResult,
} from "@t3tools/client-runtime/chat";
import { ManagedRelay, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import { useEffect, useState, useSyncExternalStore } from "react";

import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export { hasAgenticAccess } from "@t3tools/client-runtime/chat";

const STORAGE_KEY = "mira:chat-history:v1";

/** The signed-in Clerk token, or null without an account. */
function readMiraClerkToken(): Promise<string | null> {
  const session = appAtomRegistry.get(managedRelaySessionAtom);
  if (!session) return Promise.resolve(null);
  return runtime.runPromise(session.readClerkToken().pipe(Effect.orElseSucceed(() => null)));
}

const relayUrl = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      return (yield* ManagedRelay.ManagedRelayClient).relayUrl;
    }),
  );

export const miraChatHistory = new ChatHistory({
  storage: {
    load: async () => window.localStorage.getItem(STORAGE_KEY),
    save: async (value) => window.localStorage.setItem(STORAGE_KEY, value),
  },
  requestReply: async (request, deviceId) => {
    const [url, clerkToken] = await Promise.all([relayUrl(), readMiraClerkToken()]);
    return requestChatReply({ ...request, relayUrl: url, clerkToken, deviceId });
  },
});

void miraChatHistory.load();

/** Stores a picked photo or document on the relay for the next message. */
export async function uploadMiraAttachment(file: File): Promise<ChatUploadResult> {
  await miraChatHistory.load();
  const [url, clerkToken] = await Promise.all([relayUrl(), readMiraClerkToken()]);
  return uploadChatAttachment({
    relayUrl: url,
    clerkToken,
    deviceId: miraChatHistory.deviceId,
    name: file.name,
    mimeType: file.type,
    body: file,
  });
}

let knownRelayUrl: string | null = null;

/** The relay's address, for linking stored files; null until it is read once. */
export function useMiraRelayUrl(): string | null {
  const [url, setUrl] = useState(knownRelayUrl);
  useEffect(() => {
    if (url !== null) return;
    void relayUrl().then((value) => {
      knownRelayUrl = value;
      setUrl(value);
    });
  }, [url]);
  return url;
}

export const miraChatRemote = (accountId: string) =>
  relayChatHistoryRemote({
    accountId,
    readClerkToken: readMiraClerkToken,
    run: (effect) => runtime.runPromise(effect),
  });

export function useMiraChatHistory(): ChatHistoryState {
  return useSyncExternalStore(miraChatHistory.subscribe, miraChatHistory.getSnapshot);
}

export const miraAccess = new MiraAccessStore();

export function useMiraAccess(): MiraAccess {
  return useSyncExternalStore(miraAccess.subscribe, miraAccess.getSnapshot);
}

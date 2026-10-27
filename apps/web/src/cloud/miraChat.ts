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
const DATABASE_NAME = "mira-chat";
const STORE_NAME = "history";

// localStorage caps an origin at about 5 MB, which a history with visuals outgrows.
let database: Promise<IDBDatabase> | undefined;
function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore(STORE_NAME));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  }));
}

async function historyStore(mode: IDBTransactionMode) {
  return (await openDatabase()).transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

function settled<A>(request: IDBRequest<A>) {
  return new Promise<A>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

async function loadHistory(): Promise<string | null> {
  const stored: unknown = await settled((await historyStore("readonly")).get(STORAGE_KEY));
  return typeof stored === "string" ? stored : window.localStorage.getItem(STORAGE_KEY);
}

async function saveHistory(value: string) {
  await settled((await historyStore("readwrite")).put(value, STORAGE_KEY));
  window.localStorage.removeItem(STORAGE_KEY);
}

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
  storage: { load: loadHistory, save: saveHistory },
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

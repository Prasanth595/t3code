import {
  ChatHistory,
  type ChatHistoryRemote,
  type ChatHistoryState,
  requestChatReply,
} from "@t3tools/client-runtime/chat";
import { ManagedRelay, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import type { SaasAccountResponse } from "@t3tools/contracts/saas";
import * as Effect from "effect/Effect";
import { useSyncExternalStore } from "react";

import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

const STORAGE_KEY = "mira:chat-history:v1";

/** The signed-in Clerk token, or null without an account. */
export function readMiraClerkToken(): Promise<string | null> {
  const session = appAtomRegistry.get(managedRelaySessionAtom);
  if (!session) return Promise.resolve(null);
  return runtime.runPromise(session.readClerkToken().pipe(Effect.orElseSucceed(() => null)));
}

const relayClient = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      return yield* ManagedRelay.ManagedRelayClient;
    }),
  );

export const miraChatHistory = new ChatHistory({
  storage: {
    load: async () => window.localStorage.getItem(STORAGE_KEY),
    save: async (value) => window.localStorage.setItem(STORAGE_KEY, value),
  },
  requestReply: async (request, deviceId) => {
    const [client, clerkToken] = await Promise.all([relayClient(), readMiraClerkToken()]);
    return requestChatReply({ ...request, relayUrl: client.relayUrl, clerkToken, deviceId });
  },
});

/** The account's chats on the relay, for the signed-in user. */
export function miraChatRemote(accountId: string): ChatHistoryRemote {
  const call = async <A>(
    request: (
      client: ManagedRelay.ManagedRelayClient["Service"],
      clerkToken: string,
    ) => Effect.Effect<A, ManagedRelay.ManagedRelayClientError>,
  ): Promise<A> => {
    const clerkToken = await readMiraClerkToken();
    if (clerkToken === null) throw new Error("Signed out");
    return runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* ManagedRelay.ManagedRelayClient;
        return yield* request(client, clerkToken);
      }),
    );
  };
  return {
    accountId,
    list: () => call((client, clerkToken) => client.listChats({ clerkToken })),
    get: (chatId) => call((client, clerkToken) => client.getChat({ clerkToken, chatId })),
    save: async (chat) => {
      await call((client, clerkToken) => client.saveChat({ clerkToken, chat }));
    },
    delete: async (chatId) => {
      await call((client, clerkToken) => client.deleteChat({ clerkToken, chatId }));
    },
  };
}

export function useMiraChatHistory(): ChatHistoryState {
  return useSyncExternalStore(miraChatHistory.subscribe, miraChatHistory.getSnapshot);
}

export interface MiraAccess {
  /** False until the account is known, and in builds without Mira accounts. */
  readonly signedIn: boolean;
  readonly account: SaasAccountResponse | null;
  /** Opens Clerk's sign-in, which also offers creating an account. */
  readonly openSignIn: (() => void) | null;
}

let access: MiraAccess = { signedIn: false, account: null, openSignIn: null };
const accessListeners = new Set<() => void>();

/** Set by the account sync, which is the only part of the app under Clerk. */
export function setMiraAccess(next: MiraAccess) {
  access = next;
  for (const listener of accessListeners) listener();
}

const subscribeAccess = (listener: () => void) => {
  accessListeners.add(listener);
  return () => {
    accessListeners.delete(listener);
  };
};

export function useMiraAccess(): MiraAccess {
  return useSyncExternalStore(subscribeAccess, () => access);
}

/** Agentic mode needs a plan that includes it. */
export const hasAgenticAccess = (state: MiraAccess) => state.account?.plan.agenticEnabled === true;

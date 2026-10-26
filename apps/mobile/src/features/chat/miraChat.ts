import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  ChatHistory,
  type ChatHistoryState,
  type MiraAccess,
  MiraAccessStore,
  relayChatHistoryRemote,
  requestChatReply,
} from "@t3tools/client-runtime/chat";
import { ManagedRelay, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import type { SaasAccountResponse } from "@t3tools/contracts/saas";
import * as Effect from "effect/Effect";
import { getRandomBytes } from "expo-crypto";
import { fetch as expoFetch } from "expo/fetch";
import { useSyncExternalStore } from "react";
import { Linking } from "react-native";

import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";

export { hasAgenticAccess } from "@t3tools/client-runtime/chat";

const STORAGE_KEY = "mira.chatHistory.v1";
// The paid plan Upgrade buys; admins set its Stripe price in the admin page.
const UPGRADE_PLAN_ID = "pro";

/** The signed-in Clerk token, or null without an account. */
function readMiraClerkToken(): Promise<string | null> {
  const session = appAtomRegistry.get(managedRelaySessionAtom);
  if (!session) return Promise.resolve(null);
  return runtime.runPromise(session.readClerkToken().pipe(Effect.orElseSucceed(() => null)));
}

const withRelay = <A>(
  request: (
    client: ManagedRelay.ManagedRelayClient["Service"],
    clerkToken: string,
  ) => Effect.Effect<A, ManagedRelay.ManagedRelayClientError>,
): Promise<A> =>
  readMiraClerkToken().then((clerkToken) => {
    if (clerkToken === null) throw new Error("Sign in to your Mira account first.");
    return runtime.runPromise(
      Effect.gen(function* () {
        return yield* request(yield* ManagedRelay.ManagedRelayClient, clerkToken);
      }),
    );
  });

export const fetchMiraAccount = (): Promise<SaasAccountResponse> =>
  withRelay((client, clerkToken) => client.getAccount({ clerkToken }));

export async function openMiraUpgrade(): Promise<void> {
  const { url } = await withRelay((client, clerkToken) =>
    client.createCheckout({ clerkToken, planId: UPGRADE_PLAN_ID }),
  );
  await Linking.openURL(url);
}

const relayUrl = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      return (yield* ManagedRelay.ManagedRelayClient).relayUrl;
    }),
  );

export const miraChatHistory = new ChatHistory({
  randomBytes: getRandomBytes,
  storage: {
    load: () => AsyncStorage.getItem(STORAGE_KEY),
    save: (value) => AsyncStorage.setItem(STORAGE_KEY, value),
  },
  requestReply: async (request, deviceId) => {
    const [url, clerkToken] = await Promise.all([relayUrl(), readMiraClerkToken()]);
    return requestChatReply({
      ...request,
      relayUrl: url,
      clerkToken,
      deviceId,
      // React Native's own fetch cannot stream a response body.
      fetch: expoFetch as unknown as typeof globalThis.fetch,
    });
  },
});

void miraChatHistory.load();

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

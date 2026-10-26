import * as Effect from "effect/Effect";

import * as ManagedRelay from "../relay/managedRelay.ts";
import type { ChatHistoryRemote } from "./chatHistory.ts";

/** The signed-in account's chats through the relay client each app already runs. */
export function relayChatHistoryRemote(input: {
  readonly accountId: string;
  readonly readClerkToken: () => Promise<string | null>;
  readonly run: <A>(
    effect: Effect.Effect<A, ManagedRelay.ManagedRelayClientError, ManagedRelay.ManagedRelayClient>,
  ) => Promise<A>;
}): ChatHistoryRemote {
  const call = async <A>(
    request: (
      client: ManagedRelay.ManagedRelayClient["Service"],
      clerkToken: string,
    ) => Effect.Effect<A, ManagedRelay.ManagedRelayClientError>,
  ): Promise<A> => {
    const clerkToken = await input.readClerkToken();
    if (clerkToken === null) throw new Error("Signed out of the Mira account.");
    return input.run(
      Effect.gen(function* () {
        const client = yield* ManagedRelay.ManagedRelayClient;
        return yield* request(client, clerkToken);
      }),
    );
  };
  return {
    accountId: input.accountId,
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

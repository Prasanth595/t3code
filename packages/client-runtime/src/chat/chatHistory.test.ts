import type { SaasChatConversation } from "@t3tools/contracts/saas";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { ChatHistory, type ChatHistoryRemote, chatTitle } from "./chatHistory.ts";
import type { ChatReplyResult } from "./chatReply.ts";
import { ChatSseDecoder } from "./chatReply.ts";

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    load: async () => value,
    save: async (next: string) => {
      value = next;
    },
    read: () => value,
  };
}

function memoryRemote(accountId: string, chats: Array<SaasChatConversation> = []) {
  const store = new Map(chats.map((chat) => [chat.id, chat]));
  const remote: ChatHistoryRemote = {
    accountId,
    list: async () =>
      [...store.values()].map(({ id, title, createdAt, updatedAt }) => ({
        id,
        title,
        createdAt,
        updatedAt,
      })),
    get: async (chatId) => {
      const chat = store.get(chatId);
      if (chat === undefined) throw new Error("missing");
      return chat;
    },
    save: async (chat) => {
      store.set(chat.id, chat);
    },
    delete: async (chatId) => {
      store.delete(chatId);
    },
  };
  return { remote, store };
}

function makeHistory(options: {
  readonly reply?: ChatReplyResult;
  readonly storage?: ReturnType<typeof memoryStorage>;
}) {
  let tick = 0;
  const storage = options.storage ?? memoryStorage();
  const history = new ChatHistory({
    storage,
    now: () =>
      DateTime.formatIso(
        DateTime.add(DateTime.makeUnsafe("2026-10-26T00:00:00.000Z"), { seconds: tick++ }),
      ),
    requestReply: async (request) => {
      request.onText("Hel");
      return options.reply ?? { ok: true, text: "Hello" };
    },
  });
  return { history, storage };
}

const remoteChat = (id: string, updatedAt: string): SaasChatConversation => ({
  id,
  title: `Chat ${id}`,
  createdAt: updatedAt,
  updatedAt,
  messages: [{ id: `${id}-m1`, role: "user", content: "Hi", createdAt: updatedAt }],
});

describe("ChatHistory", () => {
  it("keeps the question and the reply, titled after the first message", async () => {
    const { history } = makeHistory({});
    const chatId = await history.send(null, "  What is a black hole?\nExplain simply  ");
    const [chat] = history.getSnapshot().chats;
    expect(chat?.id).toBe(chatId);
    expect(chat?.title).toBe("What is a black hole?");
    expect(chat?.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "What is a black hole?\nExplain simply"],
      ["assistant", "Hello"],
    ]);
    expect(history.getSnapshot().streaming).toBeNull();
  });

  it("reports a refused reply on its chat and keeps the question", async () => {
    const { history } = makeHistory({
      reply: { ok: false, code: "sign_up_required", message: "Create a free account." },
    });
    const chatId = await history.send(null, "Hi");
    expect(history.getSnapshot().error).toEqual({
      chatId,
      code: "sign_up_required",
      message: "Create a free account.",
    });
    expect(history.getSnapshot().chats[0]?.messages).toHaveLength(1);
  });

  it("moves chats from before sign-in into the account and pulls the account's chats", async () => {
    const { history } = makeHistory({});
    await history.send(null, "Before signing in");
    const { remote, store } = memoryRemote("user_1", [
      remoteChat("phone", "2026-10-25T10:00:00.000Z"),
    ]);
    await history.setRemote(remote);
    expect([...store.values()].map((chat) => chat.title)).toContain("Before signing in");
    expect(history.getSnapshot().chats.map((chat) => chat.title)).toEqual([
      "Before signing in",
      "Chat phone",
    ]);
  });

  it("drops a chat deleted on another device, and the account's chats on sign-out", async () => {
    const { history } = makeHistory({});
    const { remote, store } = memoryRemote("user_1", [
      remoteChat("a", "2026-10-25T10:00:00.000Z"),
      remoteChat("b", "2026-10-25T11:00:00.000Z"),
    ]);
    await history.setRemote(remote);
    store.delete("a");
    await history.sync();
    expect(history.getSnapshot().chats.map((chat) => chat.id)).toEqual(["b"]);

    await history.setRemote(null);
    expect(history.getSnapshot().chats).toEqual([]);
  });

  it("restores the history and device id after a restart", async () => {
    const first = makeHistory({});
    await first.history.send(null, "Remember me");
    const second = makeHistory({ storage: memoryStorage(first.storage.read()) });
    await second.history.load();
    expect(second.history.deviceId).toBe(first.history.deviceId);
    expect(second.history.getSnapshot().chats[0]?.title).toBe("Remember me");
  });

  it("titles empty and long first messages", () => {
    expect(chatTitle("   ")).toBe("New chat");
    expect(chatTitle("x".repeat(100))).toHaveLength(60);
  });
});

describe("ChatSseDecoder", () => {
  it("collects reply text split across chunks", () => {
    const decoder = new ChatSseDecoder();
    decoder.push('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"de');
    expect(decoder.text).toBe("Hel");
    decoder.push('lta":{"content":"lo"}}]}\n\ndata: [DONE]\n');
    decoder.finish();
    expect(decoder.text).toBe("Hello");
  });
});

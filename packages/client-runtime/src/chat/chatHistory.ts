import {
  SAAS_MAX_LISTED_CHATS,
  SaasChatConversation,
  type SaasChatAttachment,
  type SaasChatMessage,
  type SaasChatSummary,
} from "@t3tools/contracts/saas";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ChatReplyErrorCode, ChatReplyRequest, ChatReplyResult } from "./chatReply.ts";

/** Where a client keeps the chat history between launches. */
export interface ChatHistoryStorage {
  readonly load: () => Promise<string | null>;
  readonly save: (value: string) => Promise<void>;
}

/** The account's copy of the history on the relay. */
export interface ChatHistoryRemote {
  readonly accountId: string;
  readonly list: () => Promise<ReadonlyArray<SaasChatSummary>>;
  readonly get: (chatId: string) => Promise<SaasChatConversation>;
  readonly save: (chat: SaasChatConversation) => Promise<void>;
  readonly delete: (chatId: string) => Promise<void>;
}

export interface ChatReplyError {
  readonly chatId: string;
  readonly code: ChatReplyErrorCode;
  readonly message: string;
}

/** Failures that may pass on their own, so the question can be asked again as is. */
export const isRetryable = (error: ChatReplyError) =>
  error.code === "network" ||
  error.code === "upstream_unavailable" ||
  error.code === "model_unavailable";

export interface ChatHistoryState {
  readonly loaded: boolean;
  /** Newest first. */
  readonly chats: ReadonlyArray<SaasChatConversation>;
  /** The reply streaming in right now, keyed by its chat; `searching` while Mira searches. */
  readonly streaming: {
    readonly chatId: string;
    readonly text: string;
    readonly searching?: boolean;
  } | null;
  readonly error: ChatReplyError | null;
}

const MAX_TITLE_LENGTH = 60;

const StoredHistory = Schema.Struct({
  deviceId: Schema.String,
  /** The account the synced chats belong to; null while signed out. */
  owner: Schema.NullOr(Schema.String),
  chats: Schema.Array(SaasChatConversation),
  /** Changed since the relay last confirmed them, including chats from before sign-in. */
  dirty: Schema.Array(Schema.String),
  /** Known to the relay, so a missing one there was deleted on another device. */
  synced: Schema.Array(Schema.String),
});
type StoredHistory = typeof StoredHistory.Type;
const StoredHistoryJson = Schema.fromJsonString(StoredHistory);
const decodeStored = Schema.decodeUnknownOption(StoredHistoryJson);
const encodeStored = Schema.encodeSync(StoredHistoryJson);

export const chatTitle = (text: string) => {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  if (line === "") return "New chat";
  return line.length > MAX_TITLE_LENGTH ? `${line.slice(0, MAX_TITLE_LENGTH - 1)}…` : line;
};

const byNewest = (left: SaasChatConversation, right: SaasChatConversation) =>
  right.updatedAt.localeCompare(left.updatedAt);

// `crypto.randomUUID` is missing over plain-HTTP LAN origins; random bytes are not.
const webRandomBytes = (count: number) => globalThis.crypto.getRandomValues(new Uint8Array(count));

export interface ChatHistoryOptions {
  readonly storage: ChatHistoryStorage;
  readonly requestReply: (
    request: Omit<ChatReplyRequest, "relayUrl" | "clerkToken" | "deviceId">,
    deviceId: string,
  ) => Promise<ChatReplyResult>;
  readonly now?: () => string;
  /** Hermes has no Web Crypto, so React Native passes its own source of random bytes. */
  readonly randomBytes?: (count: number) => Uint8Array;
}

/**
 * Chat mode's conversations. They live on the device, and while an account is attached every
 * change also goes to the relay, so the account's other devices see the same history.
 */
export class ChatHistory {
  private state: ChatHistoryState = { loaded: false, chats: [], streaming: null, error: null };
  private stored: StoredHistory;
  private readonly listeners = new Set<() => void>();
  private remote: ChatHistoryRemote | null = null;
  private loading: Promise<void> | null = null;
  private syncing: Promise<void> = Promise.resolve();
  private readonly now: () => string;
  private readonly options: ChatHistoryOptions;

  constructor(options: ChatHistoryOptions) {
    this.options = options;
    this.now = options.now ?? (() => DateTime.formatIso(DateTime.nowUnsafe()));
    this.stored = { deviceId: this.randomId(), owner: null, chats: [], dirty: [], synced: [] };
  }

  private randomId() {
    const bytes = (this.options.randomBytes ?? webRandomBytes)(16);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.state;

  get deviceId() {
    return this.stored.deviceId;
  }

  load(): Promise<void> {
    this.loading ??= this.options.storage
      .load()
      .catch(() => null)
      .then((raw) => {
        const stored = raw === null ? Option.none() : decodeStored(raw);
        if (Option.isSome(stored)) this.stored = stored.value;
        else void this.persist();
        this.publish({ loaded: true, chats: [...this.stored.chats].sort(byNewest) });
      });
    return this.loading;
  }

  /**
   * Attaches the signed-in account, or detaches with null. Chats made before signing in move
   * into the account; signing out removes the account's chats from this device.
   */
  async setRemote(remote: ChatHistoryRemote | null): Promise<void> {
    await this.load();
    this.remote = remote;
    const owner = remote?.accountId ?? null;
    if (this.stored.owner !== null && this.stored.owner !== owner) {
      const synced = new Set(this.stored.synced);
      this.stored = {
        ...this.stored,
        chats: this.stored.chats.filter((chat) => !synced.has(chat.id)),
        dirty: this.stored.dirty.filter((id) => !synced.has(id)),
        synced: [],
      };
    }
    this.stored = { ...this.stored, owner };
    this.commit();
    if (remote !== null) await this.sync();
  }

  /** Pulls the account's chats and pushes local changes. Safe to call often. */
  sync(): Promise<void> {
    this.syncing = this.syncing.then(() => this.syncOnce()).catch(() => {});
    return this.syncing;
  }

  private async syncOnce() {
    const remote = this.remote;
    if (remote === null) return;
    for (const id of this.stored.dirty) await this.push(remote, id);
    const summaries = await remote.list();
    if (this.remote !== remote) return;
    const remoteIds = new Set(summaries.map((summary) => summary.id));
    const dirty = new Set(this.stored.dirty);
    const local = new Map(this.stored.chats.map((chat) => [chat.id, chat]));
    const fetched: Array<SaasChatConversation> = [];
    for (const summary of summaries) {
      const mine = local.get(summary.id);
      if (dirty.has(summary.id) || (mine !== undefined && mine.updatedAt >= summary.updatedAt)) {
        continue;
      }
      fetched.push(await remote.get(summary.id));
    }
    if (this.remote !== remote) return;
    const synced = new Set(this.stored.synced);
    const updated = new Map(fetched.map((chat) => [chat.id, chat]));
    // A full listing leaves out older chats rather than deleted ones.
    const listedFrom =
      summaries.length >= SAAS_MAX_LISTED_CHATS
        ? summaries.reduce(
            (oldest, summary) => (summary.updatedAt < oldest ? summary.updatedAt : oldest),
            summaries[0]?.updatedAt ?? "",
          )
        : "";
    const chats = [
      ...this.stored.chats
        .filter(
          (chat) =>
            remoteIds.has(chat.id) ||
            !synced.has(chat.id) ||
            dirty.has(chat.id) ||
            chat.updatedAt < listedFrom,
        )
        .map((chat) => updated.get(chat.id) ?? chat),
      ...fetched.filter((chat) => !local.has(chat.id)),
    ];
    this.stored = {
      ...this.stored,
      chats,
      synced: [...new Set([...remoteIds, ...this.stored.synced.filter((id) => remoteIds.has(id))])],
    };
    this.commit();
  }

  private async push(remote: ChatHistoryRemote, chatId: string) {
    const chat = this.stored.chats.find((candidate) => candidate.id === chatId);
    if (chat === undefined) {
      await remote.delete(chatId);
    } else {
      await remote.save(chat);
    }
    if (this.remote !== remote) return;
    const latest = this.stored.chats.find((candidate) => candidate.id === chatId);
    // A change made while the save was in flight stays dirty for the next push.
    if (latest !== chat) return;
    this.stored = {
      ...this.stored,
      dirty: this.stored.dirty.filter((id) => id !== chatId),
      synced:
        chat === undefined
          ? this.stored.synced.filter((id) => id !== chatId)
          : [...new Set([...this.stored.synced, chatId])],
    };
    this.commit();
  }

  /**
   * Sends a message, starting a new chat when `chatId` is null. `onStarted` gets the chat's id as
   * soon as the question is saved, before the reply streams; the promise resolves with it too.
   */
  async send(
    chatId: string | null,
    text: string,
    options: {
      readonly attachments?: ReadonlyArray<SaasChatAttachment>;
      readonly onStarted?: (chatId: string) => void;
    } = {},
  ): Promise<string> {
    await this.load();
    const content = text.trim();
    const attachments = options.attachments ?? [];
    const now = this.now();
    const existing = chatId === null ? undefined : this.find(chatId);
    const userMessage: SaasChatMessage = {
      id: this.randomId(),
      role: "user",
      content,
      createdAt: now,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    const chat: SaasChatConversation = existing
      ? { ...existing, updatedAt: now, messages: [...existing.messages, userMessage] }
      : {
          id: this.randomId(),
          title: chatTitle(content || attachments[0]?.name || ""),
          createdAt: now,
          updatedAt: now,
          messages: [userMessage],
        };
    this.write(chat);
    this.publish({ streaming: { chatId: chat.id, text: "" }, error: null });
    options.onStarted?.(chat.id);
    await this.reply(chat);
    return chat.id;
  }

  /** Asks again for the reply to a chat whose last question went unanswered. */
  async retry(chatId: string): Promise<void> {
    await this.load();
    const chat = this.find(chatId);
    if (chat === undefined || chat.messages.at(-1)?.role !== "user") return;
    if (this.state.streaming !== null) return;
    this.publish({ streaming: { chatId, text: "" }, error: null });
    await this.reply(chat);
  }

  private async reply(chat: SaasChatConversation) {
    const result = await this.options
      .requestReply(
        {
          messages: chat.messages.map((message) => ({
            role: message.role,
            content: message.content,
            ...(message.attachments ? { attachments: message.attachments } : {}),
          })),
          onText: (partial) => this.publish({ streaming: { chatId: chat.id, text: partial } }),
          onSearching: () =>
            this.publish({
              streaming: {
                chatId: chat.id,
                text: this.state.streaming?.text ?? "",
                searching: true,
              },
            }),
        },
        this.stored.deviceId,
      )
      .catch((): ChatReplyResult => ({
        ok: false,
        code: "network",
        message: "Could not reach Mira. Check your internet connection.",
      }));
    const latest = this.find(chat.id);
    if (latest === undefined) {
      this.publish({ streaming: null });
    } else if (result.ok && result.text !== "") {
      const repliedAt = this.now();
      this.write({
        ...latest,
        updatedAt: repliedAt,
        messages: [
          ...latest.messages,
          { id: this.randomId(), role: "assistant", content: result.text, createdAt: repliedAt },
        ],
      });
      this.publish({ streaming: null });
    } else {
      this.publish({
        streaming: null,
        error: result.ok
          ? { chatId: chat.id, code: "upstream_unavailable", message: "Mira did not answer." }
          : { chatId: chat.id, code: result.code, message: result.message },
      });
    }
  }

  remove(chatId: string) {
    if (this.find(chatId) === undefined) return;
    this.stored = {
      ...this.stored,
      chats: this.stored.chats.filter((chat) => chat.id !== chatId),
      dirty: [...new Set([...this.stored.dirty, chatId])],
    };
    this.commit();
    void this.sync();
  }

  clearError() {
    if (this.state.error !== null) this.publish({ error: null });
  }

  private find(chatId: string) {
    return this.stored.chats.find((chat) => chat.id === chatId);
  }

  private write(chat: SaasChatConversation) {
    this.stored = {
      ...this.stored,
      chats: [chat, ...this.stored.chats.filter((candidate) => candidate.id !== chat.id)],
      dirty: [...new Set([...this.stored.dirty, chat.id])],
    };
    this.commit();
    void this.sync();
  }

  private commit() {
    void this.persist();
    this.publish({ chats: [...this.stored.chats].sort(byNewest) });
  }

  private persist() {
    return this.options.storage.save(encodeStored(this.stored)).catch(() => {});
  }

  private publish(patch: Partial<ChatHistoryState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

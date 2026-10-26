import type {
  SaasChatConversation,
  SaasChatMessage,
  SaasChatSummary,
} from "@t3tools/contracts/saas";
import { SaasChatMessage as SaasChatMessageSchema } from "@t3tools/contracts/saas";
import { and, desc, eq, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { saasChatConversations, saasChatDaily } from "../persistence/schema.ts";
import { SaasPersistenceError } from "./SaasAccounts.ts";

/** One shared address can hold several people without accounts; it gets this many devices' worth. */
export const ANONYMOUS_IP_LIMIT_MULTIPLIER = 5;
const MAX_LISTED_CHATS = 200;

export type ChatSubject = `user:${string}` | `device:${string}` | `ip:${string}`;

/** Chat limits reset at midnight UTC. */
export const chatDay = (now: DateTime.Utc): string =>
  DateTime.formatIso(now).slice(0, "YYYY-MM-DD".length);

const DEVICE_ID_PATTERN = /^[A-Za-z0-9-]{16,64}$/;
export const isDeviceId = (value: string) => DEVICE_ID_PATTERN.test(value);

/** A cap of 0 means unlimited. */
export const isOverLimit = (messages: number, limit: number) => limit > 0 && messages > limit;

const MessagesJson = Schema.fromJsonString(Schema.Array(SaasChatMessageSchema));
const decodeMessages = Schema.decodeUnknownOption(MessagesJson);
const encodeMessages = Schema.encodeSync(MessagesJson);

export class SaasChat extends Context.Service<
  SaasChat,
  {
    /** Counts one message for every subject and returns each subject's count today. */
    readonly countMessage: (
      subjects: ReadonlyArray<ChatSubject>,
    ) => Effect.Effect<ReadonlyArray<number>, SaasPersistenceError>;
    readonly recordTokens: (input: {
      readonly subject: ChatSubject;
      readonly inputTokens: number;
      readonly outputTokens: number;
    }) => Effect.Effect<void, SaasPersistenceError>;
    readonly messagesToday: (subject: ChatSubject) => Effect.Effect<number, SaasPersistenceError>;
    readonly listChats: (
      userId: string,
    ) => Effect.Effect<ReadonlyArray<SaasChatSummary>, SaasPersistenceError>;
    readonly getChat: (input: {
      readonly userId: string;
      readonly chatId: string;
    }) => Effect.Effect<Option.Option<SaasChatConversation>, SaasPersistenceError>;
    readonly saveChat: (input: {
      readonly userId: string;
      readonly chat: SaasChatConversation;
    }) => Effect.Effect<void, SaasPersistenceError>;
    readonly deleteChat: (input: {
      readonly userId: string;
      readonly chatId: string;
    }) => Effect.Effect<void, SaasPersistenceError>;
  }
>()("t3code-relay/saas/SaasChat") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const persist =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new SaasPersistenceError({ operation, cause })));

  const countOne = Effect.fn("relay.saas.chat.count_one")(function* (
    subject: ChatSubject,
    day: string,
  ) {
    const rows = yield* db
      .insert(saasChatDaily)
      .values({ subject, day, messages: 1 })
      .onConflictDoUpdate({
        target: [saasChatDaily.subject, saasChatDaily.day],
        set: { messages: sql`${saasChatDaily.messages} + 1` },
      })
      .returning({ messages: saasChatDaily.messages })
      .pipe(persist("count-chat-message"));
    return rows[0]?.messages ?? 1;
  });

  const countMessage: SaasChat["Service"]["countMessage"] = Effect.fn(
    "relay.saas.chat.count_message",
  )(function* (subjects) {
    const day = chatDay(yield* DateTime.now);
    return yield* Effect.forEach(subjects, (subject) => countOne(subject, day));
  });

  const recordTokens: SaasChat["Service"]["recordTokens"] = Effect.fn(
    "relay.saas.chat.record_tokens",
  )(function* (input) {
    const day = chatDay(yield* DateTime.now);
    yield* db
      .update(saasChatDaily)
      .set({
        inputTokens: sql`${saasChatDaily.inputTokens} + ${input.inputTokens}`,
        outputTokens: sql`${saasChatDaily.outputTokens} + ${input.outputTokens}`,
      })
      .where(and(eq(saasChatDaily.subject, input.subject), eq(saasChatDaily.day, day)))
      .pipe(persist("record-chat-tokens"));
  });

  const messagesToday: SaasChat["Service"]["messagesToday"] = Effect.fn(
    "relay.saas.chat.messages_today",
  )(function* (subject) {
    const day = chatDay(yield* DateTime.now);
    const rows = yield* db
      .select({ messages: saasChatDaily.messages })
      .from(saasChatDaily)
      .where(and(eq(saasChatDaily.subject, subject), eq(saasChatDaily.day, day)))
      .limit(1)
      .pipe(persist("load-chat-count"));
    return rows[0]?.messages ?? 0;
  });

  const listChats: SaasChat["Service"]["listChats"] = Effect.fn("relay.saas.chat.list")(
    function* (userId) {
      return yield* db
        .select({
          id: saasChatConversations.id,
          title: saasChatConversations.title,
          createdAt: saasChatConversations.createdAt,
          updatedAt: saasChatConversations.updatedAt,
        })
        .from(saasChatConversations)
        .where(eq(saasChatConversations.userId, userId))
        .orderBy(desc(saasChatConversations.updatedAt))
        .limit(MAX_LISTED_CHATS)
        .pipe(persist("list-chats"));
    },
  );

  const getChat: SaasChat["Service"]["getChat"] = Effect.fn("relay.saas.chat.get")(
    function* (input) {
      const rows = yield* db
        .select()
        .from(saasChatConversations)
        .where(
          and(
            eq(saasChatConversations.userId, input.userId),
            eq(saasChatConversations.id, input.chatId),
          ),
        )
        .limit(1)
        .pipe(persist("get-chat"));
      const row = rows[0];
      if (row === undefined) return Option.none();
      const messages: ReadonlyArray<SaasChatMessage> = Option.getOrElse(
        decodeMessages(row.messages),
        () => [],
      );
      return Option.some({
        id: row.id,
        title: row.title,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        messages,
      });
    },
  );

  const saveChat: SaasChat["Service"]["saveChat"] = Effect.fn("relay.saas.chat.save")(
    function* (input) {
      const values = {
        title: input.chat.title,
        messages: encodeMessages(input.chat.messages),
        updatedAt: input.chat.updatedAt,
      };
      yield* db
        .insert(saasChatConversations)
        .values({
          userId: input.userId,
          id: input.chat.id,
          createdAt: input.chat.createdAt,
          ...values,
        })
        .onConflictDoUpdate({
          target: [saasChatConversations.userId, saasChatConversations.id],
          set: values,
        })
        .pipe(persist("save-chat"));
    },
  );

  const deleteChat: SaasChat["Service"]["deleteChat"] = Effect.fn("relay.saas.chat.delete")(
    function* (input) {
      yield* db
        .delete(saasChatConversations)
        .where(
          and(
            eq(saasChatConversations.userId, input.userId),
            eq(saasChatConversations.id, input.chatId),
          ),
        )
        .pipe(persist("delete-chat"));
    },
  );

  return SaasChat.of({
    countMessage,
    recordTokens,
    messagesToday,
    listChats,
    getChat,
    saveChat,
    deleteChat,
  });
});

export const layer = Layer.effect(SaasChat, make);

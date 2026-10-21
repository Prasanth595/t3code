import {
  type OrchestrationV2DomainEvent,
  type ProjectId,
  type SecretRef,
  type SecretRequestError,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  makeAgentAwarenessPublishWorker,
  shouldPublishAgentAwarenessEvent,
} from "../relay/AgentAwarenessRelay.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { forkParked } from "../serverActivation.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  observeThreadWatch,
  standardWebhookKey,
  standardWebhookSignature,
  threadWatchEventBody,
  threadWatchEventId,
  threadWatchId,
  type ThreadWatchState,
  UNSEEN,
} from "./threadWatch.ts";

export class ThreadWatchInvalidError extends Schema.TaggedError<ThreadWatchInvalidError>()(
  "ThreadWatchInvalidError",
  { reason: Schema.Literals(["url", "secret", "secret_source", "subagent", "ended"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "url":
        return "delivery.url must be an https URL without credentials or a fragment. Plain http is accepted only for localhost.";
      case "secret":
        return "The signing secret must be a Standard Webhooks secret: whsec_ followed by base64 of 24 to 64 random bytes.";
      case "secret_source":
        return "Pass exactly one of delivery.secret or delivery.secretRef.";
      case "subagent":
        return "This thread is a subagent. Watch its parent thread instead.";
      case "ended":
        return "This thread is settled, archived or deleted, so there is nothing to watch. Unsettle or unarchive it first.";
    }
  }
}

export class ThreadWatchStoreError extends Schema.TaggedError<ThreadWatchStoreError>()(
  "ThreadWatchStoreError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not update thread watches.";
  }
}

class ThreadWatchDeliveryError extends Schema.TaggedError<ThreadWatchDeliveryError>()(
  "ThreadWatchDeliveryError",
  { status: Schema.NullOr(Schema.Number) },
) {}

export class ThreadWatchReactor extends Context.Service<
  ThreadWatchReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Queues a check of the thread's watches, as a thread event would. */
    readonly checkThread: (threadId: ThreadId) => Effect.Effect<void>;
    /**
     * Watching the same URL again replaces its secret. A watch made before its
     * thread exists, as a launch does, hears the first run; any other watch
     * starts from the thread as it is now.
     */
    readonly watch: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly delivery: {
        readonly url: string;
        readonly secret?: string | undefined;
        readonly secretRef?: SecretRef | undefined;
      };
    }) => Effect.Effect<
      { readonly wasWatching: boolean },
      ThreadWatchInvalidError | ThreadWatchStoreError | SecretRequestError
    >;
    readonly unwatch: (input: {
      readonly threadId: ThreadId;
      readonly url: string;
    }) => Effect.Effect<{ readonly wasWatching: boolean }, ThreadWatchStoreError>;
    /** Resolves once queued threads are checked and their deliveries have settled. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadWatchReactor") {}

interface Watch {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly url: string;
  readonly key: Uint8Array;
}

/** The URL as it is stored and compared, or null when a delivery must not go there. */
function threadWatchUrl(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  // Credentials or a fragment would be stored and sent along with every delivery.
  if (url.username !== "" || url.password !== "" || url.hash !== "") return null;
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  return url.protocol === "https:" || (url.protocol === "http:" && loopback) ? url.href : null;
}

/**
 * The mobile alerts' events, plus a `request_secret` wait: it shows as pending
 * input, but its only event is a turn item those alerts skip.
 */
const wakesWatchers = (event: OrchestrationV2DomainEvent) =>
  shouldPublishAgentAwarenessEvent(event) ||
  (event.type === "turn-item.updated" && event.payload.type === "secret_request");

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const secretRequests = yield* SecretRequests.SecretRequests;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const httpClient = yield* HttpClient.HttpClient;
  const deliveries = yield* FiberSet.make<void, never>();
  // Registration changes take turns, so a late removal cannot delete a newer watch's row.
  const registrations = yield* Semaphore.make(1);
  // Watches are few, so they live in memory and the table only keeps them across restarts.
  const watchesByThread = new Map<ThreadId, Map<string, Watch>>();
  // What each watch was last told. A watch with no entry takes its first look as
  // a baseline, so after a restart watches start over from what threads look like.
  const told = new Map<string, ThreadWatchState>();

  const add = (watch: Watch) => {
    const watches = watchesByThread.get(watch.threadId) ?? new Map<string, Watch>();
    watches.set(watch.url, watch);
    watchesByThread.set(watch.threadId, watches);
  };
  const isCurrent = (watch: Watch) => watchesByThread.get(watch.threadId)?.get(watch.url) === watch;
  const forget = (watch: Watch) => {
    if (!isCurrent(watch)) return;
    watchesByThread.get(watch.threadId)?.delete(watch.url);
    if (watchesByThread.get(watch.threadId)?.size === 0) watchesByThread.delete(watch.threadId);
    told.delete(watch.id);
  };

  const stored = yield* sql<{
    readonly thread_id: string;
    readonly url: string;
    readonly secret: string;
  }>`SELECT thread_id, url, secret FROM thread_watches`.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("thread watches could not be loaded", { cause }).pipe(Effect.as([])),
    ),
  );
  for (const row of stored) {
    const key = standardWebhookKey(row.secret);
    const threadId = ThreadId.make(row.thread_id);
    if (key !== null) add({ id: threadWatchId(threadId, row.url), threadId, url: row.url, key });
  }

  const end = (watch: Watch) =>
    Effect.suspend(() =>
      isCurrent(watch)
        ? sql`DELETE FROM thread_watches WHERE thread_id = ${watch.threadId} AND url = ${watch.url}`.pipe(
            Effect.andThen(Effect.sync(() => forget(watch))),
          )
        : Effect.void,
    ).pipe(
      registrations.withPermits(1),
      Effect.catchCause((cause) =>
        Effect.logWarning("thread watch could not be removed", { watchId: watch.id, cause }),
      ),
    );

  const post = Effect.fn("ThreadWatchReactor.post")(function* (
    watch: Watch,
    eventId: string,
    body: string,
  ) {
    const timestamp = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    // Redirects stay manual so a receiver cannot bounce the signed body to
    // another host. Tracing stays off because request spans record the URL.
    const response = yield* HttpClient.withScope(httpClient)
      .post(watch.url, {
        body: HttpBody.text(body, "application/json"),
        headers: {
          "webhook-id": eventId,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": standardWebhookSignature({
            key: watch.key,
            id: eventId,
            timestamp,
            body,
          }),
          "x-mcp-subscription-id": watch.id,
        },
      })
      .pipe(
        Effect.map(({ status }) => status),
        Effect.scoped,
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.withTracerEnabled(false),
        Effect.timeoutOption("10 seconds"),
        Effect.option,
      );
    const status = Option.getOrNull(Option.flatten(response));
    if (status === null || status < 200 || (status >= 300 && status !== 410))
      return yield* new ThreadWatchDeliveryError({ status });
    return status;
  });

  const deliver = (watch: Watch, eventId: string, body: string) =>
    Effect.suspend(() =>
      // A watch ended or replaced meanwhile gets nothing more.
      isCurrent(watch) ? post(watch, eventId, body) : Effect.succeed(0),
    ).pipe(
      Effect.retry({ schedule: Schedule.exponential("2 seconds"), times: 3 }),
      // MCP Events: 410 means the receiver dropped the subscription.
      Effect.flatMap((status) => (status === 410 ? end(watch) : Effect.void)),
      Effect.catchTags({
        ThreadWatchDeliveryError: (error) =>
          Effect.logWarning("thread watch delivery failed", {
            watchId: watch.id,
            status: error.status,
          }),
      }),
    );

  // Untraced: it runs for every qualifying event, and returns at once for the
  // many threads nobody watches.
  const check = Effect.fnUntraced(
    function* (threadId: ThreadId) {
      const watches = watchesByThread.get(threadId);
      if (watches === undefined) return;
      const shell = yield* threads.getThreadShell(threadId);
      const environmentId = yield* environment.getEnvironmentId;
      const now = yield* DateTime.now;
      for (const watch of watches.values()) {
        const prior = told.get(watch.id);
        const { state, kind } = observeThreadWatch(shell, prior ?? UNSEEN);
        told.set(watch.id, state);
        // A first look only sets a baseline, unless the thread has already ended.
        if (kind === null || (prior === undefined && kind !== "ended")) continue;
        const eventId = threadWatchEventId(watch.id, kind, state);
        const body = threadWatchEventBody({
          eventId,
          environmentId,
          threadId,
          shell,
          kind,
          occurredAt: now,
        });
        // The watch ends once its ended event has been sent or given up on.
        yield* FiberSet.run(
          deliveries,
          kind === "ended"
            ? deliver(watch, eventId, body).pipe(Effect.andThen(end(watch)))
            : deliver(watch, eventId, body),
        );
      }
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("thread watch check failed", { threadId, cause }),
        ),
      ),
  );
  const worker = yield* makeAgentAwarenessPublishWorker(check);

  const watch: ThreadWatchReactor["Service"]["watch"] = Effect.fn("ThreadWatchReactor.watch")(
    function* ({ threadId, projectId, delivery }) {
      const url = threadWatchUrl(delivery.url);
      if (url === null) return yield* new ThreadWatchInvalidError({ reason: "url" });
      if ((delivery.secret === undefined) === (delivery.secretRef === undefined))
        return yield* new ThreadWatchInvalidError({ reason: "secret_source" });
      const shell = yield* threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError((cause) => new ThreadWatchStoreError({ cause })));
      if (shell?.lineage.relationshipToParent === "subagent")
        return yield* new ThreadWatchInvalidError({ reason: "subagent" });
      // A thread that does not exist yet is being launched, so its first run is news.
      const baseline = shell === null ? UNSEEN : observeThreadWatch(shell, UNSEEN).state;
      if (baseline.ended) return yield* new ThreadWatchInvalidError({ reason: "ended" });
      // A secretRef keeps the secret out of the calling agent's transcript, as
      // it does for scheduled task webhooks. Using it consumes it.
      const secret =
        delivery.secretRef === undefined
          ? (delivery.secret ?? "")
          : yield* secretRequests.consume({ ref: delivery.secretRef, projectId });
      const key = standardWebhookKey(secret);
      if (key === null) return yield* new ThreadWatchInvalidError({ reason: "secret" });
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const id = threadWatchId(threadId, url);
      return yield* sql`
        INSERT INTO thread_watches (thread_id, url, secret, created_at)
        VALUES (${threadId}, ${url}, ${secret}, ${createdAt})
        ON CONFLICT(thread_id, url) DO UPDATE SET secret = excluded.secret
      `.pipe(
        Effect.mapError((cause) => new ThreadWatchStoreError({ cause })),
        Effect.map(() => {
          const wasWatching = watchesByThread.get(threadId)?.has(url) ?? false;
          if (!told.has(id)) told.set(id, baseline);
          add({ id, threadId, url, key });
          return { wasWatching };
        }),
        registrations.withPermits(1),
      );
    },
  );

  const unwatch: ThreadWatchReactor["Service"]["unwatch"] = Effect.fn("ThreadWatchReactor.unwatch")(
    function* ({ threadId, url }) {
      const target = threadWatchUrl(url) ?? url;
      return yield* sql`DELETE FROM thread_watches WHERE thread_id = ${threadId} AND url = ${target}`.pipe(
        Effect.mapError((cause) => new ThreadWatchStoreError({ cause })),
        Effect.map(() => {
          const watch = watchesByThread.get(threadId)?.get(target);
          if (watch !== undefined) forget(watch);
          return { wasWatching: watch !== undefined };
        }),
        registrations.withPermits(1),
      );
    },
  );

  const start: ThreadWatchReactor["Service"]["start"] = Effect.fn("ThreadWatchReactor.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(threads.streamDomainEvents, (event) =>
          wakesWatchers(event) ? worker.enqueue(event.threadId) : Effect.void,
        ),
      );
      // Watches from before this start take their baseline now, so the next change is news.
      yield* Effect.forEach([...watchesByThread.keys()], worker.enqueue, { discard: true });
    },
  );

  return ThreadWatchReactor.of({
    start,
    checkThread: (threadId) => worker.enqueue(threadId).pipe(Effect.asVoid),
    watch,
    unwatch,
    drain: worker.drain.pipe(Effect.andThen(FiberSet.awaitEmpty(deliveries))),
  });
});

export const layer = Layer.effect(ThreadWatchReactor, make);

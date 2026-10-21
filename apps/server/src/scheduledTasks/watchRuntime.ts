import {
  CommandId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ScheduledTaskError,
  ScheduledTaskWatch,
  ThreadId,
  type ScheduledTask,
  type ScheduledTaskId,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpClient from "effect/http/HttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { matchesWebhookFilter } from "./webhookFilter.ts";
import { renderWebhookPrompt } from "./webhookTemplate.ts";
import { readWatchSource, watchSourceUrl, watchValue } from "./watchSource.ts";

type WatchConfig = Pick<ScheduledTaskWatch, "source" | "filters" | "maxConcurrentRuns">;
const decodeWatch = Schema.decodeUnknownEffect(ScheduledTaskWatch);
const WatchConfigJson = Schema.fromJsonString(
  Schema.Struct({
    source: ScheduledTaskWatch.fields.source,
    filters: ScheduledTaskWatch.fields.filters,
    maxConcurrentRuns: ScheduledTaskWatch.fields.maxConcurrentRuns,
  }),
);
const decodeConfig = Schema.decodeUnknownEffect(WatchConfigJson);
const encodeConfig = Schema.encodeSync(WatchConfigJson);
const encodeData = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const failure = () =>
  new ScheduledTaskError({
    message: "The watcher operation failed. Check its source, credentials, and limits.",
  });
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

interface WatchRow {
  watch_json: string | null;
  watch_revision: string | null;
  watch_secret_name: string | null;
  watch_initialized_at: string | null;
  watch_last_fired_at: string | null;
  watch_fire_count: number;
}

export const loadWatch = Effect.fn("ScheduledTaskService.loadWatch")(
  function* (id: string) {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<WatchRow>`SELECT watch_json, watch_revision, watch_secret_name,
    watch_initialized_at, watch_last_fired_at, watch_fire_count FROM scheduled_tasks WHERE task_id = ${id}`;
    if (row?.watch_json == null) return undefined;
    const [counts] = yield* sql<{ pending: number; active: number }>`SELECT
    COUNT(CASE WHEN state = 'pending' THEN 1 END) AS pending,
    COUNT(CASE WHEN state <> 'pending' THEN 1 END) AS active
    FROM scheduled_task_watch_events WHERE task_id = ${id}`;
    const config = yield* decodeConfig(row.watch_json);
    return yield* decodeWatch({
      ...config,
      initializedAt: row.watch_initialized_at,
      lastFiredAt: row.watch_last_fired_at,
      fireCount: row.watch_fire_count,
      pendingCount: counts?.pending ?? 0,
      activeRunCount: counts?.active ?? 0,
    });
  },
  (effect) => effect.pipe(Effect.mapError(failure)),
);

export const make = Effect.fn("ScheduledTaskService.makeWatchRuntime")(function* (callbacks: {
  readonly loadTask: (
    id: ScheduledTaskId,
  ) => Effect.Effect<ScheduledTask | null, ScheduledTaskError>;
  readonly notifyChanged: Effect.Effect<void>;
  readonly nextRunAt: (task: ScheduledTask, from: DateTime.DateTime) => string | null;
}) {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const http = yield* HttpClient.HttpClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const requests = yield* SecretRequests.SecretRequests;
  const launch = yield* ThreadLaunchService.ThreadLaunchService;
  const management = yield* ThreadManagementService.ThreadManagementService;
  const lock = yield* Semaphore.make(1);
  const dispatchLock = yield* Semaphore.make(1);
  const checks = yield* Ref.make<ReadonlySet<string>>(new Set());
  const newId = crypto.randomUUIDv4().pipe(Effect.mapError(failure));
  const getRow = (id: ScheduledTaskId) =>
    sql<WatchRow>`SELECT watch_json, watch_revision,
    watch_secret_name, watch_initialized_at, watch_last_fired_at, watch_fire_count
    FROM scheduled_tasks WHERE task_id = ${id}`.pipe(
      Effect.map((rows) => rows[0]),
      Effect.mapError(failure),
    );

  const prepare = Effect.fn("ScheduledTaskService.prepareWatch")(function* (
    input: ScheduledTaskUpsertInput,
    existing: ScheduledTask | null,
  ) {
    const row = existing === null ? undefined : yield* getRow(existing.id);
    const oldSecretName = row?.watch_secret_name ?? null;
    const watch = input.watch === undefined ? existing?.watch : input.watch;
    if (input.watchSecret !== undefined && watch?.source.auth === undefined)
      return yield* new ScheduledTaskError({
        message: "A watcher credential needs an authenticated source.",
      });
    if (watch == null)
      return {
        config: null,
        secretName: null,
        oldSecretName,
        reset: existing?.watch !== undefined,
      };
    if (input.schedule.type !== "interval")
      return yield* new ScheduledTaskError({ message: "Watchers need an interval schedule." });
    const url = yield* Effect.try({
      try: () => watchSourceUrl(watch.source),
      catch: failure,
    });
    const previous = existing?.watch;
    const previousUrl =
      previous === undefined ? null : watchSourceUrl({ ...previous.source, auth: undefined });
    const auth = watch.source.auth;
    const secretRef = auth !== undefined && "secretRef" in auth ? auth.secretRef : undefined;
    if (input.watchSecret !== undefined && secretRef !== undefined)
      return yield* new ScheduledTaskError({
        message: "Use either a watcher credential or a secret reference, not both.",
      });
    const sameIdentity =
      existing?.projectId === input.projectId &&
      previousUrl?.origin === url.origin &&
      previous?.source.auth?.type === auth?.type &&
      (auth?.type !== "basic" ||
        (previous?.source.auth?.type === "basic" &&
          previous.source.auth.username === auth.username));
    let secretName = sameIdentity ? (row?.watch_secret_name ?? null) : null;
    const referenceSecretName =
      secretRef !== undefined && input.commandId !== undefined
        ? `scheduled-watch-ref-${Buffer.from(
            yield* crypto
              .digest(
                "SHA-256",
                new TextEncoder().encode(yield* encodeData(input).pipe(Effect.mapError(failure))),
              )
              .pipe(Effect.mapError(failure)),
          ).toString("hex")}`
        : null;
    let value = input.watchSecret;
    if (secretRef !== undefined) {
      value = yield* requests.consume({ ref: secretRef, projectId: input.projectId }).pipe(
        Effect.catchTags({
          SecretRequestError: (error) =>
            error.reason === "ref_unavailable" &&
            referenceSecretName !== null &&
            secretName === referenceSecretName
              ? secrets
                  .get(referenceSecretName)
                  .pipe(
                    Effect.filterOrFail(Option.isSome, failure),
                    Effect.as(undefined),
                    Effect.mapError(failure),
                  )
              : Effect.fail(failure()),
        }),
      );
    }
    if (value !== undefined) {
      const bytes = new TextEncoder().encode(value);
      const stored =
        input.watchSecret !== undefined && secretName !== null
          ? yield* secrets.get(secretName).pipe(Effect.mapError(failure))
          : Option.none();
      if (
        referenceSecretName !== null ||
        Option.isNone(stored) ||
        !Buffer.from(stored.value).equals(bytes)
      ) {
        secretName = referenceSecretName ?? `scheduled-watch-${yield* newId}`;
        yield* secrets.set(secretName, bytes).pipe(Effect.mapError(failure));
      }
    }
    if (auth !== undefined && secretName === null)
      return yield* new ScheduledTaskError({
        message: "Enter a credential for this watcher.",
      });
    if (auth === undefined) secretName = null;
    const source =
      watch.source.type === "jira"
        ? {
            type: "jira" as const,
            baseUrl: url.toString().replace(/\/$/, ""),
            jql: watch.source.jql,
          }
        : {
            type: "http_json" as const,
            url: url.toString(),
            itemsPath: watch.source.itemsPath,
            keyPath: watch.source.keyPath,
          };
    const config: WatchConfig = {
      source: {
        ...source,
        ...(auth === undefined
          ? {}
          : {
              auth:
                auth.type === "basic"
                  ? { type: "basic" as const, username: auth.username, hasSecret: true }
                  : { type: "bearer" as const, hasSecret: true },
            }),
      },
      filters: watch.filters,
      maxConcurrentRuns: watch.maxConcurrentRuns,
    };
    const reset =
      previous === undefined ||
      encodeConfig({ ...previous, maxConcurrentRuns: 1 }) !==
        encodeConfig({ ...config, maxConcurrentRuns: 1 }) ||
      secretName !== row?.watch_secret_name;
    return { config, secretName, oldSecretName, reset };
  });

  const removeSecret = (name: string | null) =>
    name === null
      ? Effect.void
      : secrets
          .remove(name)
          .pipe(
            Effect.catch(() => Effect.logWarning("Could not remove an unused watcher credential.")),
          );
  const cleanup = (prepared: Effect.Success<ReturnType<typeof prepare>>, committed: boolean) =>
    prepared.oldSecretName === prepared.secretName
      ? Effect.void
      : removeSecret(committed ? prepared.oldSecretName : prepared.secretName);

  const save = Effect.fn("ScheduledTaskService.saveWatch")(
    function* (id: ScheduledTaskId, prepared: Effect.Success<ReturnType<typeof prepare>>) {
      const revision = yield* newId;
      yield* sql`UPDATE scheduled_tasks SET watch_json = ${prepared.config === null ? null : encodeConfig(prepared.config)},
      watch_revision = ${revision}, watch_secret_name = ${prepared.secretName},
      watch_initialized_at = CASE WHEN ${prepared.reset ? 1 : 0} = 1 THEN NULL ELSE watch_initialized_at END
      WHERE task_id = ${id}`;
      if (prepared.reset || prepared.config === null) {
        yield* sql`DELETE FROM scheduled_task_watch_snapshot WHERE task_id = ${id}`;
        yield* sql`DELETE FROM scheduled_task_watch_events WHERE task_id = ${id} AND state = 'pending'`;
      } else
        yield* sql`UPDATE scheduled_task_watch_events SET revision = ${revision} WHERE task_id = ${id} AND state IN ('pending', 'dispatching')`;
    },
    (effect) => effect.pipe(Effect.mapError(failure)),
  );

  const reconcile = Effect.fn("ScheduledTaskService.reconcileWatchRuns")(function* () {
    const discarded = yield* sql`DELETE FROM scheduled_task_watch_events WHERE state = 'dispatching'
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_messages WHERE message_id = 'scheduled-watch-message:' || scheduled_task_watch_events.event_id)
      AND NOT EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id = scheduled_task_watch_events.task_id
        AND watch_json IS NOT NULL AND watch_revision = scheduled_task_watch_events.revision) RETURNING event_id`;
    const recovered = yield* sql<{
      task_id: string;
    }>`UPDATE scheduled_task_watch_events SET state = 'running',
      run_id = (SELECT run_id FROM orchestration_v2_projection_messages WHERE message_id = 'scheduled-watch-message:' || scheduled_task_watch_events.event_id),
      thread_id = (SELECT thread_id FROM orchestration_v2_projection_messages WHERE message_id = 'scheduled-watch-message:' || scheduled_task_watch_events.event_id)
      WHERE state = 'dispatching' AND EXISTS (
        SELECT 1 FROM orchestration_v2_projection_messages WHERE message_id = 'scheduled-watch-message:' || scheduled_task_watch_events.event_id
      ) RETURNING task_id`;
    for (const entry of recovered)
      yield* sql`UPDATE scheduled_tasks SET watch_last_fired_at = ${yield* nowIso}, watch_fire_count = watch_fire_count + 1 WHERE task_id = ${entry.task_id}`;
    const orphaned = yield* sql`DELETE FROM scheduled_task_watch_events
      WHERE state = 'running' AND thread_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_messages
        WHERE message_id = 'scheduled-watch-message:' || scheduled_task_watch_events.event_id
      ) AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs
        WHERE run_id = scheduled_task_watch_events.run_id
          AND status NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'rolled_back')
      ) RETURNING event_id`;
    const completed =
      yield* sql`DELETE FROM scheduled_task_watch_events WHERE state <> 'pending' AND EXISTS (
      SELECT 1 FROM orchestration_v2_projection_messages m
      JOIN orchestration_v2_projection_runs r ON r.run_id = m.run_id
      WHERE m.message_id = 'scheduled-watch-message:' || scheduled_task_watch_events.event_id
        AND r.status IN ('completed', 'failed', 'interrupted', 'cancelled', 'rolled_back')
    ) RETURNING event_id`;
    return discarded.length + recovered.length + orphaned.length + completed.length > 0;
  });

  const dispatch = Effect.fn("ScheduledTaskService.dispatchWatchEvents")(
    function* () {
      let changed = yield* sql.withTransaction(reconcile()).pipe(lock.withPermits(1));
      const events = yield* sql<{
        event_id: string;
        task_id: ScheduledTaskId;
        revision: string;
        prompt: string;
        state: string;
        dispatch_command_id: string | null;
        thread_id: string | null;
      }>`
      SELECT e.event_id, e.task_id, e.revision, e.prompt, e.state, e.dispatch_command_id, e.thread_id FROM scheduled_task_watch_events e
      JOIN scheduled_tasks t ON t.task_id = e.task_id AND t.enabled = 1
        AND t.watch_json IS NOT NULL AND t.watch_revision = e.revision
      WHERE e.state IN ('pending', 'dispatching') AND (e.state = 'dispatching' OR
        (SELECT COUNT(*) FROM scheduled_task_watch_events active WHERE active.task_id = e.task_id AND active.state <> 'pending') < json_extract(t.watch_json, '$.maxConcurrentRuns'))
      ORDER BY e.dispatch_order, e.created_at, e.rowid LIMIT 4`.pipe(lock.withPermits(1));
      for (const event of events) {
        const commandId = CommandId.make(
          event.dispatch_command_id ?? `scheduled-watch:${event.event_id}`,
        );
        const task = yield* Effect.gen(function* () {
          const current = yield* callbacks.loadTask(event.task_id);
          if (current?.watch === undefined || !current.enabled) return null;
          const row = yield* getRow(current.id);
          if (row?.watch_revision !== event.revision) return null;
          const [counts] = yield* sql<{ global_count: number; task_count: number }>`SELECT
          COUNT(*) AS global_count, COUNT(CASE WHEN task_id = ${current.id} THEN 1 END) AS task_count
          FROM scheduled_task_watch_events WHERE state <> 'pending'`;
          if (
            event.state === "pending" &&
            ((counts?.global_count ?? 0) >= 4 ||
              (counts?.task_count ?? 0) >= current.watch.maxConcurrentRuns)
          )
            return null;
          const claimed = yield* sql`UPDATE scheduled_task_watch_events
            SET state = 'dispatching', dispatch_command_id = ${commandId}
            WHERE event_id = ${event.event_id} AND revision = ${event.revision}
              AND state = ${event.state} RETURNING event_id`;
          return claimed.length === 0 ? null : current;
        }).pipe(sql.withTransaction, lock.withPermits(1));
        if (task === null) continue;
        changed = true;
        const messageId = MessageId.make(`scheduled-watch-message:${event.event_id}`);
        const sent = yield* Effect.exit(
          task.threadId === null
            ? launch
                .launch({
                  commandId,
                  ...(event.thread_id === null
                    ? {}
                    : { threadId: ThreadId.make(event.thread_id), reuseExistingThread: true }),
                  projectId: task.projectId,
                  title: task.title,
                  modelSelection: task.modelSelection,
                  runtimeMode: task.runtimeMode,
                  interactionMode: task.interactionMode,
                  workspaceStrategy: task.workspaceStrategy,
                  initialMessage: {
                    messageId,
                    scheduledTaskId: task.id,
                    text: event.prompt,
                    attachments: [],
                  },
                  createdBy: task.createdBy,
                  creationSource: task.creationSource,
                })
                .pipe(
                  Effect.map((result) => result.threadId),
                  Effect.mapError(failure),
                )
            : management
                .sendToThread({
                  commandId,
                  messageId,
                  projectId: task.projectId,
                  threadId: ThreadId.make(task.threadId),
                  scheduledTaskId: task.id,
                  text: event.prompt,
                  attachments: [],
                  mode: "queue",
                  createdBy: task.createdBy,
                  creationSource: task.creationSource,
                })
                .pipe(
                  Effect.map(() => ThreadId.make(task.threadId!)),
                  Effect.mapError(failure),
                ),
        );
        if (Exit.isFailure(sent) && Cause.hasInterruptsOnly(sent.cause))
          return yield* Effect.failCause(sent.cause);
        yield* Effect.gen(function* () {
          const current = yield* sql`SELECT 1 FROM scheduled_task_watch_events e
            JOIN scheduled_tasks t ON t.task_id = e.task_id
            WHERE e.event_id = ${event.event_id} AND e.state = 'dispatching'
              AND e.dispatch_command_id = ${commandId} AND e.revision = ${event.revision}
              AND t.watch_revision = ${event.revision} AND t.watch_json IS NOT NULL AND t.enabled = 1`;
          if (current.length === 0) return;
          if (Exit.isSuccess(sent)) {
            const now = yield* nowIso;
            yield* sql`UPDATE scheduled_task_watch_events SET state = 'running', thread_id = ${sent.value},
              run_id = (SELECT run_id FROM orchestration_v2_projection_messages WHERE message_id = ${messageId})
              WHERE event_id = ${event.event_id}`;
            yield* sql`UPDATE scheduled_tasks SET watch_last_fired_at = ${now}, watch_fire_count = watch_fire_count + 1 WHERE task_id = ${task.id}`;
          } else {
            const receipts = yield* sql<{
              command_id: string;
              command_type: string;
              status: string;
              aggregate_id: string;
            }>`
            SELECT command_id, command_type, status, aggregate_id FROM orchestration_command_receipts
            WHERE command_id IN (${commandId}, ${`${commandId}:initial-message`})`;
            const accepted = receipts.some(
              (receipt) =>
                receipt.command_type === "message.dispatch" && receipt.status === "accepted",
            );
            const message =
              yield* sql`SELECT 1 FROM orchestration_v2_projection_messages WHERE message_id = ${messageId}`;
            if (message.length > 0) return;
            const rejected = !accepted && receipts.some((receipt) => receipt.status === "rejected");
            const nextCommandId = rejected
              ? `scheduled-watch:${event.event_id}:retry:${yield* newId}`
              : commandId;
            const claimed = receipts.find(
              (receipt) =>
                receipt.command_id === commandId &&
                receipt.status === "accepted" &&
                (receipt.command_type === "thread.create" ||
                  receipt.command_type === "thread.metadata.update"),
            );
            yield* sql`UPDATE scheduled_task_watch_events SET state = ${accepted ? "dispatching" : "pending"},
              dispatch_command_id = ${nextCommandId}, thread_id = ${claimed?.aggregate_id ?? event.thread_id},
              dispatch_order = (SELECT COALESCE(MAX(dispatch_order), 0) + 1 FROM scheduled_task_watch_events)
              WHERE event_id = ${event.event_id}`;
            yield* sql`UPDATE scheduled_tasks SET last_run_error = 'A watcher run could not be started. It will be retried.', last_run_status = 'failed' WHERE task_id = ${task.id}`;
          }
        }).pipe(sql.withTransaction, lock.withPermits(1));
      }
      if (changed) yield* callbacks.notifyChanged;
    },
    (effect) => effect.pipe(dispatchLock.withPermits(1), Effect.mapError(failure)),
  );

  const check = Effect.fn("ScheduledTaskService.checkWatch")(
    function* (task: ScheduledTask) {
      if (task.watch === undefined || !task.enabled) return;
      const acquired = yield* Ref.modify(checks, (current) =>
        current.has(task.id)
          ? ([false, current] as const)
          : ([true, new Set(current).add(task.id)] as const),
      );
      if (!acquired) return;
      yield* Effect.gen(function* () {
        const captured = yield* Effect.gen(function* () {
          const current = yield* callbacks.loadTask(task.id);
          const row = yield* getRow(task.id);
          if (current?.watch === undefined || !current.enabled || row?.watch_json == null)
            return null;
          return { watch: current.watch, row };
        }).pipe(lock.withPermits(1));
        if (captured === null) return;
        const { watch, row } = captured;
        const outcome = yield* Effect.result(
          Effect.gen(function* () {
            let authorization: string | undefined;
            const auth = watch.source.auth;
            if (auth !== undefined) {
              const secret =
                row.watch_secret_name === null
                  ? Option.none()
                  : yield* secrets.get(row.watch_secret_name).pipe(Effect.mapError(failure));
              if (Option.isNone(secret)) return yield* failure();
              const value = new TextDecoder().decode(secret.value);
              authorization =
                auth.type === "basic"
                  ? `Basic ${Buffer.from(`${auth.username}:${value}`).toString("base64")}`
                  : `Bearer ${value}`;
            }
            return yield* readWatchSource(watch.source, authorization).pipe(
              Effect.provideService(HttpClient.HttpClient, http),
            );
          }),
        );
        yield* Effect.gen(function* () {
          const current = yield* callbacks.loadTask(task.id);
          const activeRow = yield* getRow(task.id);
          if (
            current?.watch === undefined ||
            !current.enabled ||
            activeRow?.watch_revision !== row.watch_revision
          )
            return;
          const now = yield* nowIso;
          const next = callbacks.nextRunAt(current, DateTime.makeUnsafe(now));
          const commit = Effect.gen(function* () {
            if (outcome._tag === "Failure") return yield* failure();
            const previous = yield* sql<{
              item_key: string;
              matched: number;
            }>`SELECT item_key, matched FROM scheduled_task_watch_snapshot WHERE task_id = ${task.id}`;
            const prior = new Map(previous.map((item) => [item.item_key, item.matched === 1]));
            const snapshot = outcome.success.map((item) => ({
              ...item,
              matched: current.watch!.filters.every((filter) =>
                matchesWebhookFilter(filter, watchValue(item.value, filter.path)),
              ),
            }));
            const entered =
              activeRow.watch_initialized_at === null
                ? []
                : snapshot.filter((item) => item.matched && prior.get(item.key) !== true);
            const [queued] = yield* sql<{
              count: number;
            }>`SELECT COUNT(*) AS count FROM scheduled_task_watch_events WHERE task_id = ${task.id}`;
            if ((queued?.count ?? 0) + entered.length > 100) return yield* failure();
            for (const item of entered) {
              const id = yield* newId;
              const frameId = Buffer.from(yield* crypto.randomBytes(12)).toString("hex");
              const prompt = renderWebhookPrompt(
                `${current.prompt}\n\nWatcher match:\n{{body}}`,
                {
                  method: "GET",
                  path: "",
                  query: "",
                  headers: {},
                  bodyText: yield* encodeData({ key: item.key, item: item.value }),
                },
                frameId,
              ).prompt;
              if (prompt.trim().length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS)
                return yield* failure();
              yield* sql`INSERT INTO scheduled_task_watch_events(event_id, task_id, revision, created_at, prompt, dispatch_order)
              VALUES (${id}, ${task.id}, ${row.watch_revision}, ${now}, ${prompt},
                (SELECT COALESCE(MAX(dispatch_order), 0) + 1 FROM scheduled_task_watch_events))`;
            }
            yield* sql`DELETE FROM scheduled_task_watch_snapshot WHERE task_id = ${task.id}`;
            if (snapshot.length > 0)
              yield* sql`INSERT INTO scheduled_task_watch_snapshot ${sql.insert(snapshot.map((item) => ({ task_id: task.id, item_key: item.key, matched: item.matched ? 1 : 0 })))}`;
            yield* sql`UPDATE scheduled_tasks SET watch_initialized_at = COALESCE(watch_initialized_at, ${now}) WHERE task_id = ${task.id}`;
          });
          const recorded = yield* Effect.result(sql.withTransaction(commit));
          yield* sql`UPDATE scheduled_tasks SET last_run_at = ${now}, next_run_at = ${next},
          last_run_status = ${recorded._tag === "Success" ? "succeeded" : "failed"},
          last_run_error = ${recorded._tag === "Success" ? null : "The watcher check failed. Its previous snapshot and queued matches were kept."},
          run_count = run_count + 1 WHERE task_id = ${task.id} AND watch_revision = ${row.watch_revision}`;
          yield* callbacks.notifyChanged;
        }).pipe(lock.withPermits(1));
      }).pipe(
        Effect.ensuring(
          Ref.update(checks, (current) => {
            const next = new Set(current);
            next.delete(task.id);
            return next;
          }),
        ),
      );
      yield* dispatch();
    },
    (effect) => effect.pipe(Effect.mapError(failure)),
  );

  return { prepare, save, cleanup, removeSecret, check, dispatch, withLock: lock.withPermits(1) };
});

import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  OrchestrationV2ThreadBoundedSnapshot,
  ThreadId,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as SqlClient from "effect/sql/SqlClient";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import {
  buildBoundedThreadProjection,
  decodeThreadHistoryCursor,
  InvalidThreadHistoryCursorError,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
  THREAD_HISTORY_PAGE_POLICY,
  OLDER_THREAD_USER_TURN_LIMIT,
} from "./threadHistoryPaging.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { buildActiveShellSnapshot, loadShellSnapshotParts } from "./ShellStream.ts";
import { boundedSnapshotResponseFields } from "./ThreadStream.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";

function isThreadNotFound(error: unknown): boolean {
  return (
    Predicate.hasProperty(error, "cause") &&
    Predicate.hasProperty(error.cause, "_tag") &&
    error.cause._tag === "ProjectionStoreThreadNotFoundError"
  );
}

// Same negotiation as the global compression middleware, including invalid headers.
function responseEncoding(header: string | undefined, supported: ReadonlySet<string>) {
  if (!header?.trim()) return "identity";
  const accepted = new Map<string, number>();
  for (const part of header.split(",")) {
    const member = part
      .trim()
      .toLowerCase()
      .replace(/[ \t]*;[ \t]*/g, ";");
    const match = /^([a-z0-9!#$%&'*+.^_`|~-]+)(?:;q=(0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?))?$/.exec(
      member,
    );
    if (!match) return "identity";
    accepted.set(match[1]!, match[2] === undefined ? 1 : Number(match[2]));
  }
  return (
    (["br", "gzip", "deflate"] as const).find(
      (encoding) =>
        supported.has(encoding) && (accepted.get(encoding) ?? accepted.get("*") ?? 0) > 0,
    ) ?? "identity"
  );
}

const encodeBoundedSnapshot = Schema.encodeSync(
  Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot),
);
const encodeResponseCacheKey = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * Serves orchestration V2 snapshots over HTTP so clients can load the
 * (potentially large) shell and thread projections off the socket; gzip
 * compressible and cacheable — and then resume the WebSocket subscription via
 * `afterSequence`.
 */
export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const sql = yield* SqlClient.SqlClient;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
    const platform = yield* HttpPlatform.HttpPlatform;

    const responses = new Map<
      string,
      {
        readonly revision: string;
        readonly response: HttpServerResponse.HttpServerResponse;
      }
    >();
    const maxResponseBytes = 32 * 1024 * 1024;
    let responseBytes = 0;
    const readResponseRevision = (threadId: ThreadId) =>
      sql<{
        readonly kind: string;
        readonly id: string;
        readonly revision: number;
      }>`
      WITH RECURSIVE ancestors(id) AS (
        SELECT ${threadId}
        UNION
        SELECT json_extract(thread.payload_json, '$.forkedFrom.threadId')
        FROM orchestration_v2_projection_threads thread JOIN ancestors ON thread.thread_id = ancestors.id
        WHERE json_extract(thread.payload_json, '$.forkedFrom.type') = 'run'
      ), resources(kind, id) AS (
        SELECT 'thread', id FROM ancestors
        UNION
        SELECT 'session', provider_session_id
        FROM orchestration_v2_projection_provider_session_bindings
        WHERE thread_id IN (SELECT id FROM ancestors)
        UNION
        SELECT 'provider-threads', '*'
      )
      SELECT resources.kind AS kind, resources.id AS id, COALESCE(revisions.revision, 0) AS revision
      FROM resources LEFT JOIN orchestration_v2_snapshot_revisions revisions
        ON revisions.kind = resources.kind AND revisions.id = resources.id
      UNION ALL
      SELECT 'sequence', ${threadId}, COALESCE(MAX(sequence), 0)
      FROM orchestration_events WHERE application_event_version = 2 AND aggregate_kind = 'thread' AND stream_id = ${threadId}
      ORDER BY kind, id
    `.pipe(
        Effect.map(encodeResponseCacheKey),
        Effect.catch(() => Effect.succeed(undefined)),
      );
    const removeResponse = (key: string) => {
      const previous = responses.get(key)?.response;
      if (previous?.body._tag === "Uint8Array") responseBytes -= previous.body.body.byteLength;
      responses.delete(key);
    };
    const storeResponse = (
      key: string,
      revision: string,
      response: HttpServerResponse.HttpServerResponse,
    ) => {
      if (response.status !== 200 || response.body._tag !== "Uint8Array") return;
      const bytes = response.body.body.byteLength;
      if (bytes > maxResponseBytes) return;
      removeResponse(key);
      while (responseBytes + bytes > maxResponseBytes || responses.size >= 128) {
        const oldest = responses.keys().next().value;
        if (oldest === undefined) break;
        removeResponse(oldest);
      }
      const encoding = response.headers["content-encoding"];
      responses.set(key, {
        revision,
        response: HttpServerResponse.uint8Array(response.body.body, {
          contentType: response.headers["content-type"] ?? response.body.contentType,
          headers: {
            ...(encoding === undefined ? {} : { "content-encoding": encoding }),
          },
        }),
      });
      responseBytes += bytes;
    };
    const boundedResponseKey = (threadId: ThreadId, compact: boolean, encoding: string) =>
      encodeResponseCacheKey(["bounded", threadId, compact, encoding]);
    const cachedThreadResponse = Effect.fnUntraced(function* (
      threadId: ThreadId,
      compact?: boolean,
    ) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const revision = yield* readResponseRevision(threadId);
      if (revision === undefined) return undefined;
      const key =
        compact === undefined
          ? encodeResponseCacheKey([
              request.method,
              request.originalUrl,
              request.headers["accept-encoding"] ?? "",
            ])
          : boundedResponseKey(
              threadId,
              compact,
              responseEncoding(request.headers["accept-encoding"], platform.compression.algorithms),
            );
      const cached = responses.get(key);
      if (cached?.revision === revision) {
        responses.delete(key);
        responses.set(key, cached);
        // Compression skips already encoded bodies. Add its Vary dimension after
        // the request's CORS handlers, in the same order as a fresh response.
        yield* HttpEffect.appendPreResponseHandler((_request, response) => {
          const vary = response.headers.vary;
          const dimensions = vary?.split(",").map((part) => part.trim().toLowerCase());
          return Effect.succeed(
            dimensions?.includes("*") || dimensions?.includes("accept-encoding")
              ? response
              : HttpServerResponse.setHeader(
                  response,
                  "vary",
                  vary === undefined ? "Accept-Encoding" : `${vary}, Accept-Encoding`,
                ),
          );
        });
        return cached.response;
      }
      // Registered after global compression, so retain exactly the bytes sent.
      // Rebuild the response to leave request-specific auth/CORS headers uncached.
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.gen(function* () {
          if ((yield* readResponseRevision(threadId)) === revision)
            storeResponse(key, revision, response);
          return response;
        }),
      );
      return undefined;
    });

    const enrichProjectShells = Effect.fn("http.orchestration.enrichProjectShells")(
      (projects: ReadonlyArray<OrchestrationProjectShell>) =>
        Effect.forEach(
          projects,
          (project) =>
            // Use immediately available enrichment only. Awaiting git-backed
            // identity resolution can exceed the client shell-snapshot budget
            // (ProcessRunner allows probes up to one minute). Background workers
            // plus the WS enrichment subscription fill in repositoryIdentity.
            projectEnrichment.getAvailable(project.workspaceRoot).pipe(
              Effect.map((enrichment) => ({
                ...project,
                repositoryIdentity: enrichment.repositoryIdentity,
              })),
            ),
          { concurrency: 16 },
        ),
    );

    const loadShellSnapshot = Effect.fn("http.orchestration.loadShellSnapshot")(function* () {
      const base = buildActiveShellSnapshot(
        yield* loadShellSnapshotParts({
          sql,
          readThreads: threadManagement.readShellSnapshot({ location: "active" }),
          listProjects: projectStore.listShells(),
          latestSequence: applicationEvents.latestApplicationSequence,
        }),
      );
      const projects = yield* enrichProjectShells(base.projects);
      return { ...base, projects };
    });

    const loadThreadSnapshot = Effect.fn("http.orchestration.loadThreadSnapshot")(function* (
      threadId: Parameters<typeof threadManagement.getThreadSnapshot>[0],
      failureReason:
        | "orchestration_thread_snapshot_failed"
        | "orchestration_thread_bounded_snapshot_failed"
        | "orchestration_thread_history_failed",
    ) {
      return yield* threadManagement.getThreadSnapshot(threadId).pipe(
        Effect.map((snapshot) => ({
          ...snapshot,
          projection: projectThreadProjectionForWire(snapshot.projection),
        })),
        Effect.catch(
          Effect.fnUntraced(function* (error) {
            if (isThreadNotFound(error)) {
              return yield* failEnvironmentNotFound("thread_not_found");
            }
            return yield* failEnvironmentInternal(failureReason, error);
          }),
        ),
      );
    });

    const loadThreadSnapshotWindow = Effect.fn("http.orchestration.loadThreadSnapshotWindow")(
      function* (
        threadId: Parameters<typeof threadManagement.getThreadSnapshot>[0],
        anchorItemId?: Parameters<
          typeof threadManagement.getThreadSnapshotWindow
        >[1]["anchorItemId"],
        anchorThreadId?: Parameters<
          typeof threadManagement.getThreadSnapshotWindow
        >[1]["anchorThreadId"],
      ) {
        return yield* threadManagement
          .getThreadSnapshotWindow(threadId, {
            rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
            userTurnLimit:
              anchorItemId === undefined
                ? THREAD_HISTORY_PAGE_POLICY.maxUserTurns
                : OLDER_THREAD_USER_TURN_LIMIT,
            ...(anchorItemId === undefined ? {} : { anchorItemId }),
            ...(anchorThreadId === undefined ? {} : { anchorThreadId }),
          })
          .pipe(
            Effect.map((snapshot) => ({
              ...snapshot,
              projection: projectThreadProjectionForWire(snapshot.projection),
            })),
            Effect.catch(
              Effect.fnUntraced(function* (error) {
                if (isThreadNotFound(error)) {
                  return yield* failEnvironmentNotFound("thread_not_found");
                }
                return yield* failEnvironmentInternal("orchestration_thread_history_failed", error);
              }),
            ),
          );
      },
    );

    // Only server work: no client requests or speculative wire bytes.
    // One worker yields between threads; streaming bursts coalesce before warming.
    const warmRecentThreadResponses = Effect.fnUntraced(function* () {
      const recent = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL AND archived_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_runs run
            WHERE run.thread_id = orchestration_v2_projection_threads.thread_id
              AND run.status IN ('queued', 'preparing', 'starting', 'running')
          )
        ORDER BY updated_at DESC, thread_id ASC LIMIT 16
      `;
      for (const row of recent) {
        yield* Effect.yieldNowWith(10);
        yield* Effect.gen(function* () {
          const threadId = ThreadId.make(row.thread_id);
          const revision = yield* readResponseRevision(threadId);
          if (revision === undefined) return;
          const encodings = (["br", "gzip"] as const).filter((encoding) =>
            platform.compression.algorithms.has(encoding),
          );
          if (
            encodings.every(
              (encoding) =>
                responses.get(boundedResponseKey(threadId, true, encoding))?.revision === revision,
            )
          )
            return;
          const snapshot = yield* loadThreadSnapshotWindow(threadId);
          const bounded = buildBoundedThreadProjection({
            projection: snapshot.projection,
            snapshotSequence: snapshot.snapshotSequence,
          });
          const response = HttpServerResponse.jsonUnsafe(
            encodeBoundedSnapshot({
              snapshotSequence: snapshot.snapshotSequence,
              ...boundedSnapshotResponseFields({ bounded, compactTurnItems: true }),
            }),
          );
          for (const encoding of encodings) {
            const compressed =
              response.body._tag === "Uint8Array" && response.body.body.byteLength >= 1024
                ? yield* platform.compression.compressResponse(response, encoding, {
                    level: encoding === "br" ? 4 : 6,
                  })
                : HttpServerResponse.setHeader(response, "vary", "Accept-Encoding");
            if ((yield* readResponseRevision(threadId)) !== revision) break;
            storeResponse(boundedResponseKey(threadId, true, encoding), revision, compressed);
          }
        }).pipe(Effect.catch(() => Effect.void));
      }
    });
    const afterSequence = yield* applicationEvents.latestApplicationSequence;
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        yield* warmRecentThreadResponses();
        yield* applicationEvents
          .streamProjectedApplicationEvents({
            afterSequence,
            project: (event) => ({ sequence: event.sequence }),
          })
          .pipe(
            Stream.groupedWithin(256, "250 millis"),
            Stream.runForEach(() => warmRecentThreadResponses()),
          );
      }).pipe(Effect.catch(() => Effect.logWarning("Thread snapshot warmup stopped"))),
    );

    return handlers
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* loadShellSnapshot().pipe(
            traceLocalHandlerWork,
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_snapshot_failed", cause),
            ),
          );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* loadThreadSnapshot(
            args.params.threadId,
            "orchestration_thread_snapshot_failed",
          ).pipe(traceLocalHandlerWork);
          return {
            snapshotSequence: snapshot.snapshotSequence,
            projection: snapshot.projection,
          };
        }),
      )
      .handle(
        "threadBoundedSnapshot",
        Effect.fn("environment.orchestration.threadBoundedSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const cached = yield* cachedThreadResponse(
            args.params.threadId,
            args.query.compactTurnItems === "1",
          );
          if (cached !== undefined) return cached;
          const snapshot = yield* loadThreadSnapshotWindow(args.params.threadId).pipe(
            traceLocalHandlerWork,
          );
          const bounded = buildBoundedThreadProjection({
            projection: snapshot.projection,
            snapshotSequence: snapshot.snapshotSequence,
          });
          return {
            snapshotSequence: snapshot.snapshotSequence,
            ...boundedSnapshotResponseFields({
              bounded,
              compactTurnItems: args.query.compactTurnItems === "1",
            }),
          };
        }),
      )
      .handle(
        "threadHistoryPage",
        Effect.fn("environment.orchestration.threadHistoryPage")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          try {
            decodeThreadHistoryCursor(args.query.cursor);
          } catch (cause) {
            if (cause instanceof InvalidThreadHistoryCursorError)
              return yield* failEnvironmentInvalidRequest("invalid_history_cursor");
            return yield* failEnvironmentInternal("orchestration_thread_history_failed", cause);
          }
          const cached = yield* cachedThreadResponse(args.params.threadId);
          if (cached !== undefined) return cached;
          return yield* threadManagement
            .getThreadHistoryPage(
              args.params.threadId,
              args.query.cursor,
              args.query.throughEntryId,
              args.query.view === "conversation",
            )
            .pipe(
              traceLocalHandlerWork,
              Effect.catch(
                Effect.fnUntraced(function* (cause) {
                  if (isThreadNotFound(cause))
                    return yield* failEnvironmentNotFound("thread_not_found");
                  return yield* failEnvironmentInternal(
                    "orchestration_thread_history_failed",
                    cause,
                  );
                }),
              ),
            );
        }),
      );
  }),
);

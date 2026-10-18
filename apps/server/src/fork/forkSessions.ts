/**
 * Fork: one session per map machine or app client (MM-1305), and the end of fork sessions that
 * nobody uses. `SessionStore.ts` keeps one hook into this file.
 */
import { AuthEnvironmentScopes, AuthSessionId, ServerAuthSessionMethod } from "@t3tools/contracts";
import type { AuthEnvironmentScope } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  type IssuedSession,
  SessionCredentialIssueError,
  type SessionStore,
} from "../auth/SessionStore.ts";
import { clientBrowserSessionTtl, isMachineSubject } from "./machineMap/machineAccess.ts";

/** The label prefix of a session that an owner got through Cloudflare Access. */
export const CLOUDFLARE_ACCESS_LABEL_PREFIX = "cloudflare-access ";

/**
 * A fork session that is not connected and was not seen for this long ends. "Seen" is the later
 * of its issue and its last connection start, so a long connection that ended recently can end
 * early. The client then signs in or pairs again without user action. Revisit when a fork client
 * cannot pair again by itself, or when the session store records each use.
 */
export const FORK_SESSION_IDLE_LIMIT = Duration.days(7);
/**
 * Also the wait before the first sweep: the connected sessions live in memory, so right after a
 * restart every session looks disconnected until its client connects again.
 */
const CLEANUP_INTERVAL = Duration.hours(1);
/**
 * The most sessions that one sweep or one issue ends, oldest first. Each ended session sends one
 * "removed" message to every open client, so a backlog of thousands would freeze them. The hourly
 * sweep drains a large backlog over time. Revisit when upstream adds one event for many removed
 * sessions.
 */
const REVOKE_LIMIT_PER_PASS = 500;

type Issue = SessionStore["Service"]["issue"];

/**
 * The sessions that one identity gets again: map machines (`machine:<id>`) and app token clients
 * (`client:<id>`, MM-912). Each holds one token on one device. Owner Access sign-ins and browser
 * clients are left out: one label covers every browser of the owner or of a client, so one shared
 * session would sign all of them out together.
 */
const isReusable = (subject: string, label: string) =>
  isMachineSubject(subject) ||
  (subject.startsWith("client:") && clientBrowserSessionTtl({ subject, label }) === undefined);

const IdentityRequest = Schema.Struct({
  subject: Schema.String,
  method: ServerAuthSessionMethod,
  label: Schema.String,
  now: Schema.DateTimeUtcFromString,
});

const IdentityRow = Schema.Struct({
  sessionId: AuthSessionId,
  scopes: Schema.fromJsonString(AuthEnvironmentScopes),
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
type IdentityRow = typeof IdentityRow.Type;

const RevokedRow = Schema.Struct({ sessionId: AuthSessionId });

const lastSeenMs = (row: IdentityRow) =>
  Math.max(row.issuedAt.epochMilliseconds, row.lastConnectedAt?.epochMilliseconds ?? 0);

const sameScopes = (
  left: ReadonlyArray<AuthEnvironmentScope>,
  right: ReadonlyArray<AuthEnvironmentScope>,
) => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((scope) => rightSet.has(scope));
};

/**
 * MM-1305: the session of an identity to give again: the same scopes, more than half of its life
 * left, and not idle. A connected one comes first, then the newest.
 */
const pickReusable = (
  rows: ReadonlyArray<IdentityRow>,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  connected: ReadonlySet<AuthSessionId>,
  nowMs: number,
): IdentityRow | undefined =>
  rows
    .filter((row) => {
      const lifeMs = row.expiresAt.epochMilliseconds - row.issuedAt.epochMilliseconds;
      return (
        sameScopes(row.scopes, scopes) &&
        row.expiresAt.epochMilliseconds - nowMs > lifeMs / 2 &&
        (connected.has(row.sessionId) ||
          nowMs - lastSeenMs(row) < Duration.toMillis(FORK_SESSION_IDLE_LIMIT))
      );
    })
    .toSorted(
      (left, right) =>
        Number(connected.has(right.sessionId)) - Number(connected.has(left.sessionId)) ||
        right.issuedAt.epochMilliseconds - left.issuedAt.epochMilliseconds,
    )[0];

/**
 * Wraps `SessionStore.issue` so that a map machine or app client keeps one session, and starts the
 * hourly end of idle fork sessions in the scope of the store. One permit makes two requests at
 * once share one session.
 */
export const makeForkSessions = Effect.fn("makeForkSessions")(function* (store: {
  readonly issue: Issue;
  /** The token of a stored session, signed again from its row. */
  readonly sign: (session: {
    readonly sessionId: AuthSessionId;
    readonly subject: string;
    readonly method: ServerAuthSessionMethod;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    readonly issuedAt: DateTime.Utc;
    readonly expiresAt: DateTime.Utc;
  }) => Effect.Effect<string, SessionCredentialIssueError>;
  readonly connectedSessionIds: Effect.Effect<ReadonlyArray<AuthSessionId>>;
  readonly publishRemoved: (sessionIds: ReadonlyArray<AuthSessionId>) => Effect.Effect<void>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const permit = yield* Semaphore.make(1);

  // The connected sessions first, then the newest: only those can be given again, and an identity
  // can hold a backlog of thousands.
  const findIdentity = SqlSchema.findAll({
    Request: Schema.Struct({ ...IdentityRequest.fields, connected: Schema.Array(AuthSessionId) }),
    Result: IdentityRow,
    execute: ({ subject, method, label, now, connected }) => sql`
      SELECT
        session_id AS "sessionId",
        scopes AS "scopes",
        issued_at AS "issuedAt",
        expires_at AS "expiresAt",
        last_connected_at AS "lastConnectedAt"
      FROM auth_sessions
      WHERE subject = ${subject}
        AND method = ${method}
        AND client_label = ${label}
        AND revoked_at IS NULL
        AND expires_at > ${now}
      ORDER BY ${sql.in("session_id", connected)} DESC, issued_at DESC
      LIMIT 20
    `,
  });

  /** Ends the oldest live sessions of the identity except `keep`, at most one pass. */
  const revokeIdentity = SqlSchema.findAll({
    Request: Schema.Struct({
      ...IdentityRequest.fields,
      keep: Schema.Array(AuthSessionId),
    }),
    Result: RevokedRow,
    execute: ({ subject, method, label, now, keep }) => sql`
      UPDATE auth_sessions
      SET revoked_at = ${now}
      WHERE session_id IN (
        SELECT session_id FROM auth_sessions
        WHERE subject = ${subject}
          AND method = ${method}
          AND client_label = ${label}
          AND revoked_at IS NULL
          AND expires_at > ${now}
          AND NOT (${sql.in("session_id", keep)})
        ORDER BY issued_at ASC
        LIMIT ${REVOKE_LIMIT_PER_PASS}
      )
      RETURNING session_id AS "sessionId"
    `,
  });

  const revokeIdle = SqlSchema.findAll({
    Request: Schema.Struct({
      now: Schema.DateTimeUtcFromString,
      seenBefore: Schema.DateTimeUtcFromString,
      connected: Schema.Array(AuthSessionId),
    }),
    Result: RevokedRow,
    execute: ({ now, seenBefore, connected }) => sql`
      UPDATE auth_sessions
      SET revoked_at = ${now}
      WHERE session_id IN (
        SELECT session_id FROM auth_sessions
        WHERE revoked_at IS NULL
          AND expires_at > ${now}
          AND (
            subject LIKE 'machine:%'
            OR subject LIKE 'client:%'
            OR client_label LIKE ${`${CLOUDFLARE_ACCESS_LABEL_PREFIX}%`}
          )
          AND issued_at < ${seenBefore}
          AND (last_connected_at IS NULL OR last_connected_at < ${seenBefore})
          AND NOT (${sql.in("session_id", connected)})
        ORDER BY issued_at ASC
        LIMIT ${REVOKE_LIMIT_PER_PASS}
      )
      RETURNING session_id AS "sessionId"
    `,
  });

  const issue: Issue = (input) => {
    const label = input?.client?.label;
    // A proof key or a runtime ceiling is not in the stored row, so such a session is never given
    // again. The fork never issues one. A cookie that replaces another keeps the upstream path.
    if (
      input?.subject === undefined ||
      input.method === undefined ||
      input.scopes === undefined ||
      label === undefined ||
      input.proofKeyThumbprint !== undefined ||
      input.runtimeModeCeiling !== undefined ||
      input.replaceSessionId !== undefined ||
      !isReusable(input.subject, label)
    ) {
      return store.issue(input);
    }
    const { subject, method, scopes } = input;
    return Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const now = DateTime.makeUnsafe(nowMs);
      const connected = new Set(yield* store.connectedSessionIds);
      const identity = { subject, method, label, now };
      const rows = yield* findIdentity({ ...identity, connected: [...connected] });
      const reuse = pickReusable(rows, scopes, connected, nowMs);
      const revoked = yield* revokeIdentity({
        ...identity,
        keep: [...connected, ...(reuse === undefined ? [] : [reuse.sessionId])],
      });
      yield* store.publishRemoved(revoked.map((row) => row.sessionId));
      if (reuse === undefined) return yield* store.issue(input);
      const token = yield* store.sign({ ...reuse, subject, method });
      return {
        sessionId: reuse.sessionId,
        token,
        method,
        client: input.client ?? { deviceType: "unknown" },
        expiresAt: reuse.expiresAt,
        scopes: reuse.scopes,
      } satisfies IssuedSession;
    }).pipe(
      Effect.catchTags({
        SqlError: (cause) => Effect.fail(new SessionCredentialIssueError({ cause })),
        SchemaError: (cause) => Effect.fail(new SessionCredentialIssueError({ cause })),
      }),
      permit.withPermits(1),
      Effect.withSpan("ForkSessions.issue"),
    );
  };

  const cleanup = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const revoked = yield* revokeIdle({
      now: DateTime.makeUnsafe(nowMs),
      seenBefore: DateTime.makeUnsafe(nowMs - Duration.toMillis(FORK_SESSION_IDLE_LIMIT)),
      connected: yield* store.connectedSessionIds,
    });
    yield* store.publishRemoved(revoked.map((row) => row.sessionId));
    if (revoked.length > 0) {
      yield* Effect.logInfo("Ended idle fork sessions.", { count: revoked.length });
    }
  }).pipe(
    permit.withPermits(1),
    Effect.catchCause((cause) => Effect.logWarning("Could not end idle fork sessions.", { cause })),
  );
  yield* Effect.sleep(CLEANUP_INTERVAL).pipe(
    Effect.andThen(cleanup.pipe(Effect.repeat(Schedule.spaced(CLEANUP_INTERVAL)))),
    Effect.forkScoped,
  );

  return { issue };
});

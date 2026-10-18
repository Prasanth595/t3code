/**
 * Fork: one session per machine, map client or Cloudflare Access sign-in (MM-1305), and the
 * cleanup of the ones nobody uses. `SessionStore.ts` keeps one-line hooks into this file.
 */
import type { AuthClientSession, AuthEnvironmentScope, AuthSessionId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import type {
  IssuedSession,
  SessionCredentialInternalError,
  SessionStore,
} from "../auth/SessionStore.ts";
import { isMapSubject } from "./machineMap/machineAccess.ts";

/** The label prefix of a session that an owner got through Cloudflare Access. */
export const CLOUDFLARE_ACCESS_LABEL_PREFIX = "cloudflare-access ";

/**
 * A fork session that is not connected and was not seen for this long ends. "Seen" is the later
 * of its issue and its last connection start, so a long connection that ended recently can end
 * early. The client then signs in or pairs again without user action. Revisit when a fork client
 * cannot pair again by itself, or when the session store records each use.
 */
export const FORK_SESSION_IDLE_LIMIT = Duration.days(7);
const CLEANUP_INTERVAL = Duration.hours(1);

type Issue = SessionStore["Service"]["issue"];
type ForkSession = Pick<
  AuthClientSession,
  | "sessionId"
  | "subject"
  | "method"
  | "client"
  | "scopes"
  | "issuedAt"
  | "expiresAt"
  | "lastConnectedAt"
  | "connected"
>;

/** A session that the fork issues: a map machine (MM-1305), a map client or an Access sign-in. */
const isForkSession = (session: {
  readonly subject: string;
  readonly client: { readonly label?: string | undefined };
}): boolean =>
  isMapSubject(session.subject) ||
  session.client.label?.startsWith(CLOUDFLARE_ACCESS_LABEL_PREFIX) === true;

const lastSeenMs = (session: ForkSession) =>
  Math.max(session.issuedAt.epochMilliseconds, session.lastConnectedAt?.epochMilliseconds ?? 0);

const isIdle = (session: ForkSession, nowMs: number) =>
  !session.connected && nowMs - lastSeenMs(session) >= Duration.toMillis(FORK_SESSION_IDLE_LIMIT);

/** The fork sessions that the cleanup ends. Upstream sessions are never in the list. */
const idleForkSessions = (
  sessions: ReadonlyArray<ForkSession>,
  nowMs: number,
): ReadonlyArray<AuthSessionId> =>
  sessions
    .filter((session) => isForkSession(session) && isIdle(session, nowMs))
    .map((session) => session.sessionId);

const sameScopes = (
  left: ReadonlyArray<AuthEnvironmentScope>,
  right: ReadonlyArray<AuthEnvironmentScope>,
) => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((scope) => rightSet.has(scope));
};

/**
 * MM-1305: the session to give again to an identity that asks for one, and the other sessions of
 * that identity to end. An identity is the subject, the method and the label. A session is given
 * again when it has the same scopes, more than half of its life left, and is not idle. A connected
 * session is never ended here: a level change ends it through MM-1306.
 */
const planReuse = (
  wanted: {
    readonly subject: string;
    readonly method: AuthClientSession["method"];
    readonly label: string | undefined;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  },
  sessions: ReadonlyArray<ForkSession>,
  nowMs: number,
): { readonly reuse: ForkSession | undefined; readonly revoke: ReadonlyArray<AuthSessionId> } => {
  const same = sessions.filter(
    (session) =>
      session.subject === wanted.subject &&
      session.method === wanted.method &&
      session.client.label === wanted.label,
  );
  const reuse = same
    .filter((session) => {
      const lifeMs = session.expiresAt.epochMilliseconds - session.issuedAt.epochMilliseconds;
      return (
        sameScopes(session.scopes, wanted.scopes) &&
        session.expiresAt.epochMilliseconds - nowMs > lifeMs / 2 &&
        !isIdle(session, nowMs)
      );
    })
    .toSorted(
      (left, right) =>
        Number(right.connected) - Number(left.connected) ||
        right.issuedAt.epochMilliseconds - left.issuedAt.epochMilliseconds,
    )[0];
  return {
    reuse,
    revoke: same
      .filter((session) => session !== reuse && !session.connected)
      .map((session) => session.sessionId),
  };
};

/**
 * Wraps `SessionStore.issue` so that a fork identity keeps one session, and starts the hourly
 * cleanup of idle fork sessions in the scope of the store. One permit makes two requests at once
 * share one session instead of both making one.
 */
export const makeForkSessions = Effect.fn("makeForkSessions")(function* (store: {
  readonly issue: Issue;
  /** The same token again for a stored session. */
  readonly reissue: (
    session: ForkSession,
  ) => Effect.Effect<IssuedSession, SessionCredentialInternalError>;
  readonly listActive: SessionStore["Service"]["listActive"];
  readonly revoke: SessionStore["Service"]["revoke"];
}) {
  const permit = yield* Semaphore.make(1);

  const issue: Issue = (input) => {
    const label = input?.client?.label;
    // A proof key or a runtime ceiling is not in the stored row, so such a session is never given
    // again. The fork never issues one.
    if (
      input?.subject === undefined ||
      input.method === undefined ||
      input.scopes === undefined ||
      input.proofKeyThumbprint !== undefined ||
      input.runtimeModeCeiling !== undefined ||
      !isForkSession({ subject: input.subject, client: { label } })
    ) {
      return store.issue(input);
    }
    const { subject, method, scopes } = input;
    return Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const plan = planReuse({ subject, method, label, scopes }, yield* store.listActive(), nowMs);
      const previous =
        input.replaceSessionId !== undefined && input.replaceSessionId !== plan.reuse?.sessionId
          ? [input.replaceSessionId]
          : [];
      yield* Effect.forEach([...plan.revoke, ...previous], store.revoke, { discard: true });
      return plan.reuse === undefined
        ? yield* store.issue(input)
        : yield* store.reissue(plan.reuse);
    }).pipe(permit.withPermits(1), Effect.withSpan("ForkSessions.issue"));
  };

  const cleanup = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const idle = idleForkSessions(yield* store.listActive(), nowMs);
    yield* Effect.forEach(idle, store.revoke, { discard: true });
    if (idle.length > 0) {
      yield* Effect.logInfo("Ended idle fork sessions.", { count: idle.length });
    }
  }).pipe(
    permit.withPermits(1),
    Effect.catchCause((cause) => Effect.logWarning("Could not end idle fork sessions.", { cause })),
  );
  yield* cleanup.pipe(Effect.repeat(Schedule.spaced(CLEANUP_INTERVAL)), Effect.forkScoped);

  return { issue };
});

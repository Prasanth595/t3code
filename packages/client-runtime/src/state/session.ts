import type { AuthSessionState, EnvironmentId, ServerConfig } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import { mapRemoteEnvironmentError } from "../connection/errors.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { connectionRouteId } from "../connection/routes.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { managedRelaySessionAtom, type ManagedRelaySession } from "../relay/managedRelayState.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { followStreamInEnvironment } from "./environmentStreams.ts";

/** @public Required to name the error in consumers' inferred session results. */
export class SessionHttpClientUnavailable extends Data.TaggedError(
  "SessionHttpClientUnavailable",
) {}

function initialConfigOption<E>(
  initialConfig: Effect.Effect<ServerConfig, E>,
): Effect.Effect<Option.Option<ServerConfig>> {
  return initialConfig.pipe(
    Effect.asSome,
    Effect.catch((error) =>
      Effect.logWarning("Could not load the initial environment configuration.").pipe(
        Effect.annotateLogs({ ...safeErrorLogAttributes(error) }),
        Effect.as(Option.none<ServerConfig>()),
      ),
    ),
  );
}

const DEFAULT_SESSION_STATE_TIMEOUT_MS = 6_000;
const SESSION_STATE_RETRY_SCHEDULE = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);

function isTransientSessionError(
  error: SessionHttpClientUnavailable | RemoteEnvironmentRequestError,
): boolean {
  return (
    error._tag !== "SessionHttpClientUnavailable" &&
    mapRemoteEnvironmentError(error)._tag === "ConnectionTransientError"
  );
}

export const fetchEnvironmentSessionState = Effect.fn(
  "clientRuntime.state.fetchEnvironmentSessionState",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
  >;
  readonly timeoutMs?: number;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "auth",
    method: "GET",
    url: (urls) => urls.session(),
    timeoutMs: input.timeoutMs ?? DEFAULT_SESSION_STATE_TIMEOUT_MS,
    request: ({ client, headers }) => client.session({ headers }),
    // This endpoint returns 200 with authenticated:false for expired credentials.
    isUnauthorizedResponse: (response) => !response.authenticated,
  });
});

interface SessionOwner {
  readonly supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  readonly prepared: PreparedConnection;
  readonly cloudSession: ManagedRelaySession | null;
}

interface SessionSnapshot extends SessionOwner {
  readonly session: AuthSessionState;
}

// Cloud-session identity survives token rotation and changes on sign-out or account replacement.
function sameSessionOwner(previous: SessionOwner, current: SessionOwner): boolean {
  const before = previous.prepared;
  const after = current.prepared;
  return (
    previous.supervisor === current.supervisor &&
    previous.cloudSession === current.cloudSession &&
    before.target._tag === after.target._tag &&
    connectionRouteId(before.target) === connectionRouteId(after.target) &&
    before.httpAuthorization?._tag === after.httpAuthorization?._tag &&
    (before.httpAuthorization?._tag !== "Bearer" ||
      (after.httpAuthorization?._tag === "Bearer" &&
        before.httpAuthorization.token === after.httpAuthorization.token))
  );
}

function makeEnvironmentSessionAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  const initialConfigAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              SubscriptionRef.changes(supervisor.session).pipe(
                Stream.mapEffect(
                  Option.match({
                    onNone: () => Effect.succeed(Option.none<ServerConfig>()),
                    onSome: (session) => initialConfigOption(session.initialConfig),
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
      { initialValue: Option.none() },
    ),
  );

  // This is only the bootstrap config captured when a transport session is
  // established. Consumers that need current provider/settings state must use
  // createServerEnvironmentAtoms(...).configValueAtom instead.
  const initialConfigValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ServerConfig | null =>
      Option.getOrNull(
        Option.getOrElse(AsyncResult.value(get(initialConfigAtom(environmentId))), () =>
          Option.none(),
        ),
      ),
    ).pipe(Atom.withLabel(`environment-config-value:${environmentId}`)),
  );

  const connectionStateAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              SubscriptionRef.changes(supervisor.prepared).pipe(
                Stream.map((prepared) => ({ supervisor, prepared })),
              ),
            ),
          ),
        ),
      ),
      { initialValue: null },
    ),
  );

  const preparedConnectionAtom = Atom.family((environmentId: EnvironmentId) =>
    connectionStateAtom(environmentId).pipe(
      Atom.map(
        AsyncResult.map((connection) => connection?.prepared ?? Option.none<PreparedConnection>()),
      ),
    ),
  );

  const preparedConnectionValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrElse(AsyncResult.value(get(preparedConnectionAtom(environmentId))), () =>
        Option.none<PreparedConnection>(),
      ),
    ).pipe(Atom.withLabel(`environment-prepared-connection:${environmentId}`)),
  );

  const sessionQueryAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom((get) => {
        const connection = Option.getOrNull(
          AsyncResult.value(get(connectionStateAtom(environmentId))),
        );
        const prepared = connection === null ? null : Option.getOrNull(connection.prepared);
        if (connection === null || prepared === null) {
          return Effect.never;
        }
        const owner = {
          supervisor: connection.supervisor,
          prepared,
          cloudSession:
            prepared.httpAuthorization?._tag === "Dpop" ? get(managedRelaySessionAtom) : null,
        };
        const previous = Option.getOrNull(
          get.self<AsyncResult.AsyncResult<SessionSnapshot, unknown>>(),
        );
        const hasConfirmedGrant =
          previous?._tag === "Success" &&
          previous.value.session.authenticated &&
          sameSessionOwner(previous.value, owner);
        const fetchSession = Effect.gen(function* () {
          const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
          const remoteAuthorization = yield* Effect.serviceOption(
            RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
          );
          const client = yield* Effect.serviceOption(HttpClient.HttpClient);
          if (Option.isNone(client)) return yield* new SessionHttpClientUnavailable();
          return yield* fetchEnvironmentSessionState({
            prepared,
            signer,
            remoteAuthorization,
          }).pipe(Effect.provideService(HttpClient.HttpClient, client.value));
        });
        const request = hasConfirmedGrant
          ? fetchSession.pipe(
              Effect.retry({
                while: isTransientSessionError,
                schedule: SESSION_STATE_RETRY_SCHEDULE,
              }),
            )
          : fetchSession;
        return request.pipe(Effect.map((session) => ({ ...owner, session })));
      })
      .pipe(Atom.withLabel(`environment-session-query:${environmentId}`)),
  );

  const sessionStateAtom = Atom.family((environmentId: EnvironmentId) =>
    sessionQueryAtom(environmentId).pipe(
      Atom.transform((get, query) => {
        const result = get(query);
        const connection = Option.getOrNull(
          AsyncResult.value(get(connectionStateAtom(environmentId))),
        );
        // A replacement must not expose the previous credential while its check waits.
        return AsyncResult.flatMap(result, (confirmed, previous) => {
          const prepared = connection === null ? null : Option.getOrNull(connection.prepared);
          const cloudSession =
            confirmed.prepared.httpAuthorization?._tag === "Dpop"
              ? get(managedRelaySessionAtom)
              : null;
          const belongsToConnection =
            result._tag !== "Failure" &&
            connection !== null &&
            confirmed.supervisor === connection.supervisor &&
            confirmed.cloudSession === cloudSession &&
            (prepared === null ||
              sameSessionOwner(confirmed, {
                supervisor: connection.supervisor,
                prepared,
                cloudSession,
              }));
          return belongsToConnection
            ? AsyncResult.success(confirmed.session, previous)
            : AsyncResult.initial<AuthSessionState>(result.waiting);
        });
      }),
      Atom.swr({ staleTime: 30_000, revalidateOnMount: true }),
      Atom.setIdleTTL(5 * 60_000),
      Atom.withLabel(`environment-session-state:${environmentId}`),
    ),
  );

  const sessionStateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): AuthSessionState | null =>
        Option.getOrNull(AsyncResult.value(get(sessionStateAtom(environmentId)))) ?? null,
    ).pipe(Atom.withLabel(`environment-session-state-value:${environmentId}`)),
  );

  return {
    initialConfigAtom,
    initialConfigValueAtom,
    preparedConnectionAtom,
    preparedConnectionValueAtom,
    sessionStateAtom,
    sessionStateValueAtom,
  };
}

const sessionAtomsByRuntime = new WeakMap<object, ReturnType<typeof makeEnvironmentSessionAtoms>>();

export function createEnvironmentSessionAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
): ReturnType<typeof makeEnvironmentSessionAtoms<R, E>> {
  const existing = sessionAtomsByRuntime.get(runtime);
  if (existing) return existing as ReturnType<typeof makeEnvironmentSessionAtoms<R, E>>;
  const atoms = makeEnvironmentSessionAtoms(runtime);
  sessionAtomsByRuntime.set(runtime, atoms);
  return atoms;
}

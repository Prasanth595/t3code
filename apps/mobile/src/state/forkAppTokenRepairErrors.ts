import {
  ConnectionBlockedError,
  PAIRING_REVOKED_MESSAGE,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { REPAIRING_MESSAGE } from "../connection/forkAppTokenClient";

/**
 * Fork: why the app token repair (connection/forkAppTokenRepair.ts) cannot reconnect an
 * environment, or null.
 */
export const appTokenRepairErrorAtom = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make<string | null>(null).pipe(Atom.keepAlive),
);

/** The environments that the app token repair pairs again, from its last portal read. */
export const appTokenEnvironmentIdsAtom = Atom.make<ReadonlyArray<EnvironmentId>>([]).pipe(
  Atom.keepAlive,
);

/**
 * The connection state of an environment with the message of the app token repair. An app token
 * environment never shows "Pair again": the repair pairs it by itself.
 */
export function withAppTokenRepair<E>(
  stateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<SupervisorConnectionState, E>>,
) {
  return Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const result = get(stateAtom(environmentId));
      if (!AsyncResult.isSuccess(result)) return result;
      const state = result.value;
      const failure = state.lastFailure;
      if (state.phase === "connected" || failure === null) return result;
      const repairing =
        failure.message === PAIRING_REVOKED_MESSAGE &&
        get(appTokenEnvironmentIdsAtom).includes(environmentId);
      const message =
        get(appTokenRepairErrorAtom(environmentId)) ?? (repairing ? REPAIRING_MESSAGE : null);
      if (message === null || message === failure.message) return result;
      return AsyncResult.success({
        ...state,
        lastFailure: new ConnectionBlockedError({
          reason: failure._tag === "ConnectionBlockedError" ? failure.reason : "authentication",
          detail: message,
          ...(failure.traceId === undefined ? {} : { traceId: failure.traceId }),
        }),
      });
    }),
  );
}

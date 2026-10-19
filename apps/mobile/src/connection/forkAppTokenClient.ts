/**
 * Fork: the decisions of the app token repair (forkAppTokenRepair.ts), kept free of effects so
 * that tests can cover them. An app token client is a phone that a portal invite enrolled
 * (MM-913); it reaches each machine with its own Cloudflare Access service token.
 */
import {
  cloudflareAccessServiceToken,
  type OriginRequestHeaders,
} from "@t3tools/client-runtime/connection";
import type { ClientMachine, EnvironmentId } from "@t3tools/contracts";

/**
 * A session that the machine refused: the level of the client changed, its arrow expired, the
 * pause ended, `clientAccess` changed, or the 7-day sweep ended an idle session (MM-912, MM-921,
 * MM-1305). Only a new pairing helps. The pause itself is not a refusal: it keeps the session.
 */
export function isRefusedSession(state: {
  readonly phase: string;
  readonly lastFailure?: { readonly reason: string } | null;
}): boolean {
  return state.phase === "blocked" && state.lastFailure?.reason === "authentication";
}

/** The pause before the next repair of one environment, like the sibling backoff of MM-922. */
export function repairDelayMs(failures: number): number {
  const first = 30_000;
  const max = 10 * 60_000;
  return Math.min(max, first * 2 ** Math.max(0, failures - 1));
}

/** The origins that hold the service token with this client id: the app token origins. */
export function appTokenOrigins(
  rules: ReadonlyArray<OriginRequestHeaders>,
  tokenClientId: string,
): ReadonlySet<string> {
  return new Set(
    rules
      .filter((rule) => cloudflareAccessServiceToken(rule.headers)?.clientId === tokenClientId)
      .map((rule) => rule.origin),
  );
}

/** A saved environment that reaches a machine origin with the app token. */
export interface AppTokenEnvironment {
  readonly environmentId: EnvironmentId;
  readonly origin: string;
  readonly enabled: boolean;
}

export interface MachineSyncPlan {
  /** Machines that the portal lists and that no saved environment reaches: pair with them. */
  readonly pair: ReadonlyArray<ClientMachine>;
  /** Environments of machines that the portal no longer lists: their arrow is `none`. */
  readonly disable: ReadonlyArray<EnvironmentId>;
  /** Environments that the repair disabled before and that the portal lists again. */
  readonly enable: ReadonlyArray<EnvironmentId>;
}

/**
 * Compares the machines of `GET /client/machines` (MM-914) with the saved environments. The
 * repair disables an environment instead of removing it: a removal also deletes the saved token
 * of its origin, and the app could not pair again. It enables only what it disabled itself.
 */
export function planMachineSync(input: {
  readonly machines: ReadonlyArray<ClientMachine>;
  readonly saved: ReadonlyArray<AppTokenEnvironment>;
  readonly disabledByRepair: ReadonlySet<EnvironmentId>;
}): MachineSyncPlan {
  const listed = new Set(input.machines.map((machine) => machine.origin));
  const savedOrigins = new Set(input.saved.map((environment) => environment.origin));
  return {
    pair: input.machines.filter((machine) => !savedOrigins.has(machine.origin)),
    disable: input.saved
      .filter((environment) => environment.enabled && !listed.has(environment.origin))
      .map((environment) => environment.environmentId),
    enable: input.saved
      .filter(
        (environment) =>
          !environment.enabled &&
          listed.has(environment.origin) &&
          input.disabledByRepair.has(environment.environmentId),
      )
      .map((environment) => environment.environmentId),
  };
}

export const TOKEN_REFUSED_MESSAGE =
  "The portal no longer accepts the app token of this phone. In the portal, open this phone under Clients and use Invite an app, then scan the new invite.";

export const REPAIRING_MESSAGE = "Pairing again with the app token of this phone...";

export const NO_ACCESS_MESSAGE =
  "This phone has no access to this machine now. Give it access in the portal.";

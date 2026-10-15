/**
 * Fork: machine map in the desktop app (apps/machine-map/SPEC.md MM-306, MM-403, MM-1401). Pure
 * decisions; `MachineMapDesktop` runs them.
 */
import { type RequestHeader, requestHeaderOrigin } from "@t3tools/client-runtime/connection";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  ClientSettingsPatch,
  type ClientSettings,
  type EnvironmentId,
  type MachineMapClientState,
  type MachineMapTokenHeaders,
  type SettingValues,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Schema from "effect/Schema";

export interface SavedEnvironment {
  readonly environmentId: EnvironmentId;
  /** The http(s) origin of its saved route, or null. */
  readonly origin: string | null;
  readonly phase: EnvironmentConnectionPhase;
}

interface MachineSyncPlan {
  /** Machine origins that keep the token headers. */
  readonly keep: ReadonlyArray<string>;
  /** Origins to pair: not saved yet, or saved and failing after a level change. */
  readonly pair: ReadonlyArray<string>;
  /** Machine origins that left `reachable`: remove the environment and the headers. */
  readonly remove: ReadonlyArray<{
    readonly origin: string;
    readonly environmentId: EnvironmentId | null;
  }>;
}

/** Only an exact https origin gets the token headers. */
function isMachineOrigin(origin: string): boolean {
  return origin.startsWith("https://") && requestHeaderOrigin(origin) === origin;
}

/**
 * Decides which machine environments to add, pair again, and remove.
 *
 * - `managedOrigins` are the origins that this app added for the map. Only those get removed, so
 *   an environment the user saved by hand stays as it is, headers included.
 * - A managed environment in phase `error` pairs again once per failure. The target ends the
 *   session of this machine when the level of the arrow changes (MM-305).
 */
export function planMachineSync(input: {
  readonly state: Pick<MachineMapClientState, "enabled" | "joined" | "reachable" | "tokenHeaders">;
  readonly managedOrigins: ReadonlySet<string>;
  readonly environments: ReadonlyArray<SavedEnvironment>;
  readonly repairAttempted: ReadonlySet<string>;
}): MachineSyncPlan {
  const { state, managedOrigins, environments, repairAttempted } = input;
  const savedByOrigin = new Map(
    environments.flatMap((environment) =>
      environment.origin === null ? [] : [[environment.origin, environment] as const],
    ),
  );
  // Joined without token headers: a session that is not the local desktop app. Do nothing.
  if (state.enabled && state.joined && state.tokenHeaders === null) {
    return { keep: [], pair: [], remove: [] };
  }
  const active = state.enabled && state.joined;
  const wanted = new Set(
    active ? state.reachable.map((peer) => peer.origin).filter(isMachineOrigin) : [],
  );

  const keep: Array<string> = [];
  const pair: Array<string> = [];
  for (const origin of wanted) {
    const saved = savedByOrigin.get(origin);
    if (saved !== undefined && !managedOrigins.has(origin)) continue;
    keep.push(origin);
    if (saved === undefined) pair.push(origin);
    else if (saved.phase === "error" && !repairAttempted.has(origin)) pair.push(origin);
  }
  const remove = [...managedOrigins]
    .filter((origin) => !wanted.has(origin))
    .map((origin) => ({
      origin,
      environmentId: savedByOrigin.get(origin)?.environmentId ?? null,
    }));
  return { keep, pair, remove };
}

export function tokenRequestHeaders(headers: MachineMapTokenHeaders): ReadonlyArray<RequestHeader> {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

export function sameRequestHeaders(
  left: ReadonlyArray<RequestHeader>,
  right: ReadonlyArray<RequestHeader>,
): boolean {
  const key = (headers: ReadonlyArray<RequestHeader>) =>
    stableStringify(
      Object.fromEntries(headers.map((header) => [header.name.toLowerCase(), header.value])),
    );
  return key(left) === key(right);
}

const isClientSettingsPatch = Schema.is(ClientSettingsPatch);

/**
 * MM-403: the part of the desired client settings that differs from the current ones. A value
 * that is already current is left out, so applying the map's own value writes nothing and the
 * next report shows no change. Keys that are not client settings, or have an invalid value, are
 * in `skipped`.
 */
export function clientSettingsPatchFromDesired(
  desired: SettingValues,
  current: ClientSettings,
): { readonly patch: ClientSettingsPatch; readonly skipped: ReadonlyArray<string> } {
  const patch: Record<string, unknown> = {};
  const skipped: Array<string> = [];
  const currentValues: Readonly<Record<string, unknown>> = current;
  for (const [key, value] of Object.entries(desired)) {
    if (
      !Object.hasOwn(ClientSettingsPatch.fields, key) ||
      !isClientSettingsPatch({ [key]: value })
    ) {
      skipped.push(key);
      continue;
    }
    if (stableStringify(currentValues[key]) !== stableStringify(value)) patch[key] = value;
  }
  if (!isClientSettingsPatch(patch)) {
    throw new Error("Each machine map client setting passed its check, but the patch did not.");
  }
  return { patch, skipped };
}

/** The report key of the client settings. Report again only when it changes. */
export function clientSettingsReportKey(settings: ClientSettings): string {
  return stableStringify(settings);
}

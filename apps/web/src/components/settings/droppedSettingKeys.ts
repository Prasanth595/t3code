import { ServerSettings, type EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";

interface DroppedSettingKeys {
  readonly serverVersion: string;
  readonly keys: ReadonlySet<string>;
}

// Session-only and per server version, so updating an environment retries its keys.
export const droppedSettingKeysAtom = Atom.make<ReadonlyMap<EnvironmentId, DroppedSettingKeys>>(
  new Map(),
).pipe(Atom.keepAlive, Atom.withLabel("settings:dropped-setting-keys"));

/** Only whole top-level settings count; a dropped sub-field or project override does not. */
export function recordDroppedSettingKeys(
  environmentId: EnvironmentId,
  serverVersion: string,
  paths: readonly string[],
) {
  const keys = paths.filter((path) => Object.hasOwn(ServerSettings.fields, path));
  if (keys.length === 0) return;
  appAtomRegistry.update(droppedSettingKeysAtom, (current) => {
    const existing = current.get(environmentId);
    const next = new Map(current);
    next.set(environmentId, {
      serverVersion,
      keys: new Set([...(existing?.serverVersion === serverVersion ? existing.keys : []), ...keys]),
    });
    return next;
  });
}

export function droppedSettingKeysFor(
  dropped: ReadonlyMap<EnvironmentId, DroppedSettingKeys>,
  environmentId: EnvironmentId,
  serverVersion: string | undefined,
): ReadonlySet<string> | undefined {
  const entry = dropped.get(environmentId);
  return entry && entry.serverVersion === serverVersion ? entry.keys : undefined;
}

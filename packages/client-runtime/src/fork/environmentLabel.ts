import type { ServerConfig } from "@t3tools/contracts";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";

const labels = new WeakMap<ConnectionCatalogEntry, ConnectionCatalogEntry>();

export function machineMapEnvironmentEntry(
  entry: ConnectionCatalogEntry,
  config: ServerConfig | null,
) {
  if (!config?.settings?.environmentLabelFromMachineMap) return entry;
  const label = config.environment.label;
  if (entry.target.label === label) return entry;
  const previous = labels.get(entry);
  if (previous?.target.label === label) return previous;
  const renamed = { ...entry, target: { ...entry.target, label } };
  labels.set(entry, renamed);
  return renamed;
}

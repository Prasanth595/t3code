import type {
  ProviderDisabledInventory,
  ProviderInventoryItem,
  ProviderInventoryKind,
  ProviderInventoryStatus,
} from "@t3tools/contracts";

const INVENTORY_KINDS = [
  "connectors",
  "mcpServers",
  "plugins",
  "skills",
] as const satisfies ReadonlyArray<ProviderInventoryKind>;

/** Returns `undefined` once nothing is switched off, so the key leaves the saved config. */
export function nextDisabledInventory(
  current: ProviderDisabledInventory | undefined,
  kind: ProviderInventoryKind,
  id: string,
  enabledInT3: boolean,
): ProviderDisabledInventory | undefined {
  const ids = new Set(current?.[kind] ?? []);
  if (enabledInT3) ids.delete(id);
  else ids.add(id);
  const next: Record<string, ReadonlyArray<string>> = {};
  for (const candidate of INVENTORY_KINDS) {
    const values = candidate === kind ? [...ids] : (current?.[candidate] ?? []);
    if (values.length > 0) next[candidate] = values;
  }
  return Object.keys(next).length > 0 ? (next as ProviderDisabledInventory) : undefined;
}

export function countDisabledInventory(disabled: ProviderDisabledInventory | undefined): number {
  return INVENTORY_KINDS.reduce((total, kind) => total + (disabled?.[kind]?.length ?? 0), 0);
}

const STATUS_LABELS: Record<ProviderInventoryStatus, string> = {
  connected: "Connected",
  needsAuth: "Needs sign-in",
  failed: "Failed",
  pending: "Connecting",
  disabled: "Off in provider settings",
};

export function inventoryItemDetail(item: ProviderInventoryItem): string | null {
  const parts = [
    item.status ? STATUS_LABELS[item.status] : null,
    item.toolCount === undefined
      ? null
      : `${item.toolCount} tool${item.toolCount === 1 ? "" : "s"}`,
    item.plugin ? `from ${item.plugin}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

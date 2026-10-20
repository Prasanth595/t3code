import {
  formatProviderSyncStatusLine,
  listProviderSyncPeerLabels,
  type ProviderSyncPeer,
} from "@t3tools/client-runtime/state/provider-sync";

import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { Switch } from "../ui/switch";
import { ConnectionStatusDot } from "../ConnectionStatusDot";

export function ProviderSyncAcrossDevices({
  enabled,
  peers,
  disabled,
  onEnabledChange,
}: {
  readonly enabled: boolean;
  readonly peers: ReadonlyArray<ProviderSyncPeer>;
  readonly disabled?: boolean;
  readonly onEnabledChange: (enabled: boolean) => void;
}) {
  const labels = listProviderSyncPeerLabels(peers);
  const status = enabled
    ? formatProviderSyncStatusLine(labels)
    : labels.length > 1
      ? `Off. ${labels.length} devices are connected.`
      : "Off. Turn on to keep providers the same on every connected device.";

  return (
    <SettingsGroup>
      <SettingsRow
        {...searchableSetting("provider-sync-across-devices")}
        description="Keep providers and their non-secret settings the same on every connected device. Accounts and API keys stay on each device."
        control={
          <Switch
            checked={enabled}
            disabled={disabled}
            onCheckedChange={(checked) => onEnabledChange(Boolean(checked))}
            aria-label="Sync providers across devices"
          />
        }
      />
      <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        <ConnectionStatusDot dotClassName={enabled ? "bg-success" : "bg-muted-foreground/40"} />
        <span>{status}</span>
      </div>
    </SettingsGroup>
  );
}

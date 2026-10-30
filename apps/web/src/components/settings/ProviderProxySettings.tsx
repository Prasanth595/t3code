import type { EnvironmentId, UnifiedSettings } from "@t3tools/contracts";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { SecretInput } from "./SecretInput";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const CONTROL_CLASS = "w-full min-w-0 @min-[32rem]/settings-row:w-56";

/** Secrets arrive redacted: any non-empty value means one is stored. */
export function ProviderProxySettings({
  environmentId,
  proxy,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly proxy: UnifiedSettings["providerProxy"];
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const update = (patch: Partial<UnifiedSettings["providerProxy"]>) =>
    updateSettings({ providerProxy: patch });

  return (
    <SettingsSection
      {...searchableSetting("provider-proxy")}
      headerAction={
        proxy.url !== "" && !readOnly ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => update({ url: "", apiKey: "", managementKey: "" })}
          >
            Remove proxy
          </Button>
        ) : null
      }
    >
      <SettingsRow
        id="provider-proxy-url"
        title={<label htmlFor="provider-proxy-url-input">Proxy URL</label>}
        description="A CLIProxyAPI server. Turn on Use proxy for a Claude, Codex, or OpenCode provider to send its requests here."
        control={
          <DraftInput
            id="provider-proxy-url-input"
            size="sm"
            className={CONTROL_CLASS}
            value={proxy.url}
            placeholder="http://192.168.1.10:8317"
            autoComplete="off"
            spellCheck={false}
            disabled={readOnly}
            onCommit={(url) => update({ url: url.trim() })}
          />
        }
      />
      <SettingsRow
        id="provider-proxy-api-key"
        title={<label htmlFor="provider-proxy-api-key-input">API key</label>}
        description="One of the proxy's API keys. Leave empty if the proxy has none."
        control={
          <SecretInput
            id="provider-proxy-api-key-input"
            size="sm"
            className={CONTROL_CLASS}
            value=""
            configured={proxy.apiKey !== ""}
            disabled={readOnly}
            onCommit={(apiKey) => update({ apiKey: apiKey.trim() })}
          />
        }
      />
      <SettingsRow
        id="provider-proxy-management-key"
        title={<label htmlFor="provider-proxy-management-key-input">Management key</label>}
        description="Optional. Shows the proxy's accounts under Usage → Limits."
        control={
          <SecretInput
            id="provider-proxy-management-key-input"
            size="sm"
            className={CONTROL_CLASS}
            value=""
            configured={proxy.managementKey !== ""}
            disabled={readOnly}
            onCommit={(managementKey) => update({ managementKey: managementKey.trim() })}
          />
        }
      />
    </SettingsSection>
  );
}

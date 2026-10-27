import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

/** Secret providers belong to one environment, so this page shows the representative one. */
export function SecretsSettingsPanel() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("secret-providers")}>
        {environment?.connection.phase === "connected" ? (
          <SettingsRow
            title="No secret providers configured."
            description="Add 1Password, OpenBao, or AWS Secrets Manager, then pick it as the source of a provider variable."
          />
        ) : (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Connect an environment to manage the secret providers its provider variables read from.
          </p>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

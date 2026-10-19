/**
 * Fork: the app token of this phone in the Fork settings page. "Refresh machines" reads the
 * machine list from the portal now (MM-914), so a machine that gained access pairs at once.
 */
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { ListActionRow } from "../../components/ui/ListActionRow";
import { requestAppTokenSync } from "../../connection/forkAppTokenRepair";
import { mobilePreferencesAtom } from "../../state/preferences";
import { SettingsSection } from "./components/SettingsSection";

export function AppTokenSettingsSection() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const client = AsyncResult.isSuccess(preferences) ? preferences.value.appTokenClient : undefined;
  if (client === undefined) return null;
  return (
    <SettingsSection
      title="App token"
      footer="This phone pairs again by itself when a machine ends its session, and reads its machines from the portal when it opens."
    >
      <ListActionRow
        icon="arrow.uturn.backward"
        label="Refresh machines"
        detail={new URL(client.machinesUrl).host}
        onPress={requestAppTokenSync}
      />
    </SettingsSection>
  );
}

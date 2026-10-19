import { useNavigation } from "@react-navigation/native";

import { SettingsRow } from "../features/settings/components/SettingsRow";
import { SettingsSection } from "../features/settings/components/SettingsSection";

export function FactorySettingsRow() {
  const navigation = useNavigation();
  return (
    <SettingsSection>
      <SettingsRow icon="hammer" label="Factory" onPress={() => navigation.navigate("Factory")} />
    </SettingsSection>
  );
}

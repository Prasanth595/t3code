import { useNavigation } from "@react-navigation/native";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../../components/ui/AppText";
import { ScreenScrollView as ScrollView } from "../../../components/ui/ScreenScrollView";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useSettingsEnvironmentFilter } from "../settings-environment-filter";
import { searchSettings } from "../settings-search";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

export function SettingsSearchResults(props: { readonly query: string }) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { selectedTargets, selectedProjectKey } = useSettingsEnvironmentFilter();
  const results = searchSettings(props.query, {
    platform: Platform.OS,
    hasCloud: hasCloudPublicConfig(),
    hasEnvironment: selectedTargets.length > 0,
    hasProject: selectedProjectKey !== null,
  });

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      showsVerticalScrollIndicator={false}
      className="flex-1 bg-sheet"
      contentContainerClassName="gap-4 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
    >
      {results.length > 0 ? (
        <SettingsSection title="Search results">
          {results.map((item) => (
            <SettingsRow
              key={item.target}
              icon={item.icon}
              label={item.title}
              value={item.section}
              valuePosition="below"
              {...(item.target === "SettingsAuth"
                ? {
                    onPress: () => navigation.navigate("SettingsSheet", { screen: "SettingsAuth" }),
                  }
                : item.target === "SettingsLegal"
                  ? { fullScreenTarget: item.target }
                  : { target: item.target })}
            />
          ))}
        </SettingsSection>
      ) : (
        <Text className="px-4 py-6 text-center text-sm text-foreground-muted">
          No settings found for "{props.query.trim()}".
        </Text>
      )}
    </ScrollView>
  );
}

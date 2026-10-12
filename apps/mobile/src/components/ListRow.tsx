import { Platform } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { SymbolView } from "./AppSymbol";
import { ListRowLayout, type ListRowContentProps } from "./ListRowLayout";
import { RowPressable } from "./RowPressable";

/** A navigation row owns its look; callers supply content and destination behavior. */
export function ListRow(props: ListRowContentProps & { readonly onPress: () => void }) {
  const { themeVariables } = useAppearancePreferences();
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={[props.label, props.description, props.detail].filter(Boolean).join(", ")}
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={props.onPress}
      android_ripple={{ color: themeVariables["--color-subtle-strong"] }}
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
      className="bg-grouped-card"
    >
      <ListRowLayout
        {...props}
        accessory={
          <SymbolView
            name="chevron.right"
            size={16}
            tintColorClassName="accent-chevron"
            type="monochrome"
            weight="semibold"
          />
        }
      />
    </RowPressable>
  );
}

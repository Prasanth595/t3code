import { useNavigation, useRoute } from "@react-navigation/native";
import type { ComponentProps } from "react";
import { Platform } from "react-native";

import { ListRow } from "../../../components/ui/ListRow";
import type { SettingsLegalDocumentTarget, SettingsSheetTarget } from "./settings-sheet-targets";
import { openSettings } from "../settings-navigation";

export function SettingsRow(props: {
  readonly disabled?: boolean;
  readonly icon: ComponentProps<typeof ListRow>["icon"];
  readonly label: string;
  readonly value?: string;
  readonly valuePosition?: "below" | "trailing";
  readonly target?: SettingsSheetTarget;
  readonly fullScreenTarget?: SettingsLegalDocumentTarget;
  readonly onPress?: () => void;
}) {
  const navigation = useNavigation();
  // The Settings list opens pages in place of the detail column; a page's own rows push below.
  const inList = ["Home", "Settings"].includes(useRoute().name);
  const valueBelow =
    props.valuePosition === "below" ||
    (props.valuePosition === undefined && Platform.OS === "android");
  return (
    <ListRow
      icon={props.icon}
      label={props.label}
      description={valueBelow ? props.value : undefined}
      detail={valueBelow ? undefined : props.value}
      disabled={props.disabled}
      onPress={() => {
        if (props.target) {
          if (inList) openSettings(navigation, props.target);
          else navigation.navigate(props.target);
        } else if (props.fullScreenTarget) {
          navigation.navigate(props.fullScreenTarget);
        } else {
          props.onPress?.();
        }
      }}
    />
  );
}

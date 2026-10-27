import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { View } from "react-native";
import { Text } from "@expo/ui/jetpack-compose";
import { IconButton } from "../../components/ui/IconButton";
import { NativeAppBar } from "../../components/ui/NativeAppBar.android";

export function NativeAppBarExample() {
  const typography = useScaledTextRole("title");
  return (
    <NativeAppBar
      title={<Text style={{ fontSize: typography.fontSize }}>Native app bar</Text>}
      navigationIcon={
        <IconButton icon="arrow.left" accessibilityLabel="Example back" onPress={() => {}} />
      }
      actions={
        <View className="flex-row">
          <IconButton
            icon="magnifyingglass"
            accessibilityLabel="Example search"
            onPress={() => {}}
          />
        </View>
      }
    />
  );
}

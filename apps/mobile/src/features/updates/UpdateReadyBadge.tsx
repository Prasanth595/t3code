import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSyncExternalStore } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { isAppUpdateReady, runAppUpdateCheck, subscribeUpdateReady } from "./app-updates";

/** Shown while a downloaded update waits for a restart; tapping installs it now. */
export function UpdateReadyBadge() {
  const ready = useSyncExternalStore(subscribeUpdateReady, isAppUpdateReady);
  const insets = useSafeAreaInsets();
  if (!ready) return null;
  return (
    <View
      pointerEvents="box-none"
      className="absolute left-4 z-[5]"
      style={{ bottom: Math.max(insets.bottom, 16) + 16 }}
    >
      <Pressable
        accessibilityLabel="Update ready, restart to install"
        accessibilityRole="button"
        className="h-10 flex-row items-center gap-2 rounded-full bg-primary px-4 active:opacity-80"
        onPress={() => void runAppUpdateCheck({ applyMode: "immediate" })}
      >
        <SymbolView
          name="arrow.down.circle"
          size={16}
          tintColorClassName="accent-primary-foreground"
          type="monochrome"
        />
        <Text className="text-sm font-t3-bold text-primary-foreground">Update</Text>
      </Pressable>
    </View>
  );
}

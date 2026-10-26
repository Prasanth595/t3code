import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";

import { EmptyState } from "../../components/ui/EmptyState";
import { openMiraUpgrade, useMiraAccess } from "./miraChat";

/** The Agent tab for plans without agentic mode: what it does and how to get it. */
export function AgentLockedScreen() {
  const navigation = useNavigation();
  const access = useMiraAccess();
  return (
    <View className="flex-1 items-center justify-center bg-screen px-4">
      <EmptyState
        variant="plain"
        title="Agent is available with Pro"
        detail={
          access.signedIn
            ? "With Pro, Mira works on your computer: it edits files, runs commands, and finishes tasks for you. Chat stays unlimited on every plan."
            : "Create a free account first. Then upgrade to Pro to let Mira work on your computer."
        }
        actionLabel={access.signedIn ? "Upgrade to Pro" : "Create free account"}
        onAction={() => {
          if (access.signedIn) void openMiraUpgrade().catch(() => undefined);
          else navigation.navigate("SettingsAuth");
        }}
      />
    </View>
  );
}

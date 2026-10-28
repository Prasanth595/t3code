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
        title="Agentul e disponibil cu Pro"
        detail={
          access.signedIn
            ? "Cu Pro, Mira lucrează pe calculatorul tău: editează fișiere, rulează comenzi și duce sarcinile la capăt pentru tine. Chat-ul rămâne nelimitat pe orice plan."
            : "Creează mai întâi un cont gratuit. Apoi treci la Pro ca Mira să lucreze pe calculatorul tău."
        }
        actionLabel={access.signedIn ? "Treci la Pro" : "Creează cont gratuit"}
        onAction={() => {
          if (access.signedIn) void openMiraUpgrade().catch(() => undefined);
          else navigation.navigate("SettingsAuth");
        }}
      />
    </View>
  );
}

import * as Dialog from "../../components/ui/Dialog";
import type { ServerProvider } from "@t3tools/contracts";
import { CHATGPT_USAGE_URL, usesChatGptSharing } from "@t3tools/shared/usageLimits";
import { Linking, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";

export function ChatGptSharingStatus({ provider }: { provider: ServerProvider | null }) {
  if (!usesChatGptSharing(provider)) return null;
  return (
    <View className="flex-row items-center justify-between gap-3 px-3 py-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Partajarea token-ului ChatGPT e activă"
        className="min-h-11 flex-row items-center gap-2"
        onPress={() => {
          Dialog.alert(
            "Partajarea ChatGPT e activă",
            [
              provider?.auth.email,
              "Utilizarea eligibilă folosește planul tău ChatGPT. Creditele și limitele se gestionează în ChatGPT.",
            ]
              .filter(Boolean)
              .join("\n\n"),
          );
        }}
      >
        <ProviderIcon provider="codex" size={14} />
        <Text className="text-xs text-foreground-muted">Folosește planul ChatGPT</Text>
      </Pressable>
      <Pressable
        accessibilityRole="link"
        className="min-h-11 justify-center"
        onPress={() => void Linking.openURL(CHATGPT_USAGE_URL).catch(() => undefined)}
      >
        <Text className="text-xs font-t3-medium text-primary">Gestionează utilizarea</Text>
      </Pressable>
    </View>
  );
}

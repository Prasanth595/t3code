import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_USAGE_URL,
  CHATGPT_WORKSPACE_ADMIN_REQUEST,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimits";
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Linking, View } from "react-native";
import { ProviderIcon } from "../../components/ProviderIcon";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";

export function ChatGptUsageLimitNotice({ thread }: { thread: EnvironmentThreadShell }) {
  const [status, setStatus] = useState<"copied" | "copy-failed" | "open-failed" | null>(null);
  const code = thread.runtime?.lastErrorCode;
  const workspaceLimit = code === CHATGPT_WORKSPACE_USAGE_LIMIT_CODE;
  if (thread.runtime?.status !== "failed" || (!workspaceLimit && code !== CHATGPT_USAGE_LIMIT_CODE))
    return null;
  return (
    <View
      accessibilityRole="alert"
      className="mx-3 mb-2 gap-2 rounded-xl border border-border-subtle bg-screen p-3"
    >
      <View className="flex-row items-center gap-2">
        <ProviderIcon provider="codex" size={16} />
        <Text className="text-sm font-t3-medium text-foreground">
          Ai atins limita de utilizare ChatGPT
        </Text>
      </View>
      <Text className="text-xs text-foreground-muted">
        {workspaceLimit
          ? status === "copied"
            ? "Cererea a fost copiată. Trimite-o administratorului spațiului de lucru."
            : "Ai atins limita spațiului de lucru pentru folosirea planului ChatGPT în alte aplicații. Copiază o cerere ca să-i ceri administratorului limite mai mari."
          : "Verifică setările de utilizare în ChatGPT."}
      </Text>
      {workspaceLimit ? (
        <Button
          label="Copiază cererea pentru administrator"
          tone="primary"
          onPress={() =>
            void Clipboard.setStringAsync(CHATGPT_WORKSPACE_ADMIN_REQUEST).then(
              () => setStatus("copied"),
              () => setStatus("copy-failed"),
            )
          }
        />
      ) : (
        <Button
          label="Gestionează utilizarea"
          tone="primary"
          onPress={() =>
            void Linking.openURL(CHATGPT_USAGE_URL).then(
              () => setStatus(null),
              () => setStatus("open-failed"),
            )
          }
        />
      )}
      {status === "copy-failed" || status === "open-failed" ? (
        <Text accessibilityRole="alert" className="text-xs text-destructive">
          {status === "copy-failed"
            ? "Cererea nu a putut fi copiată. Încearcă din nou."
            : "ChatGPT nu a putut fi deschis. Mergi la chatgpt.com → Settings → Usage."}
        </Text>
      ) : null}
    </View>
  );
}

import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ConnectionFormField } from "../connection/ConnectionFormField";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

/**
 * Fork: `voiceTranscriptionOpenAiApiKey` of the selected environments. Each environment keeps
 * the key in its own secret store; the app only learns whether one is saved.
 */
export function VoiceTranscriptionKeySection() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const writable = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "voice transcription key update",
    reportFailure: true,
  });
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  if (selectedTargets.length === 0) return null;

  const saved = selectedTargets.filter(
    (target) => target.serverConfig.settings.voiceTranscriptionOpenAiApiKey !== "",
  );
  const canWrite = selectedTargets.every((target) => writable.has(target.environmentId));

  const save = async (key: string) => {
    setPending(true);
    const results = await Promise.all(
      selectedTargets.map((target) =>
        updateSettings({
          environmentId: target.environmentId,
          input: { patch: { voiceTranscriptionOpenAiApiKey: key } },
        }),
      ),
    );
    setPending(false);
    if (results.every((result) => result._tag === "Success")) setDraft("");
  };

  return (
    <>
      <SettingsSection title="Server transcription">
        <View collapsable={false} className="gap-3 bg-grouped-card px-4 py-4">
          <ConnectionFormField
            label="OpenAI API key"
            placeholder={saved.length > 0 ? "Saved" : "xi-…"}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            editable={canWrite && !pending}
            value={draft}
            onChangeText={setDraft}
          />
        </View>
        <SettingsActionRow
          icon="checkmark"
          label="Save key"
          loading={pending}
          disabled={!canWrite || pending || draft.trim() === ""}
          onPress={() => void save(draft.trim())}
        />
        {saved.length > 0 ? (
          <SettingsActionRow
            icon="trash"
            label="Remove key"
            tone="danger"
            disabled={!canWrite || pending}
            onPress={() => void save("")}
          />
        ) : null}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        {saved.length === 0
          ? "Without a key, voice input works only where this device can transcribe on its own."
          : `Saved on ${saved.map((target) => target.label).join(", ")}.`}{" "}
        With a key, the server sends recordings to OpenAI and deletes them after transcription.
      </Text>
    </>
  );
}

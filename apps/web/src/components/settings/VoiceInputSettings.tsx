import { VOICE_TRANSCRIPTION_MODEL } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button, InlineButton } from "../ui/button";
import { SecretInput } from "./SecretInput";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * Fork: `voiceTranscriptionOpenAiApiKey`. Saved per environment, never through the machine map,
 * because each environment keeps its own secret store.
 */
export function VoiceInputSettingsRow() {
  const { targets } = useSettingsScope();
  const environments = [
    ...new Map(targets.map((target) => [target.environmentId, target.settings])).entries(),
  ];
  const savedCount = environments.filter(
    ([, settings]) => settings.voiceTranscriptionOpenAiApiKey !== "",
  ).length;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save voice input key",
  });
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async (key: string) => {
    setSaving(true);
    const results = await Promise.all(
      environments.map(([environmentId]) =>
        updateSettings({
          environmentId,
          input: { patch: { voiceTranscriptionOpenAiApiKey: key } },
        }),
      ),
    );
    setSaving(false);
    if (results.every((result) => result._tag === "Success")) setDraft("");
  };

  return (
    <SettingsRow
      {...searchableSetting("voice-input-openai-key")}
      serverScoped
      settingKeys={["voiceTranscriptionOpenAiApiKey"]}
      description={
        <>
          Shows a microphone in the composer. Recordings go to OpenAI ({VOICE_TRANSCRIPTION_MODEL})
          with this environment's key, and the text lands in your draft. The iPhone app transcribes
          on the device and uses this key only when it cannot.{" "}
          <InlineButton
            render={
              <a
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noreferrer noopener"
              />
            }
          >
            Create a key
            <ExternalLinkIcon aria-hidden className="size-3" />
          </InlineButton>
        </>
      }
      status={
        savedCount === 0
          ? "Off"
          : savedCount === environments.length
            ? "Key saved"
            : `Key saved on ${savedCount} of ${environments.length} environments`
      }
    >
      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim()) void save(draft.trim());
        }}
      >
        <fieldset disabled={saving || environments.length === 0} className="contents">
          <SecretInput
            className="min-w-48 flex-1"
            size="sm"
            aria-label="OpenAI API key"
            configured={savedCount > 0}
            placeholder="xi-…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          {savedCount > 0 ? (
            <Button size="xs" variant="outline" onClick={() => void save("")}>
              Remove
            </Button>
          ) : null}
          <Button type="submit" size="xs" disabled={!draft.trim()}>
            Save
          </Button>
        </fieldset>
      </form>
    </SettingsRow>
  );
}

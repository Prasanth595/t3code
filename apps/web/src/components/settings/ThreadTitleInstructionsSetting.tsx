import { useState } from "react";

import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function ThreadTitleInstructionsSetting() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["threadTitleInstructions"]);
  const value = mixed ? "" : settings.threadTitleInstructions;
  // Holds the text from the first edit until blur, so a settings push from
  // another client or a scope change never replaces an edit in progress, and
  // leaving the field without an edit writes nothing.
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <SettingsRow
      serverScoped
      settingKeys={["threadTitleInstructions"]}
      {...searchableSetting("thread-title-instructions")}
      description="Appended to the prompt that names new threads and regenerates titles."
      resetAction={
        mixed || settings.threadTitleInstructions !== "" ? (
          <SettingResetButton
            label="thread title instructions"
            onClick={() => updateSettings({ threadTitleInstructions: "" })}
          />
        ) : null
      }
    >
      <div className="mt-3 max-w-2xl pb-3.5">
        <Textarea
          aria-label="Thread title instructions"
          rows={3}
          value={draft ?? value}
          placeholder={
            mixed
              ? "Mixed. Enter instructions to apply to all selected targets."
              : "Start with the issue key when the message names one, such as ABC-123 Fix login timeout."
          }
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft === null) return;
            const next = draft.trim();
            setDraft(null);
            if (mixed || next !== value) updateSettings({ threadTitleInstructions: next });
          }}
        />
      </div>
    </SettingsRow>
  );
}

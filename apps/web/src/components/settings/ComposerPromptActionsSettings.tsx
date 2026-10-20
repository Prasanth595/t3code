import {
  COMPOSER_PROMPT_ACTION_LABEL_MAX_LENGTH,
  COMPOSER_PROMPT_ACTION_PROMPT_MAX_LENGTH,
  COMPOSER_PROMPT_ACTIONS_MAX_COUNT,
  type ComposerPromptAction,
  DEFAULT_COMPOSER_PROMPT_ACTIONS,
} from "@t3tools/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { getClientSettings, updateClientSettings, useClientSettings } from "~/hooks/useSettings";
import { randomUUID } from "~/lib/utils";
import { composerPromptActionsAreDefault } from "../chat/composerPromptActions";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Textarea } from "../ui/textarea";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

// Edits apply to the newest saved list, not the one this render saw, so a blur that saves one
// field and a click that removes another action cannot overwrite each other.
function updateComposerPromptActions(
  update: (actions: ReadonlyArray<ComposerPromptAction>) => ReadonlyArray<ComposerPromptAction>,
) {
  void updateClientSettings({
    composerPromptActions: update(getClientSettings().composerPromptActions),
  });
}

function updateComposerPromptAction(id: string, patch: Partial<ComposerPromptAction>) {
  updateComposerPromptActions((actions) =>
    actions.map((action) => (action.id === id ? { ...action, ...patch } : action)),
  );
}

function ComposerPromptActionPromptField(props: { action: ComposerPromptAction }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Textarea
      size="sm"
      aria-label={`${props.action.label || "Action"} prompt`}
      placeholder="Text added to the end of your prompt"
      maxLength={COMPOSER_PROMPT_ACTION_PROMPT_MAX_LENGTH}
      value={draft ?? props.action.prompt}
      onFocus={() => setDraft(props.action.prompt)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const next = (draft ?? props.action.prompt).trim();
        setDraft(null);
        if (next !== props.action.prompt) {
          updateComposerPromptAction(props.action.id, { prompt: next });
        }
      }}
    />
  );
}

export function ComposerPromptActionsSetting() {
  const actions = useClientSettings((settings) => settings.composerPromptActions);

  return (
    <SettingsRow
      {...searchableSetting("composer-prompt-actions")}
      description="Saved text that Actions in the composer adds to the end of your prompt."
      resetAction={
        composerPromptActionsAreDefault(actions) ? null : (
          <SettingResetButton
            label="composer actions"
            onClick={() =>
              void updateClientSettings({ composerPromptActions: DEFAULT_COMPOSER_PROMPT_ACTIONS })
            }
          />
        )
      }
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={actions.length >= COMPOSER_PROMPT_ACTIONS_MAX_COUNT}
          onClick={() =>
            updateComposerPromptActions((current) => [
              ...current,
              { id: randomUUID(), label: "", prompt: "" },
            ])
          }
        >
          <PlusIcon />
          Add action
        </Button>
      }
    >
      {actions.length > 0 ? (
        <div className="grid gap-2 pt-1 pb-2">
          {actions.map((action) => (
            <div key={action.id} className="grid gap-2 rounded-lg border border-border p-2">
              <div className="flex items-center gap-2">
                <DraftInput
                  nativeInput
                  size="sm"
                  className="min-w-0 flex-1"
                  aria-label="Action label"
                  placeholder="Label"
                  maxLength={COMPOSER_PROMPT_ACTION_LABEL_MAX_LENGTH}
                  value={action.label}
                  onCommit={(label) =>
                    updateComposerPromptAction(action.id, { label: label.trim() })
                  }
                />
                <Button
                  size="icon-sm"
                  variant="ghost-destructive"
                  aria-label={`Remove ${action.label || "action"}`}
                  onClick={() =>
                    updateComposerPromptActions((current) =>
                      current.filter((candidate) => candidate.id !== action.id),
                    )
                  }
                >
                  <Trash2Icon />
                </Button>
              </div>
              <ComposerPromptActionPromptField action={action} />
            </div>
          ))}
        </div>
      ) : null}
    </SettingsRow>
  );
}

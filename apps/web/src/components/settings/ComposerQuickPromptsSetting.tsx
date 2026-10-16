import type { ComposerQuickPrompt } from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import {
  getClientSettings,
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
} from "~/hooks/useSettings";
import { randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Textarea } from "../ui/textarea";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const QUICK_PROMPT_LABEL_MAX_LENGTH = 32;

export function ComposerQuickPromptsSetting() {
  const quickPrompts = useClientSettings((settings) => settings.composerQuickPrompts);
  const settingsHydrated = useClientSettingsHydrated();
  const updateSettings = useUpdateClientSettings();
  const [addedId, setAddedId] = useState<string | null>(null);

  // Read live settings so two edits before a re-render don't overwrite each other.
  const update = (next: (current: ReadonlyArray<ComposerQuickPrompt>) => ComposerQuickPrompt[]) => {
    if (!settingsHydrated) return;
    void updateSettings({ composerQuickPrompts: next(getClientSettings().composerQuickPrompts) });
  };
  const patch = (id: string, fields: Partial<Omit<ComposerQuickPrompt, "id">>) =>
    update((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, ...fields } : entry)),
    );

  return (
    <SettingsRow
      {...searchableSetting("composer-quick-prompts")}
      description="Show prompts you use often as pills above the composer. Clicking one adds it to your message."
      control={
        <Button
          size="xs"
          variant="outline"
          disabled={!settingsHydrated}
          onClick={() => {
            const id = `quick-prompt-${randomUUID()}`;
            update((current) => [...current, { id, label: "", prompt: "" }]);
            setAddedId(id);
          }}
        >
          <PlusIcon />
          Add prompt
        </Button>
      }
    >
      {quickPrompts.length > 0 ? (
        <div className="flex flex-col gap-2 pt-3 pb-2">
          {quickPrompts.map((entry, index) => (
            <div key={entry.id} className="flex items-start gap-2">
              <DraftInput
                size="sm"
                className="w-32 shrink-0"
                placeholder="Label"
                aria-label="Quick prompt label"
                maxLength={QUICK_PROMPT_LABEL_MAX_LENGTH}
                autoFocus={entry.id === addedId}
                value={entry.label}
                onCommit={(label) => patch(entry.id, { label })}
              />
              <QuickPromptTextarea
                value={entry.prompt}
                onCommit={(prompt) => patch(entry.id, { prompt })}
              />
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Remove ${entry.label.trim() || `quick prompt ${index + 1}`}`}
                onClick={() => update((current) => current.filter((item) => item.id !== entry.id))}
              >
                <XIcon />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </SettingsRow>
  );
}

// Commits on blur like DraftInput, but keeps Enter for newlines in longer prompts.
function QuickPromptTextarea(props: {
  readonly value: string;
  readonly onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Textarea
      size="sm"
      placeholder="Prompt, $skill or /command"
      aria-label="Quick prompt text"
      value={draft ?? props.value}
      onFocus={() => setDraft(props.value)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const next = draft ?? props.value;
        setDraft(null);
        if (next !== props.value) props.onCommit(next);
      }}
    />
  );
}

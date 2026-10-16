import { memo } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { Button } from "../ui/button";

export const ComposerQuickPrompts = memo(function ComposerQuickPrompts(props: {
  onInsert: (prompt: string) => void;
}) {
  const quickPrompts = useClientSettings((settings) => settings.composerQuickPrompts);
  const ready = quickPrompts.filter(
    (entry) => entry.label.trim() !== "" && entry.prompt.trim() !== "",
  );
  if (ready.length === 0) return null;

  return (
    <div
      role="group"
      aria-label="Quick prompts"
      data-composer-quick-prompts="true"
      // The composer's command and stash menus open over this row. Hide the pills rather
      // than unmount them, so the composer doesn't move when a menu opens.
      className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-wrap gap-1.5 px-2 pb-2 has-[+[data-slot=composer-shell]_[data-composer-menu-open]]:invisible"
    >
      {ready.map((entry) => (
        <Button
          key={entry.id}
          type="button"
          size="xs"
          variant="outline"
          title={entry.prompt}
          // Keep focus and the caret in the editor while clicking a pill.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => props.onInsert(entry.prompt)}
        >
          {entry.label.trim()}
        </Button>
      ))}
    </div>
  );
});

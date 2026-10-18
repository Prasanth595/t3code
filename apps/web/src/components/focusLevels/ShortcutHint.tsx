import { useAtomValue } from "@effect/atom-react";
import type { ClientSettings, KeybindingCommand } from "@t3tools/contracts";
import type { ComponentProps, ReactNode } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import {
  effectiveShortcutsForCommand,
  formatShortcutLabel,
  type ShortcutMatchContext,
} from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type ShortcutContext = Partial<ShortcutMatchContext>;

const selectTooltipShortcuts = (settings: ClientSettings) => settings.tooltipShortcuts;
const selectFocusLevels = (settings: ClientSettings) => settings.keyboardFocusLevels;

// The level flags are always false while focus levels are off, so a key that needs one does nothing.
const LEVELS_OFF = {
  composerFocus: false,
  timelineFocus: false,
  rightPanelFocus: false,
  sidebarFocus: false,
} satisfies ShortcutContext;

const selectShortcutLimit = (settings: ClientSettings) => settings.tooltipShortcutLimit;

/**
 * Every key that runs `command` where the tooltip shows. The last matching rule wins, so the
 * user's own rules, which come after the defaults, are listed first.
 */
function useShortcutLabels(
  command: KeybindingCommand | null,
  context?: ShortcutContext,
): ReadonlyArray<string> {
  const enabled = useClientSettings(selectTooltipShortcuts);
  const levels = useClientSettings(selectFocusLevels);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  if (!enabled || command === null) return [];
  const shortcuts = effectiveShortcutsForCommand(keybindings, command, {
    context: levels ? (context ?? {}) : { ...context, ...LEVELS_OFF },
  });
  return [...new Set(shortcuts.map((shortcut) => formatShortcutLabel(shortcut)))];
}

/** Keys beyond the `tooltipShortcutLimit` setting show as "+N"; Settings → Keybindings lists them all. */
function ShortcutChips({ labels }: { labels: ReadonlyArray<string> }) {
  const limit = useClientSettings(selectShortcutLimit);
  const hidden = labels.length - limit;
  return (
    <span className="ms-1.5 inline-flex items-center gap-1 align-middle">
      {labels.slice(0, limit).map((label) => (
        <Kbd key={label}>{label}</Kbd>
      ))}
      {hidden > 0 ? <span className="text-muted-foreground">+{hidden}</span> : null}
    </span>
  );
}

/**
 * Fork: the keys of `command` as chips after the text of an existing tooltip. A tooltip popup
 * mounts only while open, so many rows cost no subscription until one shows its tooltip.
 */
export function ShortcutHint(props: {
  command: KeybindingCommand | null;
  context?: ShortcutContext;
}) {
  const labels = useShortcutLabels(props.command, props.context);
  return labels.length > 0 ? <ShortcutChips labels={labels} /> : null;
}

/**
 * Fork: a tooltip trigger for a control without a tooltip. The tooltip shows `label` and the key
 * of `command`, and only when the command has a key. Use it as the trigger or as its `render`.
 */
export function ShortcutTooltip({
  command,
  context,
  label,
  side,
  ...triggerProps
}: ComponentProps<typeof TooltipTrigger> & {
  command: KeybindingCommand | null;
  context?: ShortcutContext;
  label: ReactNode;
  side?: ComponentProps<typeof TooltipPopup>["side"];
}) {
  const labels = useShortcutLabels(command, context);
  return (
    <Tooltip disabled={labels.length === 0}>
      <TooltipTrigger {...triggerProps} />
      {labels.length > 0 ? (
        <TooltipPopup side={side}>
          {label}
          <ShortcutChips labels={labels} />
        </TooltipPopup>
      ) : null}
    </Tooltip>
  );
}

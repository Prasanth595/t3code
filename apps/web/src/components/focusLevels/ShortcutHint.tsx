import { useAtomValue } from "@effect/atom-react";
import type { ClientSettings, KeybindingCommand } from "@t3tools/contracts";
import type { ComponentProps, ReactNode } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { shortcutLabelForCommand, type ShortcutMatchContext } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
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

function useShortcutLabel(command: KeybindingCommand | null, context?: ShortcutContext) {
  const enabled = useClientSettings(selectTooltipShortcuts);
  const levels = useClientSettings(selectFocusLevels);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  if (!enabled) return null;
  return shortcutLabelForCommand(keybindings, command, {
    context: levels ? (context ?? {}) : { ...context, ...LEVELS_OFF },
  });
}

/**
 * Fork: the key of `command` after the text of an existing tooltip, as " (⌘S)". A tooltip popup
 * mounts only while open, so many rows cost no subscription until one shows its tooltip.
 */
export function ShortcutHint(props: {
  command: KeybindingCommand | null;
  context?: ShortcutContext;
}) {
  const label = useShortcutLabel(props.command, props.context);
  return label ? ` (${label})` : null;
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
  const shortcut = useShortcutLabel(command, context);
  return (
    <Tooltip disabled={!shortcut}>
      <TooltipTrigger {...triggerProps} />
      {shortcut ? (
        <TooltipPopup side={side}>
          {label} ({shortcut})
        </TooltipPopup>
      ) : null}
    </Tooltip>
  );
}

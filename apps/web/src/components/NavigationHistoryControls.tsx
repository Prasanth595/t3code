import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { shortcutLabelForCommand } from "../keybindings";
import { createNavigationHistoryStore } from "../navigationHistory";
import { primaryServerKeybindingsAtom } from "../state/server";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function NavigationHistoryControls({ onBackdrop }: { onBackdrop: boolean }) {
  const { history } = useRouter();
  const [store] = useState(() => {
    const navigation = window.navigation;
    const currentEntry = navigation?.currentEntry;
    const forwardEntries = currentEntry ? navigation.entries().length - currentEntry.index - 1 : 0;
    return createNavigationHistoryStore(history, forwardEntries);
  });
  const { canGoBack, canGoForward } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const controls = [
    ["Back", "navigation.back", ArrowLeftIcon, canGoBack, () => history.back()],
    ["Forward", "navigation.forward", ArrowRightIcon, canGoForward, () => history.forward()],
  ] as const;

  return (
    <div
      className="pointer-events-auto hidden items-center [-webkit-app-region:no-drag] md:flex"
      role="group"
      aria-label="Navigation history"
    >
      {controls.map(([label, command, Icon, enabled, onClick]) => {
        const shortcut = shortcutLabelForCommand(keybindings, command);
        return (
          <Tooltip key={command}>
            <TooltipTrigger render={<span className="relative flex" />}>
              <Button
                aria-label={label}
                disabled={!enabled}
                onClick={onClick}
                size="icon-sm"
                variant={onBackdrop ? "media-navigation" : "ghost"}
                className={onBackdrop ? "relative top-auto translate-y-0" : undefined}
              >
                <Icon />
              </Button>
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {label}
              {shortcut ? ` (${shortcut})` : ""}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}

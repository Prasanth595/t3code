import type { ComposerPromptAction } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { SettingsIcon, ZapIcon } from "lucide-react";
import { memo } from "react";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ComposerControl, ComposerControlIcon, ComposerControlSeparator } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

export const COMPOSER_PROMPT_ACTIONS_SETTING_ID = "composer-prompt-actions";

/** Shared by the footer menu and the overflow menu that takes its place on narrow composers. */
export function ComposerPromptActionsMenuItems(props: {
  actions: ReadonlyArray<ComposerPromptAction>;
  onRunAction: (action: ComposerPromptAction) => void;
}) {
  const navigate = useNavigate();
  return (
    <>
      {props.actions.map((action) => (
        <MenuItem key={action.id} className="max-w-80" onClick={() => props.onRunAction(action)}>
          <span className="grid min-w-0 gap-0.5 py-0.5">
            <MenuItemLabel>{action.label}</MenuItemLabel>
            <span className="truncate text-muted-foreground text-xs">{action.prompt}</span>
          </span>
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem
        onClick={() =>
          void navigate({ to: "/settings/general", hash: COMPOSER_PROMPT_ACTIONS_SETTING_ID })
        }
      >
        <SettingsIcon />
        <MenuItemLabel>Edit actions</MenuItemLabel>
      </MenuItem>
    </>
  );
}

export const ComposerPromptActionsMenu = memo(function ComposerPromptActionsMenu(props: {
  actions: ReadonlyArray<ComposerPromptAction>;
  size?: "sm" | "xs";
  /** Closes the portaled popup when the footer moves this block into overflow. */
  hidden?: boolean;
  onRunAction: (action: ComposerPromptAction) => void;
}) {
  const size = props.size ?? "sm";
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);

  return (
    <>
      <ComposerControlSeparator size={size} />
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          render={<ComposerControl size={size} className="shrink-0" aria-label="Prompt actions" />}
        >
          <ComposerControlIcon icon={ZapIcon} size={size} />
          <span data-composer-control-label className="sr-only sm:not-sr-only">
            Actions
          </span>
        </MenuTrigger>
        <MenuPopup align="start" {...composerFloatingLayerProps}>
          <ComposerPromptActionsMenuItems actions={props.actions} onRunAction={props.onRunAction} />
        </MenuPopup>
      </Menu>
    </>
  );
});

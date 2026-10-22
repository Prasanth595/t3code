import type { ScopedThreadRef, TerminalShellSetting } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { ChevronDownIcon } from "lucide-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useQuietThreadShell } from "../../state/entities";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { MiddleTruncate } from "../ui/middle-truncate";
import { isCustomShell } from "./terminalShell.logic";
import { useTerminalShells } from "./useTerminalShells";

/**
 * Chevron beside "New terminal": lists the shells detected on the thread's
 * environment. The list is fetched when the menu first opens.
 */
export function NewTerminalShellMenu({
  threadRef,
  disabled,
  onSelect,
}: {
  threadRef: ScopedThreadRef;
  disabled: boolean;
  onSelect: (shell: TerminalShellSetting) => void;
}) {
  const { shells, load } = useTerminalShells(threadRef.environmentId);
  const settings = useEnvironmentSettings(threadRef.environmentId);
  const serverThread = useQuietThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const projectId = serverThread?.projectId ?? draftThread?.projectId ?? null;
  const configured = resolveProjectSettings(settings, projectId, null).settings.terminalShell;
  const customShell = isCustomShell(configured) ? configured : null;

  return (
    <Menu onOpenChange={(open) => open && load()}>
      <MenuTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            disabled={disabled}
            aria-label="New terminal with shell"
          />
        }
      >
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="end" width="content" className="max-w-80">
        {(shells ?? []).map((shell) => (
          <MenuItem key={shell.id} onClick={() => onSelect(shell.id)}>
            <ShellOption label={shell.label} command={shell.command} />
          </MenuItem>
        ))}
        {customShell ? (
          <MenuItem onClick={() => onSelect(customShell)}>
            <ShellOption label="Custom" command={customShell.command} />
          </MenuItem>
        ) : null}
        {shells === null ? (
          <span className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</span>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

export function ShellOption({ label, command }: { label: string; command: string }) {
  return (
    <span className="grid min-w-0 gap-0.5">
      <span>{label}</span>
      <span className="flex min-w-0 text-xs leading-4 text-muted-foreground">
        <MiddleTruncate value={command} />
      </span>
    </span>
  );
}

import type { ClientSettings } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { isElectron } from "../../env";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import {
  AREA_OF_LEVEL,
  buildCheatSheet,
  type CheatSheetAreaId,
  filterCheatSheet,
} from "./cheatSheet.logic";
import { focusLevelOf } from "./focusLevels";
import { registerFocusLevelCommands } from "./useFocusLevelShortcuts";

const selectFocusLevels = (settings: ClientSettings) => settings.keyboardFocusLevels;

/**
 * Fork: the keyboard cheat sheet (`keyboard.cheatSheet`, `mod+/`). It lists every key that works,
 * grouped by screen area, with the area that had focus first. It reads the keybindings when it
 * opens, so it always shows the user's own keys.
 */
export function KeyboardCheatSheet() {
  const [open, setOpen] = useState(false);
  const [here, setHere] = useState<CheatSheetAreaId | null>(null);
  const [query, setQuery] = useState("");
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const focusLevels = useClientSettings(selectFocusLevels);
  const updateSettings = useUpdateClientSettings();
  const navigate = useNavigate();

  useEffect(
    () =>
      registerFocusLevelCommands({
        "keyboard.cheatSheet": (event) => {
          if (event.repeat) return true;
          const level = focusLevelOf(event.target);
          setHere(level ? AREA_OF_LEVEL[level] : null);
          setQuery("");
          setOpen((current) => !current);
          return true;
        },
      }),
    [],
  );

  if (!open) return null;
  const areas = filterCheatSheet(
    buildCheatSheet({ keybindings, platform: navigator.platform, isDesktop: isElectron, here }),
    query,
  );

  return (
    <Dialog open onOpenChange={setOpen}>
      <DialogPopup className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Keys for the area you were in come first. Your own keys come before the defaults.
          </DialogDescription>
          <Input
            size="sm"
            autoFocus
            placeholder="Search actions or keys"
            aria-label="Search shortcuts"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </DialogHeader>
        <DialogPanel>
          {focusLevels ? null : (
            <div className="flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2 text-sm">
              <span className="text-muted-foreground">
                Keyboard focus levels are off, so Move focus, Timeline and the sidebar arrow keys do
                nothing.
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void updateSettings({ keyboardFocusLevels: true })}
              >
                Turn on
              </Button>
            </div>
          )}
          {areas.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No shortcut matches “{query}”.
            </p>
          ) : (
            <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
              {areas.map((area) => (
                <section
                  key={area.id}
                  className={area.needsFocusLevels && !focusLevels ? "opacity-50" : undefined}
                >
                  <h3 className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase">
                    {area.title}
                    {area.id === here ? (
                      <Badge size="sm" variant="info">
                        Here
                      </Badge>
                    ) : null}
                  </h3>
                  <ul className="divide-y divide-border/60">
                    {area.rows.map((row) => (
                      <li
                        key={row.command}
                        className="flex items-center justify-between gap-3 py-1.5 text-sm"
                      >
                        <span className="min-w-0 truncate">{row.label}</span>
                        <span className="flex shrink-0 items-center gap-1">
                          {row.keys.map((key) => (
                            <Kbd key={key}>{key}</Kbd>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setOpen(false);
              void navigate({ to: "/settings/keybindings" });
            }}
          >
            Change keys
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

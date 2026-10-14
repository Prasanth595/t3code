import { useAtomValue } from "@effect/atom-react";
import { switchedOffSavedEnvironments } from "@t3tools/client-runtime/state/connections";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { environmentCatalog } from "../connection/catalog";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { useAtomCommand } from "../state/use-atom-command";
import { toastManager } from "./ui/toast";

const storageKey = "t3code:switched-off-environments-review:v1";
// Keep an active toast across remounts, including Strict Mode effect replay.
let shown = false;

function reviewed(): boolean {
  try {
    return getLocalStorageItem(storageKey, Schema.Boolean) === true;
  } catch {
    // An unavailable store must not prevent the notice.
    return false;
  }
}

function markReviewed() {
  try {
    setLocalStorageItem(storageKey, true, Schema.Boolean);
  } catch {
    // The in-memory marker still prevents repeats during this launch.
  }
}

/**
 * Asks once whether to switch saved computers back on. Older builds switched
 * computers off on their own when a host ran an incompatible version, and the
 * app cannot tell those apart from ones the user switched off.
 */
export function SwitchedOffEnvironmentsNotice() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const setEnabled = useAtomCommand(environmentCatalog.setEnabled);
  useEffect(() => {
    if (!catalog.isReady || shown || reviewed()) return;
    shown = true;
    const switchedOff = switchedOffSavedEnvironments(catalog);
    // Nothing to ask about now, so a computer switched off later is never asked about.
    if (switchedOff.length === 0) {
      markReviewed();
      return;
    }
    const keepOff = () => {
      markReviewed();
      toastManager.close(id);
    };
    const turnOn = () => {
      keepOff();
      for (const { environmentId } of switchedOff) {
        void setEnabled({ environmentId, enabled: true });
      }
    };
    const names = switchedOff.map(({ label }) => label).join(", ");
    const id = toastManager.add({
      title:
        switchedOff.length === 1
          ? `${names} is switched off`
          : `${switchedOff.length} computers are switched off`,
      description: `${switchedOff.length === 1 ? "" : `${names}. `}An earlier update could switch computers off by mistake. Turn ${switchedOff.length === 1 ? "it" : "them"} back on to see ${switchedOff.length === 1 ? "its" : "their"} threads again.`,
      timeout: 0,
      onClose: markReviewed,
      actionProps: { children: "Turn on", onClick: turnOn },
      data: {
        actionLayout: "stacked-end",
        secondaryActionProps: { children: "Keep off", onClick: keepOff },
        secondaryActionVariant: "ghost",
      },
    });
  }, [catalog, setEnabled]);
  return null;
}

import { useAtomValue } from "@effect/atom-react";
import {
  createSwitchedOffEnvironmentsReview,
  summarizeEnvironmentLabels,
} from "@t3tools/client-runtime/state/connections";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { environmentCatalog } from "../connection/catalog";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { useAtomCommand } from "../state/use-atom-command";
import { stackedThreadToast, toastManager } from "./ui/toast";

const storageKey = "t3code:switched-off-environments-review:v1";
const reviewSwitchedOff = createSwitchedOffEnvironmentsReview({
  read: () => getLocalStorageItem(storageKey, Schema.Boolean) === true,
  write: () => setLocalStorageItem(storageKey, true, Schema.Boolean),
});

export function SwitchedOffEnvironmentsNotice() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const setEnabled = useAtomCommand(environmentCatalog.setEnabled);
  useEffect(() => {
    void reviewSwitchedOff(catalog, setEnabled).then((review) => {
      if (review === null) return;
      const turnOn = async () => {
        // Claim the answer before closing: onClose also runs for action clicks.
        const result = review.turnOn();
        toastManager.close(id);
        const failed = await result;
        if (failed.length === 0) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not switch on ${summarizeEnvironmentLabels(failed)}`,
            description: `Switch ${failed.length === 1 ? "it" : "them"} on in Settings → Connections.`,
          }),
        );
      };
      const id = toastManager.add({
        title: review.title,
        description: review.description,
        timeout: 0,
        onClose: review.keepOff,
        actionProps: { children: "Turn on", onClick: () => void turnOn() },
        data: {
          actionLayout: "stacked-end",
          secondaryActionProps: {
            children: "Keep off",
            onClick: () => {
              review.keepOff();
              toastManager.close(id);
            },
          },
          secondaryActionVariant: "ghost",
        },
      });
    });
  }, [catalog, setEnabled]);
  return null;
}

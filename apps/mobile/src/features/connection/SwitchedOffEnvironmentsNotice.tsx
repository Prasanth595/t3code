import { useAtomValue } from "@effect/atom-react";
import {
  createSwitchedOffEnvironmentsReview,
  summarizeEnvironmentLabels,
} from "@t3tools/client-runtime/state/connections";
import * as SecureStore from "expo-secure-store";
import { useEffect } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { environmentCatalog } from "../../connection/catalog";
import { useAtomCommand } from "../../state/use-atom-command";

const storageKey = "t3code.switched-off-environments-review.v1";
const reviewSwitchedOff = createSwitchedOffEnvironmentsReview({
  read: async () => (await SecureStore.getItemAsync(storageKey)) === "1",
  write: () => SecureStore.setItemAsync(storageKey, "1"),
});

export function SwitchedOffEnvironmentsNotice() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const setEnabled = useAtomCommand(environmentCatalog.setEnabled, "environment enable");
  useEffect(() => {
    void reviewSwitchedOff(catalog, setEnabled).then((review) => {
      if (review === null) return;
      Dialog.alert(
        review.title,
        review.description,
        [
          { text: "Keep off", style: "cancel", onPress: review.keepOff },
          {
            text: "Turn on",
            onPress: async () => {
              const failed = await review.turnOn();
              if (failed.length === 0) return;
              Dialog.alert(
                `Could not switch on ${summarizeEnvironmentLabels(failed)}`,
                `Switch ${failed.length === 1 ? "it" : "them"} on in Settings → Environments.`,
              );
            },
          },
        ],
        { cancelable: false },
      );
    });
  }, [catalog, setEnabled]);
  return null;
}

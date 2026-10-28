import { useState } from "react";

import { MIRA_UPGRADE_PLAN_ID, openMiraCheckout } from "~/cloud/miraAccount";
import { useMiraAccess } from "~/cloud/miraChat";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";

/** Shown when a plan without agentic mode reaches for it. */
export function AgenticUpgradeDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const access = useMiraAccess();
  const [busy, setBusy] = useState(false);
  const upgrade = () => {
    setBusy(true);
    openMiraCheckout(MIRA_UPGRADE_PLAN_ID)
      .then(() => onOpenChange(false))
      .catch((cause: unknown) =>
        toastManager.add({
          type: "error",
          title: "Upgrade-ul nu a putut porni",
          description: cause instanceof Error ? cause.message : String(cause),
        }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Modul agent e disponibil cu Pro</DialogTitle>
          <DialogDescription>
            {access.signedIn
              ? "Cu Pro, Mira lucrează pe calculatorul tău: citește și editează fișiere, rulează comenzi și duce sarcinile la capăt pentru tine. Chat-ul rămâne nelimitat pe orice plan."
              : "Creează mai întâi un cont gratuit. Apoi treci la Pro ca Mira să lucreze pe calculatorul tău."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Nu acum
          </Button>
          {access.signedIn ? (
            <Button disabled={busy || access.account === null} onClick={upgrade}>
              Treci la Pro
            </Button>
          ) : access.openSignIn !== null ? (
            <Button
              onClick={() => {
                onOpenChange(false);
                access.openSignIn?.();
              }}
            >
              Creează cont gratuit
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

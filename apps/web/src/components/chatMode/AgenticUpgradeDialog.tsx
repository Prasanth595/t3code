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
          title: "Could not start the upgrade",
          description: cause instanceof Error ? cause.message : String(cause),
        }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Agentic mode is available with Pro</DialogTitle>
          <DialogDescription>
            {access.signedIn
              ? "With Pro, Mira works on your computer: it reads and edits files, runs commands, and finishes tasks for you. Chat stays unlimited on every plan."
              : "Create a free account first. Then upgrade to Pro to let Mira work on your computer."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Not now
          </Button>
          {access.signedIn ? (
            <Button disabled={busy || access.account === null} onClick={upgrade}>
              Upgrade to Pro
            </Button>
          ) : access.openSignIn !== null ? (
            <Button
              onClick={() => {
                onOpenChange(false);
                access.openSignIn?.();
              }}
            >
              Create free account
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

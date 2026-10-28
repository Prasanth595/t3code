import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button, InlineButton } from "../ui/button";
import { useT3ConnectAccountPage } from "./T3ConnectAccountPages";

export function RemoveT3ConnectEnvironmentDialog({
  environmentLabel,
  onCancel,
  onConfirm,
}: {
  readonly environmentLabel: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const accountPage = useT3ConnectAccountPage();
  const [shownLabel, setShownLabel] = useState(environmentLabel);
  if (environmentLabel !== null && environmentLabel !== shownLabel) setShownLabel(environmentLabel);
  const openAccountPage = accountPage.open;

  return (
    <>
      <AlertDialog
        open={environmentLabel !== null}
        onOpenChange={(open) => {
          if (!open) onCancel();
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Elimini {shownLabel} de pe acest dispozitiv?</AlertDialogTitle>
            <AlertDialogDescription>
              Se uită asocierea, credențialele și conversațiile salvate aici.
            </AlertDialogDescription>
            <AlertDialogDescription>
              Rămâne în contul tău Mira și își păstrează locul de gazdă. Elimină-l din{" "}
              {openAccountPage ? (
                <InlineButton
                  onClick={() => {
                    onCancel();
                    openAccountPage();
                  }}
                >
                  setările T3 Connect
                </InlineButton>
              ) : (
                "setările T3 Connect"
              )}{" "}
              ca să-l eliberezi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Anulează</AlertDialogClose>
            <Button variant="destructive" onClick={onConfirm}>
              Elimină de pe acest dispozitiv
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {accountPage.portals}
    </>
  );
}

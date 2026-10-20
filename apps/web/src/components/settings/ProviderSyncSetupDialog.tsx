import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

export function ProviderSyncSetupDialog({
  open,
  onOpenChange,
  targetLabel,
  sourceLabel,
  providerSummary,
  onConfirm,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly targetLabel: string;
  readonly sourceLabel: string;
  readonly providerSummary: string;
  readonly onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Set up {targetLabel} like {sourceLabel}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {targetLabel} just joined. Bring over provider setups so it works the same. Accounts and
            API keys stay on each device — sign in again where needed. Your threads are kept.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="grid gap-3 px-6 text-sm">
          <SetupItem title="Providers" description={providerSummary} />
          <SetupItem
            title="Settings"
            description="Enabled state, display names, and non-secret runtime options"
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Not now</AlertDialogClose>
          <Button onClick={onConfirm}>Set up like {sourceLabel}</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function SetupItem({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2.5 ring-1 ring-border/50">
      <div className="font-medium text-foreground">{title}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
    </div>
  );
}

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import type { ProviderSyncRemovalScope } from "@t3tools/contracts";
import { useState } from "react";

import { joinDeviceLabels } from "@t3tools/client-runtime/state/provider-sync";
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
import { RadioGroup } from "../ui/radio-group";
import { cn } from "../../lib/utils";

export function RemoveProviderSyncDialog({
  open,
  onOpenChange,
  providerLabel,
  currentDeviceLabel,
  syncedDeviceLabels,
  onConfirm,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly providerLabel: string;
  readonly currentDeviceLabel: string;
  readonly syncedDeviceLabels: ReadonlyArray<string>;
  readonly onConfirm: (scope: ProviderSyncRemovalScope) => void;
}) {
  const [scope, setScope] = useState<ProviderSyncRemovalScope>("all-devices");
  const deviceCount = syncedDeviceLabels.length;
  const allDevicesLabel = joinDeviceLabels(syncedDeviceLabels);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next) setScope("all-devices");
        onOpenChange(next);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {providerLabel}?</AlertDialogTitle>
          <AlertDialogDescription>
            {deviceCount > 1
              ? `It's synced to ${deviceCount} devices. Your threads are kept.`
              : "Your threads are kept."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="grid gap-2 px-6">
          <RadioGroup
            value={scope}
            onValueChange={(value) => setScope(value as ProviderSyncRemovalScope)}
            aria-label="Removal scope"
          >
            <RemovalScopeOption
              value="all-devices"
              title="From all devices"
              description={allDevicesLabel || currentDeviceLabel}
            />
            <RemovalScopeOption
              value="this-device"
              title="From this device only"
              description={`${currentDeviceLabel}. Other devices keep it.`}
            />
          </RadioGroup>
        </div>

        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            variant="destructive"
            onClick={() => {
              onOpenChange(false);
              onConfirm(scope);
            }}
          >
            {scope === "all-devices" ? "Remove from all devices" : "Remove from this device"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function RemovalScopeOption({
  value,
  title,
  description,
}: {
  readonly value: ProviderSyncRemovalScope;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <RadioPrimitive.Root
      value={value}
      className={cn(
        "relative flex cursor-pointer items-start gap-3 rounded-lg bg-card px-3 py-3 text-left outline-none ring-1 ring-black/5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-checked:bg-primary/8 data-checked:ring-2 data-checked:ring-inset data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
      </div>
      <RadioPrimitive.Indicator
        className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground data-unchecked:hidden"
        aria-hidden
      >
        <span className="size-1.5 rounded-full bg-primary-foreground" />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  );
}

import {
  validateEnvironmentNickname,
  withEnvironmentNickname,
} from "@t3tools/client-runtime/state/environment-label";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { persistClientSettingsUpdate } from "../../hooks/useSettings";
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
import { stackedThreadToast, toastManager } from "../ui/toast";

export interface EnvironmentNicknameTarget {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly nickname: string | null;
}

/**
 * Saves, or clears with null, this device's nickname for one environment.
 * Saving the server's own name clears the nickname, so the label follows the
 * server again if its hostname changes.
 */
function saveEnvironmentNickname(target: EnvironmentNicknameTarget, nickname: string | null) {
  const next = nickname === target.serverLabel ? null : nickname;
  return persistClientSettingsUpdate((current) => ({
    ...current,
    environmentNicknames: withEnvironmentNickname(
      current.environmentNicknames,
      target.environmentId,
      next,
    ),
  })).catch((error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not rename environment",
        description: error instanceof Error ? error.message : "The name was not saved.",
      }),
    );
  });
}

/** "Rename…" from an environment's row menu. The name is kept on this device only. */
export function EnvironmentNicknameDialog({
  target,
  onClose,
}: {
  readonly target: EnvironmentNicknameTarget | null;
  readonly onClose: () => void;
}) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        {target ? (
          <EnvironmentNicknameForm key={target.environmentId} target={target} onClose={onClose} />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function EnvironmentNicknameForm({
  target,
  onClose,
}: {
  readonly target: EnvironmentNicknameTarget;
  readonly onClose: () => void;
}) {
  const [value, setValue] = useState(target.nickname ?? target.serverLabel);
  const validation = validateEnvironmentNickname(value);
  const submit = () => {
    if (!validation.ok) return;
    void saveEnvironmentNickname(target, validation.nickname);
    onClose();
  };
  const reset = () => {
    void saveEnvironmentNickname(target, null);
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Rename environment</DialogTitle>
        <DialogDescription>
          The name is saved on this device only. The server and your other devices keep calling it{" "}
          {target.serverLabel}.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">Name</span>
          <Input
            aria-label="Environment name"
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
          />
          {!validation.ok ? <p className="text-xs text-destructive">{validation.reason}</p> : null}
        </div>
      </DialogPanel>
      <DialogFooter>
        {target.nickname !== null ? (
          <Button variant="ghost" onClick={reset}>
            Reset to {target.serverLabel}
          </Button>
        ) : null}
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!validation.ok} onClick={submit}>
          Save
        </Button>
      </DialogFooter>
    </>
  );
}

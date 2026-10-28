import type {
  DeviceServiceState,
  EnvironmentId,
  MessageId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useRightPanelStore } from "~/rightPanelStore";
import { DeviceSetup } from "../device/DeviceSetup";
import { PullRequestThreadDialog } from "../PullRequestThreadDialog";
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
import { Dialog } from "../ui/dialog";
import { WizardPopup } from "../ui/wizard";

// Atoms isolate overlay renders. Thread keys prevent overlays following thread switches.
type ThreadOverlayAtom<T> = Atom.Writable<{ readonly threadKey: string; readonly value: T } | null>;

function makeThreadOverlayAtom<T>(label: string): ThreadOverlayAtom<T> {
  return Atom.make<{ readonly threadKey: string; readonly value: T } | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`chat:${label}`),
  );
}

function closeThreadOverlay<T>(atom: ThreadOverlayAtom<T>): void {
  appAtomRegistry.set(atom, null);
}

function useThreadOverlay<T>(atom: ThreadOverlayAtom<T>, threadKey: string | null): T | null {
  const entry = useAtomValue(atom);
  useEffect(
    () => () => {
      if (appAtomRegistry.get(atom)?.threadKey === threadKey) closeThreadOverlay(atom);
    },
    [atom, threadKey],
  );
  return threadKey !== null && entry?.threadKey === threadKey ? entry.value : null;
}

const pullRequestThreadDialogAtom = makeThreadOverlayAtom<{
  readonly initialReference: string | null;
  readonly key: number;
}>("pull-request-thread-dialog");

export function openPullRequestThreadDialog(threadKey: string, reference?: string): void {
  appAtomRegistry.set(pullRequestThreadDialogAtom, {
    threadKey,
    value: { initialReference: reference ?? null, key: Date.now() },
  });
}

export function PullRequestThreadDialogHost(props: {
  readonly threadKey: string | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string | null;
  readonly onPrepared: (input: {
    branch: string;
    worktreePath: string | null;
  }) => Promise<void> | void;
}) {
  const state = useThreadOverlay(pullRequestThreadDialogAtom, props.threadKey);
  if (state === null) return null;
  return (
    <PullRequestThreadDialog
      key={state.key}
      open
      environmentId={props.environmentId}
      threadId={props.threadId}
      cwd={props.cwd}
      initialReference={state.initialReference}
      onOpenChange={(open) => {
        if (!open) closeThreadOverlay(pullRequestThreadDialogAtom);
      }}
      onPrepared={props.onPrepared}
    />
  );
}

const deviceSetupDialogAtom = makeThreadOverlayAtom<true>("device-setup-dialog");

export function openDeviceSetupDialog(threadKey: string): void {
  appAtomRegistry.set(deviceSetupDialogAtom, { threadKey, value: true });
}

export function DeviceSetupDialogHost(props: {
  readonly threadKey: string | null;
  readonly threadRef: ScopedThreadRef | null;
  readonly state: DeviceServiceState;
}) {
  const open = useThreadOverlay(deviceSetupDialogAtom, props.threadKey) !== null;
  const { threadRef } = props;
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeThreadOverlay(deviceSetupDialogAtom);
      }}
    >
      <WizardPopup>
        {threadRef ? (
          <DeviceSetup
            environmentId={threadRef.environmentId}
            state={props.state}
            onComplete={() => {
              useRightPanelStore.getState().open(threadRef, "device");
              closeThreadOverlay(deviceSetupDialogAtom);
            }}
          />
        ) : null}
      </WizardPopup>
    </Dialog>
  );
}

const branchRestoreConfirmAtom = makeThreadOverlayAtom<true>("branch-restore-confirm");

export function openBranchRestoreConfirm(threadKey: string): void {
  appAtomRegistry.set(branchRestoreConfirmAtom, { threadKey, value: true });
}

export function BranchRestoreConfirmHost(props: {
  readonly threadKey: string | null;
  readonly threadBranch: string;
  readonly canWriteSourceControl: boolean;
  readonly onConfirm: () => void;
}) {
  const open = useThreadOverlay(branchRestoreConfirmAtom, props.threadKey) !== null;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeThreadOverlay(branchRestoreConfirmAtom);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Treci pe <code className="font-medium">{props.threadBranch}</code>?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Ai modificări necomise. Vor fi mutate pe celălalt branch sau vor bloca schimbarea dacă
            intră în conflict.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Anulează</AlertDialogClose>
          <Button
            variant="default"
            disabled={!props.canWriteSourceControl}
            onClick={() => {
              closeThreadOverlay(branchRestoreConfirmAtom);
              props.onConfirm();
            }}
          >
            Schimbă branch-ul
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

interface PendingRevert {
  readonly turnCount: number;
  readonly messageId: MessageId;
}

const revertConfirmAtom = makeThreadOverlayAtom<PendingRevert>("revert-confirm");

export function openRevertConfirm(threadKey: string, pending: PendingRevert): void {
  appAtomRegistry.set(revertConfirmAtom, { threadKey, value: pending });
}

export function RevertConfirmHost(props: {
  readonly threadKey: string;
  readonly onConfirm: (turnCount: number, messageId: MessageId, restoreFiles: boolean) => void;
}) {
  const pending = useThreadOverlay(revertConfirmAtom, props.threadKey);
  const confirm = (restoreFiles: boolean) => {
    if (pending === null) return;
    closeThreadOverlay(revertConfirmAtom);
    props.onConfirm(pending.turnCount, pending.messageId, restoreFiles);
  };
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) closeThreadOverlay(revertConfirmAtom);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Editezi de aici?</AlertDialogTitle>
          <AlertDialogDescription>
            Întoarce conversația la dinainte de acest mesaj. Promptul și atașamentele revin în
            editor. „Anulează și fișierele” anulează și editările tale.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Anulează</AlertDialogClose>
          <Button variant="destructive-outline" onClick={() => confirm(true)}>
            Anulează și fișierele
          </Button>
          <Button onClick={() => confirm(false)}>Revino și păstrează modificările</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

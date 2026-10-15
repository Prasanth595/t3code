import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { environmentThreadShells } from "../../state/threads";
import { resolveDesktopUpdateButtonAction } from "../desktopUpdate.logic";
import { countRunningAgentTurns } from "../desktopUpdateIdleInstall.logic";
import { installLocalUpdate } from "../sidebar/SidebarUpdatePill";
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
import { stackedThreadToast, toastManager } from "../ui/toast";

interface IdleInstallState {
  readonly promptOpen: boolean;
  /** Install as soon as no agent runs. Client only: a window reload drops it. */
  readonly armed: boolean;
}

const idleInstallAtom = Atom.make<IdleInstallState>({ promptOpen: false, armed: false }).pipe(
  Atom.keepAlive,
  Atom.withLabel("desktop:update-idle-install"),
);

// An update restarts the server of the primary environment, so only its agents count.
const runningAgentCountAtom = Atom.make((get) =>
  countRunningAgentTurns(
    get(environmentThreadShells.threadShellsAtom),
    get(primaryEnvironmentIdAtom),
  ),
).pipe(Atom.withLabel("desktop:update-running-agent-count"));

function setIdleInstallState(next: Partial<IdleInstallState>): void {
  appAtomRegistry.update(idleInstallAtom, (current) => ({ ...current, ...next }));
}

export function useIdleInstallArmed(): boolean {
  return useAtomValue(idleInstallAtom).armed;
}

/**
 * Call before an update install starts. While agents run, it opens the
 * "Install when idle" prompt and returns true; the caller then stops.
 */
export function openIdleInstallPromptIfAgentsRun(): boolean {
  if (appAtomRegistry.get(runningAgentCountAtom) === 0) return false;
  setIdleInstallState({ promptOpen: true });
  return true;
}

/** Fork machine map (MM-1402): install as soon as no agent runs, without the prompt. */
export function armIdleInstall(): void {
  setIdleInstallState({ armed: true });
}

/** Desktop only. Hosts the prompt and runs an armed install when the agents finish. */
export function DesktopUpdateIdleInstall() {
  const { promptOpen, armed } = useAtomValue(idleInstallAtom);
  return (
    <>
      {armed ? <ArmedInstallWatcher /> : null}
      <AlertDialog
        open={promptOpen}
        onOpenChange={(open) => {
          if (!open) setIdleInstallState({ promptOpen: false });
        }}
      >
        <AlertDialogPopup>
          <IdleInstallPromptContent armed={armed} />
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function ArmedInstallWatcher() {
  const count = useAtomValue(runningAgentCountAtom);
  const state = useDesktopUpdateState();

  useEffect(() => {
    // The registry check keeps a repeated effect run from installing twice.
    if (count > 0 || !appAtomRegistry.get(idleInstallAtom).armed) return;
    setIdleInstallState({ promptOpen: false, armed: false });
    const bridge = window.desktopBridge;
    if (!bridge || !state || resolveDesktopUpdateButtonAction(state) !== "install") {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Update not installed",
          description: "The agents finished, but the update is no longer ready to install.",
        }),
      );
      return;
    }
    void installLocalUpdate(bridge);
  }, [count, state]);

  return null;
}

function IdleInstallPromptContent({ armed }: { readonly armed: boolean }) {
  const count = useAtomValue(runningAgentCountAtom);

  const installNow = () => {
    setIdleInstallState({ promptOpen: false, armed: false });
    const bridge = window.desktopBridge;
    if (bridge) void installLocalUpdate(bridge);
  };

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>
          {count} {count === 1 ? "agent" : "agents"} running
        </AlertDialogTitle>
        <AlertDialogDescription>
          {armed
            ? "The update installs when they finish."
            : "Installing the update restarts the server and interrupts them."}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogClose render={<Button variant="outline" />}>
          {armed ? "Keep waiting" : "Cancel"}
        </AlertDialogClose>
        {armed ? (
          <Button
            variant="outline"
            onClick={() => setIdleInstallState({ promptOpen: false, armed: false })}
          >
            Stop waiting
          </Button>
        ) : null}
        <Button variant="destructive-outline" onClick={installNow}>
          Install now
        </Button>
        {armed ? null : (
          <Button onClick={() => setIdleInstallState({ promptOpen: false, armed: true })}>
            Install when idle
          </Button>
        )}
      </AlertDialogFooter>
    </>
  );
}

import { useAtomValue } from "@effect/atom-react";
import type { DesktopBridge } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useRef } from "react";

import { getClientSettings } from "../../hooks/useSettings";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  getDesktopUpdateActionError,
  resolveDesktopUpdateButtonAction,
} from "../desktopUpdate.logic";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

type NewerUpdateChoice = "newer" | "downloaded" | "cancel";

interface NewerUpdatePrompt {
  readonly downloadedVersion: string | null;
  readonly newerVersion: string;
  readonly answer: (choice: NewerUpdateChoice) => void;
}

const newerUpdatePromptAtom = Atom.make<NewerUpdatePrompt | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("desktop:update-newer-prompt"),
);

function askNewerUpdate(
  downloadedVersion: string | null,
  newerVersion: string,
): Promise<NewerUpdateChoice> {
  // A second install click replaces an open prompt, so the first install stops.
  appAtomRegistry.get(newerUpdatePromptAtom)?.answer("cancel");
  return new Promise((resolve) => {
    appAtomRegistry.set(newerUpdatePromptAtom, {
      downloadedVersion,
      newerVersion,
      answer: (choice) => {
        appAtomRegistry.set(newerUpdatePromptAtom, null);
        resolve(choice);
      },
    });
  });
}

type ReportUpdateError = (title: string, description: string) => void;

const toastUpdateError: ReportUpdateError = (title, description) => {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
};

/**
 * Fork setting `checkNewerBeforeUpdateInstall`. Call right before `bridge.installUpdate()`. It
 * checks for a release newer than the downloaded one. A person chooses in a dialog; an
 * unattended install takes the newer release. When the newer release is ready, or the user keeps
 * the download, it returns true and the caller installs. Otherwise it returns false.
 */
export async function prepareNewestUpdateInstall(
  bridge: DesktopBridge,
  {
    unattended = false,
    reportError = toastUpdateError,
  }: { readonly unattended?: boolean; readonly reportError?: ReportUpdateError } = {},
): Promise<boolean> {
  if (!getClientSettings().checkNewerBeforeUpdateInstall) return true;
  try {
    const { downloadedVersion } = await bridge.getUpdateState();
    const { newerVersion } = await bridge.checkBeforeUpdateInstall();
    if (newerVersion === null) return true;

    const choice = unattended ? "newer" : await askNewerUpdate(downloadedVersion, newerVersion);
    if (choice !== "newer") return choice === "downloaded";

    // The check before the install kept the download in the state. This check switches the
    // state to the newest release, so the download below gets that one.
    const checked = await bridge.checkForUpdate();
    if (resolveDesktopUpdateButtonAction(checked.state) !== "download") return true;
    const download = await bridge.downloadUpdate();
    if (download.completed) return true;
    reportError(
      "Could not download the newer update",
      getDesktopUpdateActionError(download) ?? "The download did not finish.",
    );
    return false;
  } catch (error) {
    reportError(
      "Could not check for a newer update",
      error instanceof Error ? error.message : "An unexpected error occurred.",
    );
    return false;
  }
}

/** Desktop only. Hosts the prompt of `prepareNewestUpdateInstall`. */
export function DesktopUpdateNewerDialog() {
  const prompt = useAtomValue(newerUpdatePromptAtom);
  const downloadNewerRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open) prompt?.answer("cancel");
      }}
    >
      <AlertDialogPopup initialFocus={downloadNewerRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>Newer update available</AlertDialogTitle>
          <AlertDialogDescription>
            A newer update is available since this one was downloaded. Download it instead?
          </AlertDialogDescription>
          {prompt ? (
            <AlertDialogDescription>
              Downloaded: {prompt.downloadedVersion ?? "unknown"}
              <br />
              Newer: {prompt.newerVersion}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => prompt?.answer("downloaded")}>
            Install this one
          </Button>
          <Button ref={downloadNewerRef} onClick={() => prompt?.answer("newer")}>
            Download newer
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

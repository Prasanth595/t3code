/**
 * Fork parts of the sidebar update button (`SidebarUpdatePill.tsx`): the fork changelog in the
 * update popover, the idle install prompt and the newer-update check before install.
 */
import type { ClientSettings, DesktopUpdateState } from "@t3tools/contracts";
import { useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { ForkChangelogDialog } from "../forkChangelog/ForkChangelogDialog";
import { ForkUpdateChanges } from "../forkChangelog/ForkUpdateChanges";
import { Button } from "../ui/button";

export {
  openIdleInstallPromptIfAgentsRun,
  useIdleInstallArmed,
} from "../desktop/DesktopUpdateIdleInstall";
export { prepareNewestUpdateInstall } from "../desktop/DesktopUpdateNewerCheck";

const selectForkChangelogEnabled = (settings: ClientSettings) => settings.forkChangelogEnabled;

/** With the changelog on, the popover opens even when no update is available. */
export function useForkChangelog() {
  const enabled = useClientSettings(selectForkChangelogEnabled);
  const [open, setOpen] = useState(false);
  return { enabled, open, setOpen };
}
type ForkChangelog = ReturnType<typeof useForkChangelog>;

/** The popover body while the fork changelog is on: the release changes and "Open changelog". */
export function ForkUpdatePopoverChanges(props: {
  readonly changelog: ForkChangelog;
  readonly popover: { readonly close: () => void };
  readonly state: DesktopUpdateState;
  readonly tooltip: string;
}) {
  return (
    <>
      <ForkUpdateChanges state={props.state} tooltip={props.tooltip} />
      <div className="mt-2 px-1">
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            props.popover.close();
            props.changelog.setOpen(true);
          }}
        >
          Open changelog
        </Button>
      </div>
    </>
  );
}

export function ForkChangelogDialogHost({ changelog }: { readonly changelog: ForkChangelog }) {
  return changelog.enabled ? (
    <ForkChangelogDialog open={changelog.open} onOpenChange={changelog.setOpen} />
  ) : null;
}

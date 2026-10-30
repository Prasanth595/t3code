import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useProjectScans } from "../../onboarding/useProjectScans";
import { ProjectImportStep } from "../onboarding/ProjectImportStep";
import { Dialog, DialogTitle } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { WizardPanel, WizardPopup } from "../ui/wizard";

export function ImportProjectsDialog({
  environmentIds,
  onClose,
}: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly onClose: () => void;
}) {
  // Freeze the targets so a reconnect elsewhere does not rescan mid-selection.
  const [scanIds] = useState(environmentIds);
  const scans = useProjectScans(scanIds);
  const [initialScans] = useState(scans);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a cached scan can be up to 30s old on reopen, so rescan once to pick up new conversations; scans already in flight are left alone
  useEffect(() => {
    for (const scan of initialScans) {
      if (scan.data !== null && !scan.isPending) scan.refresh();
    }
  }, [initialScans]);
  const [isImporting, setIsImporting] = useState(false);
  const isLoadingProjects =
    scans.every((scan) => scan.data === null) && scans.some((scan) => scan.isPending);

  const finish = async (_projectRef?: unknown, importWarning?: string, importedThreadCount = 0) => {
    onClose();
    if (importWarning) {
      toastManager.add({
        type: "warning",
        title: "Some history was not imported",
        description: importWarning,
        timeout: 0,
      });
    } else if (importedThreadCount > 0) {
      toastManager.add({
        type: "success",
        title: `Imported ${importedThreadCount} ${importedThreadCount === 1 ? "thread" : "threads"}`,
      });
    }
    return true;
  };

  return (
    <Dialog
      open
      disablePointerDismissal={isImporting}
      onOpenChange={(open) => {
        if (!open && !isImporting) onClose();
      }}
    >
      <WizardPopup size="wide" bottomStickOnMobile={false}>
        <DialogTitle className="sr-only">Import projects</DialogTitle>
        <WizardPanel holdHeight={isLoadingProjects}>
          <ProjectImportStep
            scans={scans}
            isImporting={isImporting}
            setIsImporting={setIsImporting}
            skipLabel="Cancel"
            onDone={finish}
          />
        </WizardPanel>
      </WizardPopup>
    </Dialog>
  );
}

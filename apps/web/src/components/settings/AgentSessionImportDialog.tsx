import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { useProjectScans } from "../../onboarding/useProjectScans";
import { ImportStep, showProjectImportResult } from "../onboarding/ProjectImportStep";
import { Dialog } from "../ui/dialog";
import { WizardPanel, WizardPopup } from "../ui/wizard";

export function AgentSessionImportDialog({
  open,
  onOpenChange,
  environmentIds,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentIds: readonly EnvironmentId[];
}) {
  const [isImporting, setIsImporting] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && isImporting) return;
        onOpenChange(next);
      }}
    >
      <WizardPopup size="wide" aria-label="Import projects" bottomStickOnMobile={false}>
        <AgentSessionImportPanel
          environmentIds={environmentIds}
          isImporting={isImporting}
          setIsImporting={setIsImporting}
          onDone={(importWarning, importedThreadCount) => {
            setIsImporting(false);
            onOpenChange(false);
            showProjectImportResult(importWarning, importedThreadCount);
          }}
        />
      </WizardPopup>
    </Dialog>
  );
}

// Mounted only while the popup is open, so Settings never scans agent history on its own.
function AgentSessionImportPanel({
  environmentIds,
  isImporting,
  setIsImporting,
  onDone,
}: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly isImporting: boolean;
  readonly setIsImporting: (value: boolean) => void;
  readonly onDone: (importWarning?: string, importedThreadCount?: number) => void;
}) {
  const scans = useProjectScans(environmentIds);
  // A scan kept from an earlier open would hide sessions started since then.
  const refreshCachedScans = useEffectEvent(() => {
    for (const scan of scans) {
      if (scan.data !== null) scan.refresh();
    }
  });
  useEffect(() => {
    refreshCachedScans();
  }, []);
  const isLoadingProjects =
    scans.every((scan) => scan.data === null) && scans.some((scan) => scan.isPending);
  return (
    <WizardPanel holdHeight={isLoadingProjects}>
      <ImportStep
        scans={scans}
        isImporting={isImporting}
        setIsImporting={setIsImporting}
        dismissLabel="Cancel"
        onDone={async (_projectRef, importWarning, importedThreadCount) => {
          onDone(importWarning, importedThreadCount);
          return true;
        }}
      />
    </WizardPanel>
  );
}

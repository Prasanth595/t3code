import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { getLatestCompletedCheckpointTurnCount } from "@t3tools/client-runtime/state/thread-checkpoints";
import type { ChangesScope, ScopedThreadRef, VcsStatusResult } from "@t3tools/contracts";
import { FileDiffIcon } from "lucide-react";
import { useMemo } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useCheckpointDiff } from "../../lib/checkpointDiffState";
import { getDiffLineStat, getRenderablePatch } from "../../lib/diffRendering";
import { useThreadProjection } from "../../state/entities";
import { useFilesystemReadAccess } from "../../state/filesystem";
import { cn } from "../../lib/utils";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

export function ThreadChangesControl({
  threadRef,
  scope,
  status,
  onOpenChanges,
}: {
  threadRef: ScopedThreadRef | null;
  scope: ChangesScope;
  status: VcsStatusResult | null;
  onOpenChanges: (() => void) | undefined;
}) {
  const projection = useThreadProjection(scope === "thread" ? threadRef : null)?.projection ?? null;
  const hasProjection = projection !== null;
  const latestCompletedCheckpointTurnCount = useMemo(
    () =>
      getLatestCompletedCheckpointTurnCount(projection?.checkpoints ?? [], projection?.runs ?? []),
    [projection],
  );
  const ignoreWhitespace = useClientSettings((settings) => settings.diffIgnoreWhitespace);
  const { canReadFiles } = useFilesystemReadAccess(threadRef?.environmentId ?? null);
  const diff = useCheckpointDiff(
    {
      environmentId: threadRef?.environmentId ?? null,
      threadId: threadRef?.threadId ?? null,
      fromTurnCount: 0,
      toTurnCount: latestCompletedCheckpointTurnCount,
      ignoreWhitespace,
    },
    { enabled: scope === "thread" && latestCompletedCheckpointTurnCount > 0 && canReadFiles },
  );
  // Use the net checkpoint diff: summing turn totals double-counts edits and reversals.
  const threadTotals = useMemo(() => {
    if (hasProjection && latestCompletedCheckpointTurnCount === 0) {
      return { insertions: 0, deletions: 0 };
    }
    if (diff.data === null) return null;
    const patch = getRenderablePatch(diff.data.diff, "thread-changes");
    if (patch?.kind === "raw") return null;
    const totals = getDiffLineStat(patch?.files ?? []);
    return { insertions: totals.additions, deletions: totals.deletions };
  }, [diff.data, latestCompletedCheckpointTurnCount, hasProjection]);
  const totals =
    scope === "thread"
      ? threadTotals
      : scope === "uncommitted"
        ? status?.workingTree
        : (status?.branchChanges ?? status?.workingTree);
  const label =
    scope === "thread" ? "Conversation" : scope === "uncommitted" ? "Uncommitted" : "Changes";

  return (
    <ThreadDetailsControl
      type="button"
      variant="ghost"
      size="sm"
      part="row"
      disabled={!onOpenChanges}
      onClick={onOpenChanges}
      title={
        scope === "thread"
          ? (diff.error ?? "Net changes through the latest completed checkpoint")
          : scope === "uncommitted"
            ? "Staged, unstaged, and untracked changes"
            : "Changes against the base branch"
      }
    >
      <FileDiffIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
      <span className={cn("flex-1 text-left", THREAD_DETAILS_PANEL_LABEL_CLASS)}>{label}</span>
      <span
        className="flex items-center gap-1 font-mono text-2xs tabular-nums"
        aria-busy={scope === "thread" && diff.isPending}
      >
        {totals ? (
          <>
            <span className="text-success">+{formatDiffCount(totals.insertions)}</span>
            <span className="text-destructive">-{formatDiffCount(totals.deletions)}</span>
          </>
        ) : (
          <span className="text-muted-foreground">
            {diff.error || diff.data || (scope === "thread" && !canReadFiles) ? "Unavailable" : "…"}
          </span>
        )}
      </span>
    </ThreadDetailsControl>
  );
}

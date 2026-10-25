import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import { environmentSession } from "../../state/session";
import { useCallback, useEffect, useMemo } from "react";
import * as DateTime from "effect/DateTime";

import {
  deriveThreadCheckpointSummaries,
  type ThreadCheckpointSummary,
} from "@t3tools/client-runtime/state/thread-checkpoints";
import type {
  EnvironmentId,
  ReviewDiffPreviewResult,
  ReviewDiffPreviewSourceKind,
  ThreadId,
} from "@t3tools/contracts";

import { useCheckpointDiff } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentPresentation } from "../../state/presentation";
import { reviewEnvironment } from "../../state/review";
import { useSelectedThreadProjection } from "../../state/use-thread-detail";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import {
  buildReviewSectionItems,
  getDefaultReviewSectionId,
  getReadyReviewCheckpoints,
  getReviewSectionIdForCheckpoint,
} from "./reviewModel";
import {
  setReviewAsyncError,
  setReviewGitSectionsOfKind,
  setReviewSelectedSectionId,
  setReviewTurnDiff,
  setReviewTurnDiffLoading,
  type ReviewCacheForThread,
} from "./reviewState";

export function useReviewSections(input: {
  readonly enabled?: boolean;
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly reviewCache: ReviewCacheForThread;
}) {
  const { environmentId, reviewCache, threadId } = input;
  const enabled = input.enabled ?? true;
  const fileAccessSession = useEnvironmentQuery(
    environmentId === undefined ? null : environmentSession.sessionStateAtom(environmentId),
  );
  const fileEnvironment = useEnvironmentPresentation(environmentId ?? null);
  const fileAccess = resolveFilesystemReadAccess({
    isCatalogReady: fileEnvironment.isReady,
    connection: fileEnvironment.presentation?.connection ?? null,
    session: fileAccessSession.data,
    sessionError: fileAccessSession.error,
  });
  const { canReadFiles } = fileAccess;
  const selectedThread = useSelectedThreadProjection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const diffPreviewQuery = (sourceKind: ReviewDiffPreviewSourceKind) =>
    canReadFiles && enabled && environmentId !== undefined && selectedThreadCwd !== null
      ? reviewEnvironment.diffPreview({
          environmentId,
          input: { cwd: selectedThreadCwd, sourceKind },
        })
      : null;
  // Each source loads on its own so a failing branch comparison leaves Uncommitted usable.
  const workingTreePreview = useEnvironmentQuery(diffPreviewQuery("working-tree"));
  const branchPreview = useEnvironmentQuery(diffPreviewQuery("branch-range"));
  // A kind without live data keeps its cached source, so the other kind loading first
  // cannot drop it from the section list.
  const gitSections = useMemo(
    () =>
      (
        [
          ["working-tree", workingTreePreview.data],
          ["branch-range", branchPreview.data],
        ] as const
      ).flatMap(([kind, preview]) =>
        preview
          ? sourcesOfKind(preview, kind)
          : reviewCache.gitSections.filter((section) => section.kind === kind),
      ),
    [branchPreview.data, reviewCache.gitSections, workingTreePreview.data],
  );
  const { loadingTurnIds } = reviewCache.asyncState;

  useEffect(() => {
    if (reviewCache.threadKey && workingTreePreview.data) {
      setReviewGitSectionsOfKind(
        reviewCache.threadKey,
        "working-tree",
        sourcesOfKind(workingTreePreview.data, "working-tree"),
      );
    }
  }, [reviewCache.threadKey, workingTreePreview.data]);
  useEffect(() => {
    if (reviewCache.threadKey && branchPreview.data) {
      setReviewGitSectionsOfKind(
        reviewCache.threadKey,
        "branch-range",
        sourcesOfKind(branchPreview.data, "branch-range"),
      );
    }
  }, [branchPreview.data, reviewCache.threadKey]);

  const readyCheckpoints = useMemo(
    () =>
      getReadyReviewCheckpoints(
        selectedThread === null ? [] : deriveThreadCheckpointSummaries(selectedThread.projection),
      ),
    [selectedThread],
  );
  const checkpointBySectionId = useMemo(
    () =>
      Object.fromEntries(
        readyCheckpoints.map((checkpoint) => [
          getReviewSectionIdForCheckpoint(checkpoint),
          checkpoint,
        ]),
      ) as Record<string, ThreadCheckpointSummary>,
    [readyCheckpoints],
  );
  const workingTreeSectionState = gitSectionState(fileAccess.isPending, workingTreePreview);
  const branchSectionState = gitSectionState(fileAccess.isPending, branchPreview);
  const reviewSections = useMemo(() => {
    const sections = buildReviewSectionItems({
      checkpoints: readyCheckpoints,
      gitSections: canReadFiles || fileAccess.isPending ? gitSections : [],
      turnDiffById: reviewCache.turnDiffById,
      loadingTurnIds,
      gitSectionStates: {
        "working-tree": workingTreeSectionState,
        "branch-range": branchSectionState,
      },
    });
    // Keep the selected section while its grant loads, without displaying cached host files.
    return fileAccess.isPending
      ? sections.map((section) =>
          section.kind === "turn" ? section : { ...section, diff: null, isLoading: true },
        )
      : sections;
  }, [
    branchSectionState,
    canReadFiles,
    fileAccess.isPending,
    gitSections,
    loadingTurnIds,
    readyCheckpoints,
    reviewCache.turnDiffById,
    workingTreeSectionState,
  ]);
  const selectedSection = useMemo(
    () =>
      reviewSections.find((section) => section.id === reviewCache.selectedSectionId) ??
      reviewSections[0] ??
      null,
    [reviewCache.selectedSectionId, reviewSections],
  );
  const fallbackSectionId = useMemo(
    () => getDefaultReviewSectionId(reviewSections),
    [reviewSections],
  );
  const selectedSectionIdExists = useMemo(
    () =>
      reviewCache.selectedSectionId
        ? reviewSections.some((section) => section.id === reviewCache.selectedSectionId)
        : false,
    [reviewCache.selectedSectionId, reviewSections],
  );

  useEffect(() => {
    if (
      reviewSections.length > 0 &&
      reviewCache.threadKey &&
      (!reviewCache.selectedSectionId || !selectedSectionIdExists)
    ) {
      setReviewSelectedSectionId(reviewCache.threadKey, fallbackSectionId);
    }
  }, [
    fallbackSectionId,
    reviewCache.selectedSectionId,
    reviewCache.threadKey,
    reviewSections.length,
    selectedSectionIdExists,
  ]);

  let activeCheckpoint = readyCheckpoints[0] ?? null;
  if (selectedSection?.kind === "turn") {
    activeCheckpoint = checkpointBySectionId[selectedSection.id] ?? activeCheckpoint;
  }
  const activeSectionId = activeCheckpoint
    ? getReviewSectionIdForCheckpoint(activeCheckpoint)
    : null;
  const activeTurnDiff = useCheckpointDiff({
    environmentId: enabled ? (environmentId ?? null) : null,
    threadId: enabled ? (threadId ?? null) : null,
    fromTurnCount:
      enabled && activeCheckpoint ? Math.max(0, activeCheckpoint.checkpointTurnCount - 1) : null,
    toTurnCount: enabled ? (activeCheckpoint?.checkpointTurnCount ?? null) : null,
    ignoreWhitespace: false,
  });

  useEffect(() => {
    if (!reviewCache.threadKey || !activeSectionId) {
      return;
    }
    setReviewTurnDiffLoading(reviewCache.threadKey, activeSectionId, activeTurnDiff.isPending);
  }, [activeSectionId, activeTurnDiff.isPending, reviewCache.threadKey]);

  useEffect(() => {
    if (!reviewCache.threadKey || !activeSectionId || !activeTurnDiff.data) {
      return;
    }
    setReviewTurnDiff(reviewCache.threadKey, activeSectionId, activeTurnDiff.data.diff);
    setReviewAsyncError(reviewCache.threadKey, null);
  }, [activeSectionId, activeTurnDiff.data, reviewCache.threadKey]);

  useEffect(() => {
    if (reviewCache.threadKey && activeTurnDiff.error) {
      setReviewAsyncError(reviewCache.threadKey, activeTurnDiff.error);
    }
  }, [activeTurnDiff.error, reviewCache.threadKey]);

  const refreshSelectedSection = useCallback(async () => {
    if (!enabled) {
      return;
    }
    if (selectedSection?.kind === "turn") {
      activeTurnDiff.refresh();
      return;
    }
    (selectedSection?.kind === "working-tree" ? workingTreePreview : branchPreview).refresh();
  }, [activeTurnDiff, branchPreview, enabled, selectedSection?.kind, workingTreePreview]);

  const selectSection = useCallback(
    (sectionId: string) => {
      if (reviewCache.threadKey) {
        setReviewSelectedSectionId(reviewCache.threadKey, sectionId);
      }
    },
    [reviewCache.threadKey],
  );

  const selectedGitPreview =
    selectedSection?.kind === "working-tree"
      ? workingTreePreview
      : selectedSection?.kind === "branch-range"
        ? branchPreview
        : null;

  return {
    error:
      (selectedSection === null
        ? (workingTreePreview.error ?? branchPreview.error)
        : selectedGitPreview?.error) ??
      activeTurnDiff.error ??
      reviewCache.asyncState.error ??
      (selectedSection === null && !fileAccess.isPending && !canReadFiles
        ? (fileAccess.error ?? "This connection cannot read local diffs.")
        : null),
    isSelectedSectionPending:
      selectedSection?.kind === "turn"
        ? activeTurnDiff.isPending
        : (selectedGitPreview?.isPending ??
          (workingTreePreview.isPending || branchPreview.isPending)),
    loadingGitDiffs:
      fileAccess.isPending || workingTreePreview.isPending || branchPreview.isPending,
    diffPreviewRevision: selectedGitPreview?.data
      ? DateTime.formatIso(selectedGitPreview.data.generatedAt)
      : undefined,
    loadingTurnIds,
    reviewSections,
    selectedSection,
    refreshSelectedSection,
    selectSection,
  };
}

// Servers that predate source selection ignore `sourceKind` and return every source.
function sourcesOfKind(preview: ReviewDiffPreviewResult, kind: ReviewDiffPreviewSourceKind) {
  return preview.sources.filter((source) => source.kind === kind);
}

function gitSectionState(
  isFileAccessPending: boolean,
  preview: { readonly isPending: boolean; readonly error: string | null },
) {
  if (isFileAccessPending || preview.isPending) return "loading";
  return preview.error === null ? null : "failed";
}

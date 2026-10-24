import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { PullRequestsSearch } from "./usePullRequestListView";
import { pullRequestSurfaceId, useRightPanelStore } from "../../rightPanelStore";

export function usePullRequestHistorySelection(
  panelRef: ScopedThreadRef | null,
  selection: Parameters<typeof pullRequestSurfaceId>[0] | null,
  search: {
    [Key in "repository" | "number" | "tab"]?: PullRequestsSearch[Key] | undefined;
  },
) {
  useEffect(() => {
    if (panelRef === null) return;
    if (selection === null) {
      if (!search.repository || !search.number) useRightPanelStore.getState().close(panelRef);
      return;
    }
    useRightPanelStore.getState().openPullRequest(panelRef, selection);
    useRightPanelStore
      .getState()
      .setPullRequestDetailTab(panelRef, pullRequestSurfaceId(selection), search.tab ?? "summary");
  }, [panelRef, selection, search.repository, search.number, search.tab]);
}

export function usePullRequestNavigation() {
  const navigate = useNavigate({ from: "/pull-requests" });
  return (patch: { [Key in keyof PullRequestsSearch]?: PullRequestsSearch[Key] | undefined }) =>
    void navigate({
      to: "/pull-requests",
      search: (previous: PullRequestsSearch): PullRequestsSearch => {
        const next = { ...previous, ...patch };
        return {
          involvement: next.involvement ?? previous.involvement,
          state: next.state ?? previous.state,
          ...(next.sort && next.sort !== "ready" ? { sort: next.sort } : {}),
          ...(next.repository ? { repository: next.repository } : {}),
          ...(next.number ? { number: next.number } : {}),
          ...(next.tab && next.tab !== "summary" ? { tab: next.tab } : {}),
          ...(next.projectId ? { projectId: next.projectId } : {}),
          ...(next.environmentId ? { environmentId: next.environmentId } : {}),
          ...(next.host ? { host: next.host } : {}),
          ...(next.selectedHost ? { selectedHost: next.selectedHost } : {}),
          ...(next.selectedProjectId ? { selectedProjectId: next.selectedProjectId } : {}),
          ...(next.selectedEnvironmentId
            ? { selectedEnvironmentId: next.selectedEnvironmentId }
            : {}),
          ...(next.q ? { q: next.q } : {}),
          ...(next.draft ? { draft: next.draft } : {}),
          ...(next.review ? { review: next.review } : {}),
          ...(next.checks ? { checks: next.checks } : {}),
          ...(next.author ? { author: next.author } : {}),
          ...(next.labels && next.labels.length > 0 ? { labels: next.labels } : {}),
        };
      },
      // Typing refines the current visit; discrete filters and PR selections create visits.
      replace: Object.keys(patch).every((key) => key === "q"),
    });
}

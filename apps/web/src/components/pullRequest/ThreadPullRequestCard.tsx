import { useAtomValue } from "@effect/atom-react";
import type { PullRequestRef, ScopedThreadRef, ThreadLinkedPullRequest } from "@t3tools/contracts";
import { ChevronRightIcon, ArrowUpRightIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { useRightPanelStore } from "~/rightPanelStore";
import { useServerConfigs } from "~/state/entities";
import { pullRequestEnvironment, pullRequestStackAtom } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { PullRequestBranchGraph } from "./PullRequestBranchGraph";
import { PullRequestChecksPopover } from "./PullRequestChecksPopover";
import {
  PullRequestDiffStat,
  pullRequestChecksState,
  resolvePullRequestState,
} from "./pullRequestPresentation";
import {
  allowedPullRequestMergeMethods,
  buildResolveConflictsPrompt,
  resolvePullRequestMergeMethod,
  resolveThreadPanelPullRequestAction,
} from "./pullRequestDetail.logic";
import {
  usePullRequestActionRunner,
  usePullRequestDefaultMergeMethodResolver,
  usePullRequestHandoffs,
} from "./usePullRequestActions";
import { PullRequestGlyph } from "./pullRequestIcons";
import { useInlineActionConfirm } from "./useInlineActionConfirm";
import { usePullRequestChecksRefresh } from "~/hooks/usePullRequestChecksRefresh";
import { useUiStateStore } from "~/uiStateStore";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import styles from "./pullRequestMotion.module.css";

export function ThreadPullRequestCard({
  threadRef,
  link,
  cwd,
}: {
  threadRef: ScopedThreadRef;
  link: ThreadLinkedPullRequest;
  cwd: string | null;
}) {
  const { environmentId } = threadRef;
  const configs = useServerConfigs();
  const supported = configs.get(environmentId)?.environment.capabilities.pullRequests === true;
  const parsed = parseChangeRequestUrl(link.url);
  const host = parsed?.authority ?? parsed?.host;
  const reference: PullRequestRef = {
    projectId: link.projectId,
    repository: link.repository,
    number: link.number,
    ...(host ? { host } : {}),
  };
  const query = useEnvironmentQuery(
    supported ? pullRequestEnvironment.detail({ environmentId, input: reference }) : null,
  );
  const detail = query.data;
  const stackQuery = useEnvironmentQuery(
    detail?.state === "open" && detail.capabilities.stackActions
      ? pullRequestStackAtom({ environmentId, input: reference })
      : null,
  );
  const [expanded, setExpanded] = useState(true);
  const canWrite = useAtomValue(pullRequestEnvironment.runAction.permissionAtom(environmentId));
  const resolveDefault = usePullRequestDefaultMergeMethodResolver(environmentId, link.projectId);
  const key = `${environmentId}:${host}:${link.repository}:${link.number}`;
  const confirm = useInlineActionConfirm(key);
  const { actionPending, perform } = usePullRequestActionRunner({
    environmentId,
    reference,
    onSuccess: () => query.refresh(),
    resolveMergeMethod: (fresh) => {
      if (
        fresh.mergeability !== "mergeable" ||
        resolveThreadPanelPullRequestAction(fresh) !== "merge"
      )
        throw new Error(
          "This pull request is no longer ready to merge. Refresh its status and try again.",
        );
      return resolvePullRequestMergeMethod(
        allowedPullRequestMergeMethods(fresh),
        null,
        resolveDefault(),
        useUiStateStore.getState().pullRequestMergeMethod,
      );
    },
  });
  const { handoff, startHandoff } = usePullRequestHandoffs({ environmentId, detail });
  usePullRequestChecksRefresh({
    refresh: query.refresh,
    enabled: detail?.state === "open",
    key: `pr-card-checks:${key}`,
    checks: detail?.checks ?? [],
  });
  const open = () =>
    useRightPanelStore.getState().openPullRequest(threadRef, {
      projectId: link.projectId,
      repository: link.repository,
      number: link.number,
      url: link.url,
      ...(host ? { host } : {}),
    });
  if (!supported) return null;
  const state = detail ? resolvePullRequestState(detail) : null;
  const checks = detail ? pullRequestChecksState(detail.checks) : null;
  const resolvedAction = resolveThreadPanelPullRequestAction(detail);
  const action =
    resolvedAction === "merge" && detail?.mergeability !== "mergeable" ? null : resolvedAction;
  const stackBlocked =
    detail?.state === "open" &&
    detail.capabilities.stackActions &&
    (stackQuery.data !== null || stackQuery.isPending || stackQuery.error !== null);
  const status =
    detail?.state === "merged"
      ? "Pull request merged"
      : detail?.state === "closed"
        ? "Pull request closed"
        : detail?.isDraft
          ? "Draft pull request"
          : detail?.mergeability === "conflicting"
            ? `Conflicts with ${detail.baseBranch}`
            : checks === "failing"
              ? "Checks need attention"
              : checks === "pending"
                ? "Checks in progress"
                : detail?.mergeability === "mergeable"
                  ? `No conflicts with ${detail.baseBranch}`
                  : "Checking mergeability…";
  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      render={
        <section
          aria-label={`Pull request #${link.number}`}
          className={cn(
            styles.cardEnter,
            "@container/pr-card overflow-hidden rounded-xl border border-border/70 bg-card/40 text-card-foreground",
          )}
        />
      }
    >
      <div className="flex min-w-0 items-center gap-2 px-4 py-3">
        <CollapsibleTrigger
          render={<Button variant="ghost-muted" size="icon-micro" />}
          aria-label={expanded ? "Collapse pull request" : "Expand pull request"}
        >
          <ChevronRightIcon className={cn(styles.chevron, expanded && "rotate-90")} />
        </CollapsibleTrigger>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-baseline gap-1 text-left text-xs font-medium hover:underline focus-visible:outline-ring"
          onClick={open}
        >
          <span className="truncate">{detail?.title ?? "Pull request"}</span>
          <span className="shrink-0 font-normal text-muted-foreground">#{link.number}</span>
        </button>
        {state ? (
          <span
            key={state.label}
            className={cn(
              styles.status,
              "flex shrink-0 items-center gap-1 text-3xs",
              state.toneClassName,
            )}
          >
            <state.Icon aria-hidden className="size-3" />
            {state.label}
          </span>
        ) : null}
        <Button
          variant="ghost-muted"
          size="icon-micro"
          aria-label="Open pull request details"
          onClick={open}
        >
          <ArrowUpRightIcon />
        </Button>
      </div>
      <CollapsiblePanel>
        {detail ? (
          <div className="px-4 pb-3">
            <PullRequestBranchGraph
              environmentId={environmentId}
              cwd={cwd ?? detail.workspaceRoot}
              headBranch={detail.headBranch}
              baseBranch={detail.baseBranch}
            />
          </div>
        ) : (
          <div role="status" className="px-4 pb-4 text-xs text-muted-foreground">
            {query.error ? (
              <>
                <p>Could not load this pull request.</p>
                <Button variant="ghost" size="xs" onClick={query.refresh}>
                  Try again
                </Button>
              </>
            ) : (
              "Loading pull request…"
            )}
          </div>
        )}
        {detail ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border/50 px-4 py-2.5">
            <span
              role="status"
              className={cn(
                "min-w-0 flex-1 truncate text-2xs",
                detail.mergeability === "conflicting"
                  ? "text-warning-foreground"
                  : "text-muted-foreground",
              )}
            >
              <span key={status} className={cn(styles.status, "inline-block")}>
                {status}
              </span>
            </span>
            <PullRequestDiffStat additions={detail.additions} deletions={detail.deletions} />
            {checks ? (
              <PullRequestChecksPopover
                checksState={checks}
                checks={detail.checks}
                threadRef={threadRef}
                variant="count"
              />
            ) : null}
            {action === "resolve" ? (
              <Button
                size="xs"
                variant="warning-outline"
                disabled={handoff !== null}
                onClick={() =>
                  void startHandoff("conflicts", { prompt: buildResolveConflictsPrompt(detail) })
                }
              >
                {handoff ? "Preparing…" : "Resolve conflicts"}
              </Button>
            ) : action === "merge" && !stackBlocked ? (
              <Button
                size="xs"
                variant="outline"
                disabled={!canWrite || actionPending || query.isPending}
                {...confirm.props("merge", () => void perform("merge"))}
              >
                {actionPending ? <Spinner size="xs" /> : <PullRequestGlyph.merged aria-hidden />}
                {actionPending ? "Merging…" : confirm.isArmed("merge") ? "Confirm merge?" : "Merge"}
              </Button>
            ) : stackBlocked ? (
              <Button size="xs" variant="outline" onClick={open}>
                Open stack
              </Button>
            ) : null}
            <Button
              variant="ghost-muted"
              size="icon-micro"
              aria-label="Refresh pull request"
              disabled={query.isPending}
              onClick={query.refresh}
            >
              <RefreshCwIcon />
            </Button>
          </div>
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  );
}

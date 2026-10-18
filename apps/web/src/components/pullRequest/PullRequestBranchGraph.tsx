import type { EnvironmentId, GitHistoryResult } from "@t3tools/contracts";
import { layoutGitGraph } from "@t3tools/shared/gitGraph";
import { useState } from "react";
import { GitBranchIcon, RefreshCwIcon } from "lucide-react";
import { useServerConfigs } from "~/state/entities";
import { gitEnvironment } from "~/state/git";
import { useEnvironmentQuery } from "~/state/query";
import { cn } from "~/lib/utils";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const COLORS = [
  "text-info",
  "text-success",
  "text-primary",
  "text-warning-foreground",
  "text-destructive",
];

export function GitCommitGraph({
  history,
  headBranch,
  baseBranch,
}: {
  history: GitHistoryResult;
  headBranch: string;
  baseBranch: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const { rows, width } = layoutGitGraph(history.commits);
  const visible = expanded ? rows : rows.slice(0, 8);
  return (
    <div>
      <ol aria-label="Branch commit history" className="max-h-80 overflow-auto overscroll-contain">
        {visible.map(({ commit, x, color, paths }) => {
          const isHead = commit.sha === history.headSha;
          const isBase = commit.sha === history.baseSha;
          return (
            <li key={commit.sha} className="flex h-8 min-w-0 items-center gap-2 text-xs">
              <svg
                width={Math.min(width, 96)}
                height={32}
                viewBox={`0 0 ${width} 32`}
                preserveAspectRatio="none"
                aria-hidden
                className="shrink-0 overflow-visible"
              >
                {paths.map((path) => (
                  <path
                    key={path.d}
                    d={path.d}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    className={cn(COLORS[path.color], "opacity-40")}
                  />
                ))}
                <circle
                  cx={x}
                  cy={16}
                  r={isHead ? 4 : 3}
                  stroke="var(--background)"
                  strokeWidth={2}
                  fill="currentColor"
                  className={COLORS[color]}
                />
                {isHead ? (
                  <circle
                    cx={x}
                    cy={16}
                    r={6}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1}
                    className={cn(COLORS[color], "opacity-30")}
                  />
                ) : null}
              </svg>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate",
                        isBase && !isHead ? "text-muted-foreground" : "text-foreground",
                      )}
                    >
                      {commit.subject || "Untitled commit"}
                    </span>
                  }
                />
                <TooltipPopup>
                  {commit.subject}
                  <br />
                  {commit.sha}
                </TooltipPopup>
              </Tooltip>
              {isHead || isBase || commit.branches.length > 0 ? (
                <span
                  className={cn(
                    "max-w-36 truncate rounded px-1.5 py-0.5 font-mono text-3xs",
                    isHead
                      ? "bg-info/10 text-info-foreground"
                      : isBase
                        ? "bg-muted text-muted-foreground"
                        : "bg-success/10 text-success-foreground",
                  )}
                >
                  {isHead ? headBranch : isBase ? baseBranch : commit.branches[0]}
                </span>
              ) : null}
              <span className="hidden shrink-0 font-mono text-3xs text-muted-foreground/60 @min-[32rem]/pr-graph:inline">
                {commit.sha.slice(0, 7)}
              </span>
              <span className="hidden w-24 shrink-0 truncate text-right text-muted-foreground @min-[26rem]/pr-graph:inline">
                {commit.author}
              </span>
              <span className="hidden w-14 shrink-0 truncate text-right text-3xs text-muted-foreground @min-[36rem]/pr-graph:inline">
                <RelativeTime timestamp={commit.authoredAt} />
              </span>
            </li>
          );
        })}
      </ol>
      {rows.length > 8 ? (
        <div className="mt-1 flex justify-center">
          <Button
            variant="ghost-muted"
            size="micro"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Show less" : `Show ${rows.length - 8} more commits`}
          </Button>
        </div>
      ) : null}
      {expanded && history.truncated ? (
        <p className="mt-1 text-center text-3xs text-muted-foreground">
          Showing the 40 most recent commits
        </p>
      ) : null}
    </div>
  );
}

export function PullRequestBranchGraph({
  environmentId,
  cwd,
  headBranch,
  baseBranch,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  headBranch: string;
  baseBranch: string;
}) {
  const configs = useServerConfigs();
  const supported = configs.get(environmentId)?.environment.capabilities.gitHistory === true;
  const query = useEnvironmentQuery(
    supported
      ? gitEnvironment.history({ environmentId, input: { cwd, headBranch, baseBranch } })
      : null,
  );
  return (
    <div className="@container/pr-graph">
      <div className="mb-2 flex items-center gap-1.5 text-3xs text-muted-foreground">
        <GitBranchIcon aria-hidden className="size-3" />
        <span className="flex-1">Local branch history</span>
        {supported ? (
          <Button
            variant="ghost-muted"
            size="icon-micro"
            aria-label="Refresh branch history"
            disabled={query.isPending}
            onClick={query.refresh}
          >
            <RefreshCwIcon aria-hidden />
          </Button>
        ) : null}
      </div>
      {!supported ? (
        <p className="py-3 text-xs text-muted-foreground">
          Update this environment to see its branch history.
        </p>
      ) : query.error ? (
        <div role="status" className="py-3 text-xs text-muted-foreground">
          <p>Could not load branch history.</p>
          <p className="mt-1 break-words">{query.error}</p>
          <Button variant="ghost" size="xs" onClick={query.refresh}>
            Try again
          </Button>
        </div>
      ) : query.data === null ? (
        <p role="status" className="py-3 text-xs text-muted-foreground">
          Loading branch history…
        </p>
      ) : query.data.commits.length === 0 ? (
        <p className="py-3 text-xs text-muted-foreground">
          Check out this branch to see its commit history.
        </p>
      ) : (
        <GitCommitGraph
          key={`${cwd}:${headBranch}:${baseBranch}`}
          history={query.data}
          headBranch={headBranch}
          baseBranch={baseBranch}
        />
      )}
    </div>
  );
}

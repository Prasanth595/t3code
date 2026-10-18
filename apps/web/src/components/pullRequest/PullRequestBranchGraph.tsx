import type { EnvironmentId, GitHistoryCommit, GitHistoryResult } from "@t3tools/contracts";
import { branchOnlyShas, layoutGitGraph } from "@t3tools/shared/gitGraph";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { GitBranchIcon, RefreshCwIcon } from "lucide-react";
import { useServerConfigs } from "~/state/entities";
import { gitEnvironment } from "~/state/git";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { cn } from "~/lib/utils";
import { RelativeTime } from "../RelativeTime";
import { AnimatedHeight } from "../AnimatedHeight";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { PullRequestGraphTarget, PullRequestGraphTone } from "./pullRequestDetail.logic";
import { PULL_REQUEST_STATE_PRESENTATION } from "./pullRequestIcons";
import styles from "./pullRequestMotion.module.css";

const COLORS = [
  "text-info",
  "text-success",
  "text-primary",
  "text-warning-foreground",
  "text-destructive",
];
const TONES: Record<PullRequestGraphTone, string> = {
  pending: "text-warning",
  warning: "text-warning-foreground",
  success: "text-success",
  danger: "text-destructive",
  merged: PULL_REQUEST_STATE_PRESENTATION.merged.toneClassName,
  muted: "text-muted-foreground",
};
const TARGET = "pull-request";
const WORKING_TREE = "working-tree";
const WORKING_TREE_LABEL = "Uncommitted changes";
const COLLAPSED_COMMITS = 8;
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
const SCRAMBLE_MS = 560;
const GLYPHS = "abcdefghijklmnopqrstuvwxyz0123456789";

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Decodes `text` left to right out of `from`, or out of noise when `from` is empty. */
function ScrambleText({ text, from }: { text: string; from: string | undefined }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || from === undefined || prefersReducedMotion()) return;
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const progress = Math.min(1, (now - start) / SCRAMBLE_MS);
      const bucket = Math.floor((now - start) / 45);
      let output = "";
      for (let index = 0; index < text.length; index++) {
        const char = text[index]!;
        if (char === " " || progress >= 0.3 + (0.7 * index) / text.length) output += char;
        else if (progress < 0.12 && index < from.length) output += from[index];
        else output += GLYPHS[(index * 7 + bucket * 13 + char.charCodeAt(0)) % GLYPHS.length];
      }
      element.textContent = output;
      if (progress < 1) frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(frame);
      element.textContent = text;
    };
  }, [text, from]);
  return <span ref={ref}>{text}</span>;
}

function labelsOf(rows: ReadonlyArray<{ commit: GitHistoryCommit }>) {
  return new Map(rows.map((row) => [row.commit.sha, row.commit.subject]));
}

function syntheticCommit(sha: string, subject: string, parents: string[]): GitHistoryCommit {
  return { sha, parents, subject, author: "", authoredAt: "", branches: [] };
}

export function GitCommitGraph({
  history,
  headBranch,
  baseBranch,
  target = null,
  workingFiles = null,
  animateEntrance = false,
}: {
  history: GitHistoryResult;
  headBranch: string;
  baseBranch: string;
  /** The pull request's own row, drawn above the branch it merges. */
  target?: PullRequestGraphTarget | null;
  /** Uncommitted files on the checked-out head branch. */
  workingFiles?: number | null;
  /** Reveal rows one after another, for history that arrived while the graph was showing. */
  animateEntrance?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const positions = useRef(new Map<string, number>());
  const wasMerged = useRef(target?.tone === "merged");
  const running = useRef<Animation[]>([]);
  const headSha = history.headSha;
  const working = workingFiles !== null && headSha !== null;
  const lead = [
    ...(target
      ? [syntheticCommit(TARGET, target.label, working ? [WORKING_TREE] : headSha ? [headSha] : [])]
      : []),
    ...(working ? [syntheticCommit(WORKING_TREE, WORKING_TREE_LABEL, [headSha])] : []),
  ];
  const { rows, width } = layoutGitGraph([...lead, ...history.commits]);
  const visible = expanded ? rows : rows.slice(0, lead.length + COLLAPSED_COMMITS);
  const merged = target?.tone === "merged";
  const branch = branchOnlyShas(history.commits, headSha, history.baseSha);
  const cascade = [
    TARGET,
    ...visible.map((row) => row.commit.sha).filter((sha) => branch.has(sha)),
  ];
  // Each row's label before the latest history change, so arriving and relabelled rows decode.
  const historyKey = rows.map((row) => `${row.commit.sha}:${row.commit.subject}`).join("\n");
  const [labels, setLabels] = useState(() => ({
    key: historyKey,
    current: labelsOf(rows),
    before: null as ReadonlyMap<string, string> | null,
  }));
  if (labels.key !== historyKey) {
    setLabels({ key: historyKey, current: labelsOf(rows), before: labels.current });
  }
  const previous = labels.key === historyKey ? labels.before : labels.current;
  // A commit that lands where the uncommitted row was decodes out of that row's label.
  const replacesWorkingTree = previous?.has(WORKING_TREE) === true && !working;
  const scrambleFrom = (sha: string, label: string) => {
    if (previous === null) return undefined;
    const before = previous.get(sha);
    if (before !== undefined) return before === label ? undefined : before;
    return replacesWorkingTree && sha === headSha ? WORKING_TREE_LABEL : "";
  };
  const signature = visible.map((row) => `${row.commit.sha}:${row.commit.subject}`).join("\n");

  useEffect(() => () => running.current.forEach((animation) => animation.cancel()), []);
  // Animates whatever changed since the last layout: new history arrives, moved rows slide, and a
  // merge carries down the branch. Nothing runs while the graph is idle.
  const animateChanges = useEffectEvent((_signature: string, isMerged: boolean) => {
    const list = listRef.current;
    if (!list) return;
    const before = previous;
    const reduced = prefersReducedMotion();
    const play = (element: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
      const animation = element.animate(keyframes, {
        easing: EASE_OUT,
        fill: "backwards",
        ...options,
      });
      running.current.push(animation);
      void animation.finished.then(
        () => (running.current = running.current.filter((entry) => entry !== animation)),
        () => {},
      );
    };
    const reveal = (row: HTMLElement, delay: number) => {
      play(
        row,
        [
          { opacity: 0, transform: "translateY(6px)", filter: "blur(4px)" },
          { opacity: 1, transform: "none", filter: "none" },
        ],
        { duration: 380, delay },
      );
      for (const path of row.querySelectorAll("path")) {
        play(
          path,
          [
            { strokeDasharray: "1", strokeDashoffset: 1 },
            { strokeDasharray: "1", strokeDashoffset: 0 },
          ],
          { duration: 420, delay: delay + 40 },
        );
      }
      for (const node of row.querySelectorAll("[data-graph-node]")) {
        play(node, [{ transform: "scale(0)" }, { transform: "scale(1)" }], {
          duration: 360,
          delay: delay + 90,
          easing: "cubic-bezier(0.34, 1.56, 0.64, 1)",
        });
      }
    };
    const flash = (row: HTMLElement, color: string, delay = 0) =>
      play(row, [{ backgroundColor: color }, { backgroundColor: "transparent" }], {
        duration: 1400,
        delay,
        easing: "ease-out",
      });
    const next = new Map<string, number>();
    let revealed = 0;
    for (const [index, { commit }] of visible.entries()) {
      const row = list.children[index];
      if (!(row instanceof HTMLElement)) continue;
      const top = row.offsetTop;
      next.set(commit.sha, top);
      if (reduced) continue;
      const previousTop = positions.current.get(commit.sha);
      if (before === null) {
        if (animateEntrance) reveal(row, Math.min(index, 10) * 32);
      } else if (previousTop !== undefined) {
        if (previousTop !== top) {
          play(row, [{ transform: `translateY(${previousTop - top}px)` }, { transform: "none" }], {
            duration: 260,
          });
        }
      } else if (before.has(commit.sha)) {
        reveal(row, Math.min(revealed++, 10) * 24);
      } else if (replacesWorkingTree && commit.sha === headSha) {
        flash(row, "rgb(245 158 11 / 0.12)");
      } else {
        reveal(row, 0);
        flash(row, "rgb(245 158 11 / 0.14)");
      }
    }
    if (!reduced && before !== null && isMerged && !wasMerged.current) {
      for (const [rank, sha] of cascade.entries()) {
        const row = list.querySelector<HTMLElement>(`[data-graph-row="${sha}"]`);
        if (row) flash(row, "rgb(139 92 246 / 0.12)", rank * 70);
      }
    }
    wasMerged.current = isMerged;
    positions.current = next;
  });
  useLayoutEffect(() => animateChanges(signature, merged), [signature, merged]);

  return (
    <div>
      <ol
        ref={listRef}
        aria-label="Branch commit history"
        className="relative max-h-80 overflow-auto overscroll-contain"
      >
        {visible.map(({ commit, x, color, paths }) => {
          const isTarget = commit.sha === TARGET;
          const isWorking = commit.sha === WORKING_TREE;
          const isHead = commit.sha === headSha;
          const isBase = commit.sha === history.baseSha;
          const chip = isWorking || (isHead && !working);
          const rank = cascade.indexOf(commit.sha);
          const nodeColor = isTarget
            ? TONES[target!.tone]
            : merged && rank >= 0
              ? TONES.merged
              : COLORS[color];
          return (
            <li
              key={commit.sha}
              data-graph-row={commit.sha}
              {...(isTarget || isWorking ? {} : { "data-commit-sha": commit.sha })}
              className={cn(
                "flex h-8 min-w-0 items-center gap-2 rounded-md text-xs",
                isTarget && target!.tone === "warning" && "bg-warning/6",
              )}
            >
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
                    pathLength={1}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    className={cn(COLORS[path.color], "opacity-40")}
                  />
                ))}
                <g data-graph-node className={styles.node}>
                  {isTarget && target!.busy ? (
                    <circle
                      cx={x}
                      cy={16}
                      r={4.5}
                      fill="var(--background)"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeDasharray="7 22"
                      strokeLinecap="round"
                      className={cn(styles.spin, nodeColor)}
                    />
                  ) : isWorking ? (
                    <circle
                      cx={x}
                      cy={16}
                      r={4}
                      fill="var(--background)"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeDasharray="2 2"
                      className={nodeColor}
                    />
                  ) : (
                    <>
                      <circle
                        cx={x}
                        cy={16}
                        r={isHead || isTarget ? 4 : 3}
                        stroke="var(--background)"
                        strokeWidth={2}
                        fill="currentColor"
                        className={nodeColor}
                        style={rank > 0 ? { transitionDelay: `${rank * 70}ms` } : undefined}
                      />
                      {isHead || isTarget ? (
                        <circle
                          cx={x}
                          cy={16}
                          r={6.5}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={1}
                          className={cn(nodeColor, "opacity-30")}
                          style={rank > 0 ? { transitionDelay: `${rank * 70}ms` } : undefined}
                        />
                      ) : null}
                    </>
                  )}
                </g>
              </svg>
              {isTarget || isWorking ? (
                <span className="relative min-w-0 flex-1 truncate text-muted-foreground">
                  <ScrambleText
                    key={commit.subject}
                    text={commit.subject}
                    from={scrambleFrom(commit.sha, commit.subject)}
                  />
                  {isTarget && target!.progress !== null ? (
                    <span
                      aria-hidden
                      className={cn(
                        styles.progress,
                        "absolute inset-x-0 bottom-1 h-px origin-left bg-success/70",
                      )}
                      style={{ transform: `scaleX(${target!.progress})` }}
                    />
                  ) : null}
                </span>
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate",
                          isBase && !isHead ? "text-muted-foreground" : "text-foreground",
                        )}
                      >
                        <ScrambleText
                          key={commit.subject}
                          text={commit.subject || "Untitled commit"}
                          from={scrambleFrom(commit.sha, commit.subject)}
                        />
                      </span>
                    }
                  />
                  <TooltipPopup>
                    {commit.subject}
                    <br />
                    {commit.sha}
                  </TooltipPopup>
                </Tooltip>
              )}
              {chip || (isBase && !isTarget) || (!isTarget && commit.branches.length > 0) ? (
                <span
                  className={cn(
                    "max-w-36 truncate rounded px-1.5 py-0.5 font-mono text-3xs",
                    chip
                      ? "bg-info/10 text-info-foreground"
                      : isBase
                        ? "bg-muted text-muted-foreground"
                        : "bg-success/10 text-success-foreground",
                  )}
                >
                  {chip ? headBranch : isBase ? baseBranch : commit.branches[0]}
                </span>
              ) : null}
              {isTarget ? (
                <span
                  key={target!.status}
                  className={cn(styles.status, "shrink-0 text-3xs", TONES[target!.tone])}
                >
                  {target!.status}
                </span>
              ) : isWorking ? (
                <span className="shrink-0 text-3xs text-muted-foreground">
                  {workingFiles === 0
                    ? "uncommitted"
                    : `${workingFiles} ${workingFiles === 1 ? "file" : "files"}`}
                </span>
              ) : (
                <>
                  <span className="hidden shrink-0 font-mono text-3xs text-muted-foreground/60 @min-[32rem]/pr-graph:inline">
                    <ScrambleText
                      key={commit.sha}
                      text={commit.sha.slice(0, 7)}
                      from={scrambleFrom(commit.sha, commit.subject) === undefined ? undefined : ""}
                    />
                  </span>
                  <span className="hidden w-24 shrink-0 truncate text-right text-muted-foreground @min-[26rem]/pr-graph:inline">
                    {commit.author}
                  </span>
                  <span className="hidden w-14 shrink-0 truncate text-right text-3xs text-muted-foreground @min-[36rem]/pr-graph:inline">
                    <RelativeTime timestamp={commit.authoredAt} />
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ol>
      {rows.length > lead.length + COLLAPSED_COMMITS ? (
        <div className="mt-1 flex justify-center">
          <Button
            variant="ghost-muted"
            size="micro"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded
              ? "Show less"
              : `Show ${rows.length - lead.length - COLLAPSED_COMMITS} more commits`}
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
  target = null,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  headBranch: string;
  baseBranch: string;
  target?: PullRequestGraphTarget | null;
}) {
  const configs = useServerConfigs();
  const supported = configs.get(environmentId)?.environment.capabilities.gitHistory === true;
  const query = useEnvironmentQuery(
    supported
      ? gitEnvironment.history({ environmentId, input: { cwd, headBranch, baseBranch } })
      : null,
  );
  const status = useEnvironmentQuery(
    supported ? vcsEnvironment.status({ environmentId, input: { cwd } }) : null,
  ).data;
  const [cachedAtMount] = useState(query.data !== null);
  // Commits, pushes, and pulls change these, so the graph follows the agent's work live.
  const signature = status
    ? [
        status.refName,
        status.aheadCount,
        status.behindCount,
        status.aheadOfDefaultCount,
        status.workingTree.files.length,
      ].join(":")
    : null;
  const seenSignature = useRef(signature);
  useEffect(() => {
    const previous = seenSignature.current;
    seenSignature.current = signature;
    if (previous !== null && signature !== null && previous !== signature) query.refresh();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Refresh only when the checkout moves.
  }, [signature]);
  const dirtyFiles =
    status?.refName === headBranch && status.hasWorkingTreeChanges
      ? status.workingTree.files.length
      : null;
  // Keep the uncommitted row until the history that replaces it arrives, so a fresh commit
  // takes its place instead of the row vanishing first.
  const [held, setHeld] = useState<{ files: number; history: GitHistoryResult | null } | null>(
    null,
  );
  if (dirtyFiles !== null && (held?.files !== dirtyFiles || held.history !== query.data)) {
    setHeld({ files: dirtyFiles, history: query.data });
  }
  const workingFiles =
    dirtyFiles ?? (held !== null && held.history === query.data ? held.files : null);
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
      <AnimatedHeight>
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
            target={target}
            workingFiles={workingFiles}
            animateEntrance={!cachedAtMount}
          />
        )}
      </AnimatedHeight>
    </div>
  );
}

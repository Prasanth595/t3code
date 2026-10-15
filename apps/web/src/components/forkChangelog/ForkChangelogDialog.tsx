import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ForkCommit,
  ForkRelease,
  ForkWorkflowRun,
  ForkWorkflowState,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  ArrowDownToLineIcon,
  CircleCheckIcon,
  ExternalLinkIcon,
  GitCompareArrowsIcon,
  GitForkIcon,
} from "lucide-react";
import {
  createContext,
  type ReactElement,
  type ReactNode,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { APP_VERSION } from "../../branding";
import { useClientSettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  forkReleaseChanges,
  forkReleases,
  forkSyncStatus,
  forkUpstreamPending,
  startForkSync,
} from "../../state/forkChangelog";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatChatTimestampTooltip, formatRelativeTimeLabel } from "../../timestampFormat";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { PullRequestActorAvatar } from "../pullRequest/pullRequestPresentation";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ForkChangelogAgentMenu } from "./ForkChangelogAgentMenu";
import { type ForkChangelogTab, linkCommitSubject } from "./forkChangelog.logic";

/** How often the open changelog re-reads a queued or running Fork Sync run. */
const SYNC_REFRESH_MS = 5_000;
/** Each release reads GitHub, so the timeline adds older releases on request. */
const RELEASE_PAGE_SIZE = 10;

interface ChangelogClock {
  readonly nowMs: number;
  readonly timestampFormat: TimestampFormat;
}

/** One minute tick for every time label, so the list itself does not re-render. */
const ChangelogClockContext = createContext<ChangelogClock | null>(null);

export function ChangelogClockProvider({ children }: { readonly children: ReactNode }) {
  const nowMs = useRelativeTimeTick(60_000);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const clock = useMemo(() => ({ nowMs, timestampFormat }), [nowMs, timestampFormat]);
  return <ChangelogClockContext value={clock}>{children}</ChangelogClockContext>;
}

/**
 * Fork feature: a timeline of fork releases and their fork and upstream commits, the upstream
 * commits that fork main does not have yet, and the Fork Sync workflow. Reads run only while it
 * is open.
 */
export function ForkChangelogDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [tab, setTab] = useState<ForkChangelogTab>("releases");
  const environmentId = usePrimaryEnvironmentId();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Changelog</DialogTitle>
          <DialogDescription>
            Fork releases, and the upstream changes that fork main does not have yet.
          </DialogDescription>
          {/* The header stays in place while the panel below scrolls. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ToggleGroup
              aria-label="Changelog view"
              value={[tab]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "releases" || value === "upstream") setTab(value);
              }}
            >
              <Toggle value="releases">Releases</Toggle>
              <Toggle value="upstream">Upstream</Toggle>
            </ToggleGroup>
            {environmentId === null ? null : (
              <ForkChangelogAgentMenu
                environmentId={environmentId}
                tab={tab}
                onOpened={() => onOpenChange(false)}
              />
            )}
          </div>
        </DialogHeader>
        <DialogPanel>
          <ChangelogClockProvider>
            <ForkChangelogBody environmentId={environmentId} tab={tab} />
          </ChangelogClockProvider>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function ForkChangelogBody({
  environmentId,
  tab,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly tab: ForkChangelogTab;
}) {
  if (environmentId === null) {
    return <Notice>Connect to an environment to read the changelog.</Notice>;
  }
  return tab === "releases" ? (
    <ReleasesTab environmentId={environmentId} />
  ) : (
    <UpstreamTab environmentId={environmentId} />
  );
}

function ReleasesTab({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const releases = useEnvironmentQuery(forkReleases({ environmentId, input: {} }));
  const [shownCount, setShownCount] = useState(RELEASE_PAGE_SIZE);

  if (releases.data === null) {
    return (
      <QueryState subject="the fork releases" error={releases.error} retry={releases.refresh} />
    );
  }
  const list = releases.data.releases;
  if (list.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No releases yet</EmptyTitle>
          <EmptyDescription>The fork has no published release on GitHub.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const hiddenCount = list.length - shownCount;

  return (
    <div className="flex flex-col gap-3">
      <ol aria-label="Fork release timeline" className="flex flex-col">
        {list.slice(0, shownCount).map((release) => (
          <ReleaseSection environmentId={environmentId} key={release.tag} release={release} />
        ))}
      </ol>
      {hiddenCount > 0 ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShownCount((count) => count + RELEASE_PAGE_SIZE)}
        >
          Show {Math.min(hiddenCount, RELEASE_PAGE_SIZE)} older{" "}
          {Math.min(hiddenCount, RELEASE_PAGE_SIZE) === 1 ? "release" : "releases"}
        </Button>
      ) : null}
    </div>
  );
}

/** A thin release divider, then the commits that the release adds to the release below it. */
function ReleaseSection({
  environmentId,
  release,
}: {
  readonly environmentId: EnvironmentId;
  readonly release: ForkRelease;
}) {
  const changes = useEnvironmentQuery(
    forkReleaseChanges({ environmentId, input: { tag: release.tag } }),
  );
  const data = changes.data;

  return (
    <li aria-label={`Release ${release.version}`} className="flex flex-col">
      <div className="flex items-center gap-2 px-2 pt-3 pb-1 text-muted-foreground text-xs">
        <h3 className="font-medium font-mono text-foreground break-all">
          <TextLink href={release.url}>{release.version}</TextLink>
        </h3>
        {release.version === APP_VERSION ? (
          <Hint
            label="Installed"
            render={<span className="shrink-0 text-success-foreground" role="img" />}
          >
            <CircleCheckIcon aria-hidden className="size-3.5" />
          </Hint>
        ) : null}
        <TimeLabel iso={release.publishedAt} />
        <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
        {data?.compareUrl ? (
          <Hint
            label="Compare on GitHub"
            render={
              <a
                className="shrink-0 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                href={data.compareUrl}
                rel="noreferrer noopener"
                target="_blank"
              />
            }
          >
            <GitCompareArrowsIcon aria-hidden className="size-3.5" />
          </Hint>
        ) : null}
      </div>
      {data === null ? (
        <QueryState
          subject={`the commits of ${release.version}`}
          error={changes.error}
          retry={changes.refresh}
        />
      ) : (
        <>
          {data.commits.length === 0 ? (
            <Notice>No commits besides merges.</Notice>
          ) : (
            <CommitList commits={data.commits} />
          )}
          {data.truncated ? (
            <Notice>
              The list stops at 500 commits. GitHub has more for this release.{" "}
              {data.compareUrl ? (
                <TextLink href={data.compareUrl}>See all on GitHub</TextLink>
              ) : null}
            </Notice>
          ) : null}
          {data.previousTag === null ? (
            <Notice>This is the oldest listed release, so it shows only its fork commits.</Notice>
          ) : null}
        </>
      )}
    </li>
  );
}

function UpstreamTab({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const pending = useEnvironmentQuery(forkUpstreamPending({ environmentId, input: {} }));
  const sync = useEnvironmentQuery(forkSyncStatus({ environmentId, input: {} }));
  const canStart = useAtomValue(startForkSync.permissionAtom(environmentId));
  const start = useAtomCommand(startForkSync);
  const [starting, setStarting] = useState(false);
  const run = sync.data?.run ?? null;
  const runActive = run !== null && isActiveState(run.state);
  const { refresh: refreshSync } = sync;
  const { refresh: refreshPending } = pending;

  // Bounded refresh: only while this tab is open and the newest run is queued or running.
  useEffect(() => {
    if (!runActive) return;
    const timer = window.setInterval(refreshSync, SYNC_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [runActive, refreshSync]);

  // A run that finishes while the tab watches it changes fork main, so the pending list moves.
  const watchedRunId = useRef<number | null>(null);
  useEffect(() => {
    if (run === null) return;
    if (isActiveState(run.state)) {
      watchedRunId.current = run.id;
    } else if (watchedRunId.current === run.id) {
      watchedRunId.current = null;
      refreshPending();
    }
  }, [run, refreshPending]);

  const handleStart = async () => {
    setStarting(true);
    const result = await start({ environmentId, input: {} });
    setStarting(false);
    if (result._tag === "Success") refreshSync();
  };

  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Fork Sync" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h3 className="font-medium text-sm">Fork Sync</h3>
            <p className="text-muted-foreground text-xs">
              Merges upstream main into fork main on GitHub. A merged change reaches this machine
              through the normal update.
            </p>
          </div>
          <Button
            size="sm"
            disabled={!canStart || starting || runActive}
            onClick={() => void handleStart()}
          >
            {starting ? "Starting…" : "Start Fork Sync"}
          </Button>
        </div>
        {canStart ? null : <Notice>This connection cannot start workflows.</Notice>}
        {sync.data === null ? (
          <QueryState subject="the Fork Sync runs" error={sync.error} retry={refreshSync} />
        ) : run === null ? (
          <Notice>Fork Sync has not run yet.</Notice>
        ) : (
          <SyncRun run={run} />
        )}
      </section>

      <section aria-label="Upstream changes" className="flex flex-col gap-1">
        {pending.data === null ? (
          <QueryState subject="the upstream commits" error={pending.error} retry={refreshPending} />
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="font-medium text-sm">
                {pending.data.total === 0
                  ? "Fork main has every upstream commit"
                  : `${pending.data.total} upstream ${pending.data.total === 1 ? "commit" : "commits"} not in fork main yet`}
              </h3>
              <ExternalLink href={pending.data.compareUrl}>Compare on GitHub</ExternalLink>
            </div>
            {pending.data.commits.length > 0 ? <CommitList commits={pending.data.commits} /> : null}
            {pending.data.truncated ? (
              <Notice>
                The list stops at 500 commits.{" "}
                <TextLink href={pending.data.compareUrl}>See all on GitHub</TextLink>
              </Notice>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

function SyncRun({ run }: { readonly run: ForkWorkflowRun }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="font-medium">
          <TextLink href={run.url}>Run {run.runNumber}</TextLink>
        </span>
        <StateBadge state={run.state} />
        <span className="text-muted-foreground">
          {run.event === "workflow_dispatch" ? "Started by hand" : run.event}
        </span>
        <span className="text-muted-foreground">
          <TimeLabel iso={run.createdAt} />
        </span>
      </div>
      {run.jobs.length === 0 ? (
        <Notice>GitHub has not started the jobs yet.</Notice>
      ) : (
        <ul aria-label="Fork Sync jobs" className="flex flex-col gap-1">
          {run.jobs.map((job) => (
            <li className="flex items-center gap-2 text-xs" key={job.url ?? job.name}>
              <StateBadge state={job.state} />
              {job.url ? <TextLink href={job.url}>{job.name}</TextLink> : <span>{job.name}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CommitList({ commits }: { readonly commits: ReadonlyArray<ForkCommit> }) {
  return (
    <ul className="flex flex-col">
      {commits.map((commit) => (
        <CommitRow commit={commit} key={commit.sha} />
      ))}
    </ul>
  );
}

/** The source icon and the subject, then the author avatar, the sha and the time in a muted line. */
function CommitRow({ commit }: { readonly commit: ForkCommit }) {
  const authorName = commit.author ?? commit.authorLogin ?? "Unknown author";
  const avatar = (
    <PullRequestActorAvatar
      actor={{
        login: commit.authorLogin ?? authorName,
        name: commit.author,
        avatarUrl: commit.authorLogin
          ? `https://github.com/${encodeURIComponent(commit.authorLogin)}.png?size=32`
          : null,
      }}
    />
  );
  return (
    <li className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 hover:bg-accent/50">
      <div className="flex items-baseline gap-1.5">
        <CommitSource fork={commit.fork} />
        <p className="min-w-0 text-sm leading-5 break-words">
          {linkCommitSubject(commit).map((part) =>
            part.url === null ? (
              part.text
            ) : (
              <PullRequestReference key={part.start} number={part.text.slice(1)} url={part.url} />
            ),
          )}
        </p>
      </div>
      <p className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs">
        <Hint
          label={authorName}
          render={
            commit.authorLogin ? (
              <a
                className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                href={`https://github.com/${encodeURIComponent(commit.authorLogin)}`}
                rel="noreferrer noopener"
                target="_blank"
              />
            ) : (
              <span role="img" />
            )
          }
        >
          {avatar}
        </Hint>
        <span className="font-mono">
          <TextLink href={commit.url}>{commit.sha.slice(0, 7)}</TextLink>
        </span>
        <span aria-hidden>·</span>
        <TimeLabel iso={commit.committedAt} />
      </p>
    </li>
  );
}

const COMMIT_SOURCES = {
  fork: { label: "Fork commit", Icon: GitForkIcon, className: "text-info-foreground" },
  upstream: {
    label: "Upstream commit",
    Icon: ArrowDownToLineIcon,
    className: "text-muted-foreground",
  },
} as const;

function CommitSource({ fork }: { readonly fork: boolean }) {
  const source = COMMIT_SOURCES[fork ? "fork" : "upstream"];
  return (
    <Hint
      label={source.label}
      render={<span className={`shrink-0 self-center ${source.className}`} role="img" />}
    >
      <source.Icon aria-hidden className="size-3.5" />
    </Hint>
  );
}

/**
 * A pull request reference in the markup of the thread card pull request badge, so that a theme
 * that styles `[data-thread-card-element="pullRequest"]` styles it the same way.
 */
function PullRequestReference({ number, url }: { readonly number: string; readonly url: string }) {
  return (
    <span className="contents" data-thread-card-element="pullRequest">
      <InlineButton
        aria-label={`Pull request #${number}`}
        render={<a href={url} rel="noreferrer noopener" target="_blank" />}
      >
        <span className="contents font-normal text-muted-foreground text-xs tabular-nums">
          <PullRequestGlyph.pullRequest aria-hidden className="size-3 shrink-0" />
          <span>{number}</span>
        </span>
      </InlineButton>
    </span>
  );
}

/** The absolute time and the time since, such as `9:41 AM, 12th October 2026 · 3h ago`. */
function TimeLabel({ iso }: { readonly iso: string | null }) {
  const clock = use(ChangelogClockContext);
  if (clock === null) throw new Error("TimeLabel needs a ChangelogClockProvider.");
  if (iso === null) return <span>No date</span>;
  const absolute = formatChatTimestampTooltip(iso, clock.timestampFormat);
  if (absolute === "") return <span>{iso}</span>;
  return (
    <time dateTime={iso}>
      {absolute} · {formatRelativeTimeLabel(iso, clock.nowMs)}
    </time>
  );
}

const STATE_BADGES = {
  queued: { label: "Queued", variant: "outline" },
  running: { label: "Running", variant: "info" },
  success: { label: "Success", variant: "success" },
  failure: { label: "Failed", variant: "error" },
  cancelled: { label: "Cancelled", variant: "warning" },
  skipped: { label: "Skipped", variant: "secondary" },
} as const satisfies Record<
  ForkWorkflowState,
  { label: string; variant: "outline" | "info" | "success" | "error" | "warning" | "secondary" }
>;

function StateBadge({ state }: { readonly state: ForkWorkflowState }) {
  const badge = STATE_BADGES[state];
  return (
    <Badge size="sm" variant={badge.variant}>
      {badge.label}
    </Badge>
  );
}

function isActiveState(state: ForkWorkflowState): boolean {
  return state === "queued" || state === "running";
}

// Plain anchors: the desktop shell opens a new-window link in the system browser, and the web
// app opens it in a new tab. The changelog has no thread, so an in-app preview does not apply.

/** An inline link that keeps the color of its text. */
function TextLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a
      className="rounded-sm underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      href={href}
      rel="noreferrer noopener"
      target="_blank"
    >
      {children}
    </a>
  );
}

function ExternalLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a
      className="inline-flex shrink-0 items-center gap-1 rounded-sm text-muted-foreground text-xs underline decoration-dotted underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      href={href}
      rel="noreferrer noopener"
      target="_blank"
    >
      {children}
      <ExternalLinkIcon aria-hidden className="size-3 shrink-0" />
    </a>
  );
}

/** A spinner that names what it reads, or the failure with a retry. */
function QueryState({
  subject,
  error,
  retry,
}: {
  readonly subject: string;
  readonly error: string | null;
  readonly retry: () => void;
}) {
  if (error === null) {
    return (
      <p className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground text-xs">
        <Spinner size="xs" tone="muted" />
        Reading {subject} from GitHub…
      </p>
    );
  }
  return (
    <Alert variant="error">
      <AlertTitle>Could not read {subject}</AlertTitle>
      <AlertDescription>{error}</AlertDescription>
      <AlertAction>
        <Button size="xs" variant="outline" onClick={retry}>
          Retry
        </Button>
      </AlertAction>
    </Alert>
  );
}

function Notice({ children }: { readonly children: ReactNode }) {
  return <p className="px-2 py-1 text-muted-foreground text-xs">{children}</p>;
}

/** An icon or a compact control whose meaning shows in a tooltip and in its accessible name. */
export function Hint({
  label,
  render,
  children,
}: {
  readonly label: string;
  readonly render: ReactElement;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger aria-label={label} render={render}>
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

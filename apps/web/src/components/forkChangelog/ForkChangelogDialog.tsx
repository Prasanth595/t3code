import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ForkCommit,
  ForkRelease,
  ForkWorkflowRun,
  ForkWorkflowState,
} from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { APP_VERSION } from "../../branding";
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
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

/** How often the open changelog re-reads a queued or running Fork Sync run. */
const SYNC_REFRESH_MS = 5_000;

type ForkChangelogTab = "releases" | "upstream";

/**
 * Fork feature: fork releases with their fork and upstream commits, the upstream commits that
 * fork main does not have yet, and the Fork Sync workflow. Reads run only while it is open.
 */
export function ForkChangelogDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Changelog</DialogTitle>
          <DialogDescription>
            Fork releases, and the upstream changes that fork main does not have yet.
          </DialogDescription>
        </DialogHeader>
        <ForkChangelogBody />
      </DialogPopup>
    </Dialog>
  );
}

function ForkChangelogBody() {
  const environmentId = usePrimaryEnvironmentId();
  const [tab, setTab] = useState<ForkChangelogTab>("releases");

  return (
    <DialogPanel>
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
      {environmentId === null ? (
        <Notice>Connect to an environment to read the changelog.</Notice>
      ) : tab === "releases" ? (
        <ReleasesTab environmentId={environmentId} />
      ) : (
        <UpstreamTab environmentId={environmentId} />
      )}
    </DialogPanel>
  );
}

function ReleasesTab({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const releases = useEnvironmentQuery(forkReleases({ environmentId, input: {} }));
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const list = releases.data?.releases ?? [];
  const selected =
    list.find((release) => release.tag === selectedTag) ??
    list.find((release) => release.version === APP_VERSION) ??
    list[0] ??
    null;

  if (releases.data === null) return <QueryState error={releases.error} />;
  if (list.length === 0) return <Notice>The fork has no releases.</Notice>;

  return (
    <div className="grid gap-4 sm:grid-cols-[13rem_minmax(0,1fr)]">
      <ul aria-label="Fork releases" className="flex max-h-96 flex-col gap-0.5 overflow-y-auto">
        {list.map((release) => (
          <li key={release.tag}>
            <button
              type="button"
              aria-current={release.tag === selected?.tag ? "true" : undefined}
              className={cn(
                "flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                release.tag === selected?.tag && "bg-accent",
              )}
              onClick={() => setSelectedTag(release.tag)}
            >
              <span className="font-mono text-xs break-all">{release.version}</span>
              <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                {formatDate(release.publishedAt)}
                {release.version === APP_VERSION ? (
                  <Badge size="sm" variant="secondary">
                    Installed
                  </Badge>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {selected ? <ReleaseChanges environmentId={environmentId} release={selected} /> : null}
    </div>
  );
}

function ReleaseChanges({
  environmentId,
  release,
}: {
  readonly environmentId: EnvironmentId;
  readonly release: ForkRelease;
}) {
  const changes = useEnvironmentQuery(
    forkReleaseChanges({ environmentId, input: { tag: release.tag } }),
  );
  const data = changes.data?.tag === release.tag ? changes.data : null;

  return (
    <section aria-label={`Changes in ${release.version}`} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-medium font-mono text-sm break-all">{release.version}</h3>
        <ExternalLink href={release.url}>Release on GitHub</ExternalLink>
        {data?.compareUrl ? (
          <ExternalLink href={data.compareUrl}>Compare on GitHub</ExternalLink>
        ) : null}
      </div>
      {data === null ? (
        <QueryState error={changes.error} />
      ) : (
        <>
          {data.previousTag === null ? (
            <Notice>
              This is the oldest listed release, so it shows every fork commit it has.
            </Notice>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <h4 className="font-medium text-xs">Fork changes ({data.forkCommits.length})</h4>
            {data.forkCommits.length === 0 ? (
              <Notice>No fork commits in this release.</Notice>
            ) : (
              <CommitList commits={data.forkCommits} forkMarker />
            )}
          </div>
          {data.previousTag === null ? null : (
            <details className="flex flex-col gap-1.5">
              <summary className="cursor-pointer font-medium text-xs">
                Upstream changes ({data.upstreamCommits.length})
              </summary>
              {data.upstreamCommits.length === 0 ? (
                <Notice>No upstream commits in this release.</Notice>
              ) : (
                <CommitList commits={data.upstreamCommits} />
              )}
            </details>
          )}
          {data.truncated ? (
            <Notice>GitHub has more commits for this release than the list shows.</Notice>
          ) : null}
        </>
      )}
    </section>
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
          <QueryState error={sync.error} />
        ) : run === null ? (
          <Notice>Fork Sync has not run yet.</Notice>
        ) : (
          <SyncRun run={run} />
        )}
      </section>

      <section aria-label="Upstream changes" className="flex flex-col gap-2">
        {pending.data === null ? (
          <QueryState error={pending.error} />
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
              <Notice>GitHub has more upstream commits than the list shows.</Notice>
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
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">Run {run.runNumber}</span>
        <StateBadge state={run.state} />
        <span className="text-muted-foreground">
          {run.event === "workflow_dispatch" ? "Started by hand" : run.event},{" "}
          {formatDate(run.createdAt)}
        </span>
        <ExternalLink href={run.url}>Run on GitHub</ExternalLink>
      </div>
      {run.jobs.length === 0 ? (
        <Notice>GitHub has not started the jobs yet.</Notice>
      ) : (
        <ul aria-label="Fork Sync jobs" className="flex flex-col gap-1">
          {run.jobs.map((job) => (
            <li className="flex items-center gap-2 text-xs" key={job.url ?? job.name}>
              <StateBadge state={job.state} />
              {job.url ? (
                <ExternalLink href={job.url}>{job.name}</ExternalLink>
              ) : (
                <span>{job.name}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CommitList({
  commits,
  forkMarker = false,
}: {
  readonly commits: ReadonlyArray<ForkCommit>;
  readonly forkMarker?: boolean;
}) {
  return (
    <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
      {commits.map((commit) => (
        <li className="flex items-baseline gap-2 text-xs leading-5" key={commit.sha}>
          {forkMarker ? (
            <Badge size="sm" variant="info">
              Fork
            </Badge>
          ) : null}
          <span className="min-w-0 flex-1 break-words">{commit.subject}</span>
          <a
            className="shrink-0 font-mono text-muted-foreground hover:text-foreground"
            href={commit.url}
            rel="noreferrer noopener"
            target="_blank"
          >
            {commit.sha.slice(0, 7)}
          </a>
        </li>
      ))}
    </ul>
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

function ExternalLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a
      className="inline-flex items-center gap-1 text-muted-foreground text-xs underline decoration-dotted underline-offset-4 hover:text-foreground"
      href={href}
      rel="noreferrer noopener"
      target="_blank"
    >
      {children}
      <ExternalLinkIcon aria-hidden className="size-3 shrink-0" />
    </a>
  );
}

function QueryState({ error }: { readonly error: string | null }) {
  return error === null ? (
    <Spinner size="sm" tone="muted" />
  ) : (
    <p className="text-destructive-foreground text-xs">{error}</p>
  );
}

function Notice({ children }: { readonly children: ReactNode }) {
  return <p className="text-muted-foreground text-xs">{children}</p>;
}

function formatDate(iso: string | null): string {
  if (iso === null) return "Not published";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

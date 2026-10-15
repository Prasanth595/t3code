import { useAtomValue } from "@effect/atom-react";
import type { DesktopUpdateState, EnvironmentId, ForkCommit } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { ChevronRightIcon, GitCommitHorizontalIcon, TagIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { forkReleaseChanges, forkReleases } from "../../state/forkChangelog";
import { useEnvironmentQuery } from "../../state/query";
import { SidebarUpdateReleaseNotes } from "../sidebar/SidebarUpdateReleaseNotes";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { ChangelogClockProvider, CommitList, Hint } from "./ForkChangelogDialog";
import { releasesInUpdate, UPDATE_CHANGES_LIMIT } from "./forkChangelog.logic";

interface ForkUpdateChangesProps {
  readonly state: DesktopUpdateState;
  readonly tooltip: string;
  readonly onOpenChangelog: () => void;
}

interface UpdateReleasesProps extends ForkUpdateChangesProps {
  readonly environmentId: EnvironmentId;
  readonly updateVersion: string;
  /** The release notes of the update. Shown when GitHub cannot answer, such as offline. */
  readonly fallback: ReactNode;
}

/**
 * Fork feature: the update popup body. It lists the commits of the releases between the installed
 * version and the offered one, as the changelog shows them. Reads run only while the popup is open.
 */
export function ForkUpdateChanges(props: ForkUpdateChangesProps) {
  const environmentId = usePrimaryEnvironmentId();
  const updateVersion = props.state.downloadedVersion ?? props.state.availableVersion;
  const fallback = (
    <SidebarUpdateReleaseNotes
      shell={window.desktopBridge}
      state={props.state}
      tooltip={props.tooltip}
    />
  );
  if (environmentId === null || updateVersion === null) return fallback;
  return (
    <UpdateReleases
      {...props}
      environmentId={environmentId}
      updateVersion={updateVersion}
      fallback={fallback}
    />
  );
}

function UpdateReleases({
  environmentId,
  updateVersion,
  state,
  tooltip,
  fallback,
  onOpenChangelog,
}: UpdateReleasesProps) {
  const releases = useEnvironmentQuery(forkReleases({ environmentId, input: {} }));
  if (releases.error !== null) return fallback;
  if (releases.data === null) return <Reading tooltip={tooltip} />;
  const inUpdate = releasesInUpdate(releases.data.releases, state.currentVersion, updateVersion);
  if (inUpdate.length === 0) return fallback;
  return (
    <UpdateCommits
      environmentId={environmentId}
      // Each release has at least one commit, so the newest releases fill the list.
      tags={inUpdate.slice(0, UPDATE_CHANGES_LIMIT).map((release) => release.tag)}
      releaseCount={inUpdate.length}
      tooltip={tooltip}
      fallback={fallback}
      onOpenChangelog={onOpenChangelog}
    />
  );
}

function UpdateCommits({
  environmentId,
  tags,
  releaseCount,
  tooltip,
  fallback,
  onOpenChangelog,
}: {
  readonly environmentId: EnvironmentId;
  /** Newest first. */
  readonly tags: ReadonlyArray<string>;
  readonly releaseCount: number;
  readonly tooltip: string;
  readonly fallback: ReactNode;
  readonly onOpenChangelog: () => void;
}) {
  const tagsKey = tags.join("\n");
  const changesAtom = useMemo(
    () =>
      Atom.make((get) =>
        tagsKey
          .split("\n")
          .map((tag) => get(forkReleaseChanges({ environmentId, input: { tag } }))),
      ),
    [environmentId, tagsKey],
  );
  const results = useAtomValue(changesAtom);
  if (results.some(AsyncResult.isFailure)) return fallback;
  const changes = results.flatMap((result) => Option.toArray(AsyncResult.value(result)));
  if (changes.length < results.length) return <Reading tooltip={tooltip} />;

  const commits: ForkCommit[] = changes.flatMap((change) => change.commits);
  const shown = commits.slice(0, UPDATE_CHANGES_LIMIT);
  const hiddenCommits = commits.length - shown.length;
  const unreadReleases = releaseCount - tags.length;

  return (
    <PopupBody tooltip={tooltip}>
      <div className="flex shrink-0 px-1 pt-1">
        <Hint
          label={`${releaseCount} new ${releaseCount === 1 ? "release" : "releases"}`}
          render={
            <span className="flex items-center gap-1 text-muted-foreground text-xs tabular-nums" />
          }
        >
          <TagIcon aria-hidden className="size-3" />
          {releaseCount}
        </Hint>
      </div>
      <div className="min-h-0 overflow-y-auto">
        <ChangelogClockProvider>
          <CommitList commits={shown} />
        </ChangelogClockProvider>
      </div>
      {hiddenCommits > 0 || unreadReleases > 0 ? (
        <div className="shrink-0 px-1 pt-1">
          <Hint
            label={moreLabel(hiddenCommits, unreadReleases)}
            render={<Button size="xs" variant="ghost" onClick={onOpenChangelog} />}
          >
            {hiddenCommits > 0 ? (
              <span className="flex items-center gap-1 tabular-nums">
                <GitCommitHorizontalIcon aria-hidden className="size-3" />+{hiddenCommits}
              </span>
            ) : null}
            {unreadReleases > 0 ? (
              <span className="flex items-center gap-1 tabular-nums">
                <TagIcon aria-hidden className="size-3" />+{unreadReleases}
              </span>
            ) : null}
            <ChevronRightIcon aria-hidden className="size-3" />
          </Hint>
        </div>
      ) : null}
    </PopupBody>
  );
}

function Reading({ tooltip }: { readonly tooltip: string }) {
  return (
    <PopupBody tooltip={tooltip}>
      <p className="flex items-center gap-2 px-1 pt-1 text-muted-foreground text-xs">
        <Spinner size="xs" tone="muted" />
        Reading the changes from GitHub…
      </p>
    </PopupBody>
  );
}

function PopupBody({
  tooltip,
  children,
}: {
  readonly tooltip: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex max-h-[min(32rem,calc(var(--available-height)-3rem))] min-h-0 w-[min(26rem,calc(100vw-2rem))] flex-col text-left">
      <div className="shrink-0 px-1 text-sm leading-5 font-medium">{tooltip}</div>
      {children}
    </div>
  );
}

/** The accessible name and tooltip of the button that opens the changelog. */
function moreLabel(hiddenCommits: number, unreadReleases: number): string {
  const commits = `${hiddenCommits} more ${hiddenCommits === 1 ? "commit" : "commits"}`;
  const releases = `${unreadReleases} older ${unreadReleases === 1 ? "release" : "releases"}`;
  const parts = [
    ...(hiddenCommits > 0 ? [commits] : []),
    ...(unreadReleases > 0 ? [releases] : []),
  ];
  return `${parts.join(" and ")} in the changelog`;
}

import {
  type ProjectIconColor,
  ProviderDriverKind,
  type SlotLayout,
  type ThreadCardElement,
} from "@t3tools/contracts";
import type { ThreadCardInfo } from "@t3tools/client-runtime/thread-card-info";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { FolderGit2Icon, PinIcon, TerminalIcon } from "lucide-react";

import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectMonogram } from "../ProjectMonogram";
import {
  THREAD_CARD_ACTIVE_CLASS,
  THREAD_CARD_IDLE_CLASS,
  THREAD_CARD_PIN_CLASS,
  THREAD_CARD_STATUS_LABEL_CLASS,
  THREAD_CARD_SURFACE_CLASS,
  THREAD_CARD_TITLE_CLASS,
  ThreadCardBranch,
  threadCardInfoNodes,
  ThreadCardDiff,
  type ThreadCardElementNodes,
  ThreadCardLayoutContent,
  ThreadCardProjectLabel,
  type ThreadCardStatus,
  ThreadCardStatusBadge,
} from "../sidebar/threadCardParts";
import {
  terminalStatusFromRunningIds,
  ThreadPullRequestBadgeControl,
} from "../ThreadStatusIndicators";
import { InlineButton } from "../ui/button";

interface SampleThread {
  readonly title: string;
  readonly project: {
    readonly name: string;
    readonly monogram: string;
    readonly color: ProjectIconColor;
  };
  readonly branch: string | null;
  readonly worktree: boolean;
  /** Null shows the time label, as an idle card does. */
  readonly status: (ThreadCardStatus & { readonly elapsed: string | null }) | null;
  readonly time: string;
  readonly pinned: boolean;
  readonly terminal: boolean;
  readonly pullRequest: number | null;
  readonly diff: { readonly insertions: number; readonly deletions: number } | null;
  readonly remote: boolean;
  readonly model: string;
  readonly unread: boolean;
  readonly info: ThreadCardInfo;
}

const HOUR_MS = 3_600_000;
const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS).toISOString();

const SAMPLE_THREADS: ReadonlyArray<SampleThread> = [
  {
    title: "Shrinking Thread Card Size Setting",
    project: { name: "yarden-zamir/t3code", monogram: "T3", color: "blue" },
    branch: "smaller-thread-cards-setting",
    worktree: true,
    status: { label: "Working", icon: "working", className: "text-info", elapsed: "2m" },
    time: "2m",
    pinned: false,
    terminal: true,
    pullRequest: null,
    diff: { insertions: 1476, deletions: 423 },
    remote: false,
    model: "Opus 5.5",
    unread: false,
    info: {
      access: "full-access",
      plan: null,
      backgroundTaskCount: 2,
      goal: { objective: "Ship compact thread cards", status: "active" },
      lineage: null,
      limitResetAt: null,
      error: null,
      messageCount: 128,
      createdAt: hoursAgo(2),
    },
  },
  {
    title: "Finish gateway cloud tunnel branch and open its PR",
    project: { name: "cli-utils", monogram: "CU", color: "gray" },
    branch: "feat/yarden/gateway-cloud-tunnel",
    worktree: true,
    status: null,
    time: "39m",
    pinned: true,
    terminal: false,
    pullRequest: 58,
    diff: null,
    remote: true,
    model: "Sonnet 5.5",
    unread: true,
    info: {
      access: "approval-required",
      plan: "ready",
      backgroundTaskCount: null,
      goal: null,
      lineage: "fork",
      limitResetAt: null,
      error: null,
      messageCount: 34,
      createdAt: hoursAgo(72),
    },
  },
  {
    title: "Neo-brutalism style skill",
    project: { name: "dotfiles", monogram: "DF", color: "green" },
    branch: "main",
    worktree: false,
    status: {
      label: "Waiting",
      icon: "waiting",
      className: "text-muted-foreground",
      elapsed: "19m",
    },
    time: "19m",
    pinned: false,
    terminal: false,
    pullRequest: null,
    diff: null,
    remote: false,
    model: "Fable 5.1",
    unread: false,
    info: {
      access: "auto",
      plan: "mode",
      backgroundTaskCount: null,
      goal: null,
      lineage: "subagent",
      limitResetAt: new Date(Date.now() + 2 * HOUR_MS).toISOString(),
      error: "Usage limit reached",
      messageCount: 9,
      createdAt: hoursAgo(0.3),
    },
  },
];

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
/** The sidebar colours a running terminal through this indicator; one id stands for one process. */
const TERMINAL_RUNNING_COLOR_CLASS = terminalStatusFromRunningIds(["preview"])!.colorClass;

function sampleNodes(
  sample: SampleThread,
  timestampFormat: TimestampFormat,
): ThreadCardElementNodes {
  return {
    ...threadCardInfoNodes({
      info: sample.info,
      modelLabel: sample.model,
      unread: sample.unread,
      timestampFormat,
    }),
    favicon: (
      <ProjectMonogram
        text={sample.project.monogram}
        color={sample.project.color}
        className="size-4 shrink-0"
      />
    ),
    project: (
      <ThreadCardProjectLabel name={sample.project.name} recede={false} className="shrink" />
    ),
    branch:
      sample.branch === null ? null : (
        <ThreadCardBranch
          branch={sample.branch}
          leading={
            sample.worktree ? <FolderGit2Icon className="size-3 text-muted-foreground/40" /> : null
          }
        />
      ),
    title: (
      <span className={cn(THREAD_CARD_TITLE_CLASS, "truncate font-medium text-foreground/90")}>
        {sample.title}
      </span>
    ),
    pin: sample.pinned ? (
      <PinIcon aria-label="Pinned" role="img" className={THREAD_CARD_PIN_CLASS} />
    ) : null,
    status: (
      <span className="relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs">
        <span data-sidebar-status={sample.status?.label} className={THREAD_CARD_STATUS_LABEL_CLASS}>
          {sample.status === null ? (
            sample.time
          ) : (
            <ThreadCardStatusBadge
              status={sample.status}
              trailing={
                sample.status.elapsed === null ? null : (
                  <span aria-hidden>{sample.status.elapsed}</span>
                )
              }
            />
          )}
        </span>
      </span>
    ),
    terminal: sample.terminal ? (
      <span className={cn("inline-flex shrink-0 items-center", TERMINAL_RUNNING_COLOR_CLASS)}>
        <TerminalIcon className="size-3.5" />
      </span>
    ) : null,
    pullRequest:
      sample.pullRequest === null ? null : (
        <ThreadPullRequestBadgeControl
          render={<InlineButton />}
          badge={null}
          pullRequests={[]}
          number={sample.pullRequest}
          url="https://github.com"
          status={null}
          onOpenList={() => {}}
          onOpenPullRequest={(event) => event.preventDefault()}
        />
      ),
    diff:
      sample.diff === null ? null : (
        <ThreadCardDiff insertions={sample.diff.insertions} deletions={sample.diff.deletions} />
      ),
    machine: sample.remote ? (
      <span className="inline-flex shrink-0 items-center text-sidebar-muted-foreground/70">
        <EnvironmentMachineIcon aria-hidden kind="cloud" className="size-3.5" />
      </span>
    ) : null,
    providers: (
      <ProviderInstanceIcon
        driverKind={CLAUDE_DRIVER}
        displayName="Claude"
        iconClassName="size-3.5 opacity-60"
        badgeClassName="right-[-0.1875rem] bottom-[-0.1875rem] h-3 min-w-3 px-0.5 text-5xs"
      />
    ),
  };
}

/**
 * Sample cards built from the sidebar's own card parts and markup
 * (`data-thread-item`, `sidebar-row-card`, `data-sidebar-status`), so the
 * active theme and its CSS style them as they style the sidebar.
 */
export function ThreadCardLayoutPreview(props: {
  layout: SlotLayout<ThreadCardElement>;
  /** Mobile previews at phone width. The phone draws its cards natively, so this shows the arrangement only. */
  surface: "desktop" | "mobile";
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  return (
    <div
      className="rounded-md border bg-sidebar p-2 text-sidebar-foreground"
      style={{
        width: props.surface === "desktop" ? "var(--sidebar-width, 16rem)" : "24rem",
        maxWidth: "100%",
      }}
    >
      <ul className="m-0 flex list-none flex-col p-0">
        {SAMPLE_THREADS.map((sample, index) => (
          <li key={sample.title} data-thread-item={`preview:${index}`} className="list-none py-0.5">
            <div
              data-testid="sidebar-row-card"
              aria-current={index === 0 ? "page" : undefined}
              className={cn(
                THREAD_CARD_SURFACE_CLASS,
                "cursor-default",
                index === 0 ? THREAD_CARD_ACTIVE_CLASS : THREAD_CARD_IDLE_CLASS,
              )}
            >
              <ThreadCardLayoutContent
                layout={props.layout}
                nodes={sampleNodes(sample, timestampFormat)}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

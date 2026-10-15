import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import type { ThreadCardInfo } from "@t3tools/client-runtime/thread-card-info";
import type { SlotLayout, ThreadCardElement } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  BotIcon,
  CalendarIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  ClockIcon,
  GitForkIcon,
  LayersIcon,
  ListTodoIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
  ShieldQuestionIcon,
  TargetIcon,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel, formatShortTimestamp } from "../../timestampFormat";
import { runtimeModeConfig } from "../chat/runtimeModeConfig";
import { SlotLayoutView } from "../SlotLayoutView";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Presentational parts of the sidebar thread card. The sidebar row and the
 * card builder preview both render these, so theme CSS that targets the card
 * (its classes and data attributes) styles the preview the same way.
 */

/** The clickable card surface. Carries `data-testid="sidebar-row-card"` in both users. */
export const THREAD_CARD_SURFACE_CLASS =
  "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
export const THREAD_CARD_ACTIVE_CLASS = "bg-sidebar-row-active text-sidebar-foreground";
export const THREAD_CARD_IDLE_CLASS =
  "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover";
/** Padding of the card content; a custom layout adds no height of its own. */
export const THREAD_CARD_CONTENT_CLASS =
  "relative z-10 px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)";
export const THREAD_CARD_TITLE_CLASS =
  "min-w-0 flex-1 text-sm transition-opacity motion-reduce:transition-none";
/** The element that carries `data-sidebar-status`; themes draw it as a sticker. */
export const THREAD_CARD_STATUS_LABEL_CLASS =
  "flex items-center self-center justify-self-end tabular-nums text-secondary-label transition-opacity";
export const THREAD_CARD_PIN_CLASS = "size-3 shrink-0 text-muted-foreground/65";

export type ThreadCardStatusIcon =
  | "working"
  | "waiting"
  | "input"
  | "approval"
  | "failed"
  | "done"
  | "woke";

export interface ThreadCardStatus {
  readonly label: string;
  readonly icon: ThreadCardStatusIcon | null;
  readonly className: string;
}

/** The status label inside the `data-sidebar-status` element, for every status but Woke. */
export function ThreadCardStatusBadge(props: { status: ThreadCardStatus; trailing?: ReactNode }) {
  const { status } = props;
  return (
    <span className={cn("inline-flex items-center gap-1 font-medium", status.className)}>
      {status.icon === "working" ? (
        <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
      ) : status.icon === "waiting" ? (
        <CircleDotDashedIcon aria-hidden className="size-4 shrink-0" />
      ) : status.icon === "input" ? (
        <MessageCircleQuestionIcon aria-hidden className="size-4 shrink-0" />
      ) : status.icon === "approval" ? (
        <ShieldQuestionIcon aria-hidden className="size-4 shrink-0" />
      ) : status.icon === "failed" ? (
        <CircleAlertIcon aria-hidden className="size-4 shrink-0" />
      ) : status.icon === "done" ? (
        <CircleCheckIcon aria-hidden className="size-4 shrink-0" />
      ) : null}
      {/* The label alone is the live region: a role="status" wrapper around a
          ticking duration would make screen readers announce every second. */}
      <span role="status">{status.label}</span>
      {props.trailing}
    </span>
  );
}

function threadCardProjectLabelClassName(recede: boolean): string {
  return cn(
    "min-w-0 truncate text-secondary-label text-xs",
    recede ? "font-normal" : "font-medium",
  );
}

/** The branch name with its leading icon (worktree or machine). */
export function ThreadCardBranch(props: { branch: string; leading: ReactNode }) {
  return (
    <>
      {props.leading}
      <span className="flex min-w-0 flex-1 text-muted-foreground/40">
        <MiddleTruncate value={props.branch} showTitle={false} />
      </span>
    </>
  );
}

export function ThreadCardDiff(props: { insertions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono">
      <span className="text-diff-addition-foreground">+{formatDiffCount(props.insertions)}</span>{" "}
      <span className="text-diff-deletion-foreground">−{formatDiffCount(props.deletions)}</span>
    </span>
  );
}

export function ThreadCardProjectLabel(props: {
  name: string;
  recede: boolean;
  className?: string;
}) {
  return (
    <span className={cn(threadCardProjectLabelClassName(props.recede), props.className)}>
      {props.name}
    </span>
  );
}

/** What each card element shows for one thread; null leaves the element out. */
export type ThreadCardElementNodes = { readonly [Element in ThreadCardElement]: ReactNode };

/** The elements that `threadCardInfoNodes` fills in. */
export type ThreadCardInfoElement =
  | "model"
  | "access"
  | "plan"
  | "backgroundTasks"
  | "goal"
  | "lineage"
  | "limitReset"
  | "error"
  | "unread"
  | "age"
  | "messageCount";

/**
 * Wraps an element for its place in a custom layout. The `display: contents`
 * span adds no box; its `data-thread-card-element` lets themes style one
 * element, for example `[data-thread-card-element="terminal"] svg`.
 */
function layoutElement(element: ThreadCardElement, node: ReactNode): ReactNode {
  if (node === null || node === undefined) return null;
  return (
    <span data-thread-card-element={element} className="contents">
      {sizedElement(element, node)}
    </span>
  );
}

function sizedElement(element: ThreadCardElement, node: ReactNode): ReactNode {
  switch (element) {
    case "branch":
      // Keeps half the group so a long project name cannot squeeze the branch away.
      return <span className="flex min-w-[50%] flex-1 items-center gap-1.5 text-xs">{node}</span>;
    case "title":
      return <span className="flex min-w-0 flex-1 items-center gap-1.5">{node}</span>;
    case "providers":
      return (
        <span aria-hidden className="pointer-events-none inline-flex shrink-0">
          {node}
        </span>
      );
    case "favicon":
    case "project":
    case "pin":
    case "status":
    case "terminal":
    case "pullRequest":
    case "diff":
    case "machine":
    case "model":
    case "access":
    case "plan":
    case "backgroundTasks":
    case "goal":
    case "lineage":
    case "limitReset":
    case "error":
    case "unread":
    case "age":
    case "messageCount":
      return node;
  }
}

/** The content of a card with a user-built layout. */
export function ThreadCardLayoutContent(props: {
  layout: SlotLayout<ThreadCardElement>;
  nodes: ThreadCardElementNodes;
}) {
  return (
    <SlotLayoutView
      layout={props.layout}
      renderElement={(element) => layoutElement(element, props.nodes[element])}
      className={THREAD_CARD_CONTENT_CLASS}
    />
  );
}

/** "3d" for "3 days ago" and "now" for "just now", as the sidebar status shows time. */
export function compactRelativeTimeLabel(isoDate: string): string {
  const label = formatRelativeTimeLabel(isoDate);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

/** A small icon, with optional text, that explains itself on hover. */
function ThreadCardMeta(props: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  text?: ReactNode;
  className?: string | undefined;
}) {
  const Icon = props.icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={props.label}
            className={cn(
              "inline-flex min-w-0 shrink-0 items-center gap-0.5 text-muted-foreground",
              props.className,
            )}
          />
        }
      >
        <Icon aria-hidden className="size-3 shrink-0" />
        {props.text === undefined ? null : <span className="truncate">{props.text}</span>}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

const PLAN_LABELS = { mode: "Plan mode", ready: "Plan ready for review" } as const;

/** The optional elements that show thread facts, from `resolveThreadCardInfo` and client state. */
export function threadCardInfoNodes(input: {
  info: ThreadCardInfo;
  modelLabel: string;
  unread: boolean;
  timestampFormat: TimestampFormat;
}): Pick<ThreadCardElementNodes, ThreadCardInfoElement> {
  const { info } = input;
  const access = runtimeModeConfig[info.access];
  return {
    model: (
      <span className="min-w-0 max-w-[40%] shrink truncate text-muted-foreground">
        {input.modelLabel}
      </span>
    ),
    access: <ThreadCardMeta icon={access.icon} label={access.label} />,
    plan:
      info.plan === null ? null : (
        <ThreadCardMeta
          icon={ListTodoIcon}
          label={PLAN_LABELS[info.plan]}
          className={info.plan === "ready" ? "text-info" : undefined}
        />
      ),
    backgroundTasks:
      info.backgroundTaskCount === null ? null : (
        <ThreadCardMeta
          icon={LayersIcon}
          label={`${info.backgroundTaskCount} background ${info.backgroundTaskCount === 1 ? "task" : "tasks"}`}
          text={info.backgroundTaskCount}
        />
      ),
    goal:
      info.goal === null ? null : (
        <ThreadCardMeta
          icon={TargetIcon}
          label={`Goal (${info.goal.status.replaceAll("_", " ")}): ${info.goal.objective}`}
          text={info.goal.objective}
          className="max-w-[45%] shrink"
        />
      ),
    lineage:
      info.lineage === null ? null : info.lineage === "fork" ? (
        <ThreadCardMeta icon={GitForkIcon} label="Forked from another thread" />
      ) : (
        <ThreadCardMeta icon={BotIcon} label="Subagent of another thread" />
      ),
    limitReset:
      info.limitResetAt === null ? null : (
        <ThreadCardMeta
          icon={ClockIcon}
          label={`Usage limit resets at ${formatShortTimestamp(info.limitResetAt, input.timestampFormat)}`}
          text={formatShortTimestamp(info.limitResetAt, input.timestampFormat)}
          className="text-warning"
        />
      ),
    error:
      info.error === null ? null : (
        <Tooltip>
          <TooltipTrigger
            render={<span className="min-w-0 max-w-[50%] shrink truncate text-error" />}
          >
            {info.error}
          </TooltipTrigger>
          <TooltipPopup side="top">{info.error}</TooltipPopup>
        </Tooltip>
      ),
    unread: input.unread ? (
      <span role="img" aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-primary" />
    ) : null,
    age: (
      <ThreadCardMeta
        icon={CalendarIcon}
        label={`Started ${formatShortTimestamp(info.createdAt, input.timestampFormat)}`}
        text={compactRelativeTimeLabel(info.createdAt)}
      />
    ),
    messageCount:
      info.messageCount === null ? null : (
        <ThreadCardMeta
          icon={MessageSquareIcon}
          label={`${info.messageCount} messages`}
          text={info.messageCount}
        />
      ),
  };
}

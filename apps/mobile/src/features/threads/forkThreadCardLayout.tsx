/**
 * Fork: a user-built thread card (the `threadCardLayouts` setting, mobile
 * part). `ThreadListV2Row` renders the upstream card and swaps in this one
 * when a layout is set, so the upstream card markup stays as upstream has it.
 * Each element keeps the look the built-in card gives it.
 */
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { snoozeWakeLabel } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import {
  resolveThreadCardInfo,
  type ThreadCardInfo,
} from "@t3tools/client-runtime/thread-card-info";
import type {
  EnvironmentMachineKind,
  MobileThreadCardElement,
  MobileThreadCardLayout,
} from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { Fragment, type ReactNode } from "react";
import { View } from "react-native";

import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ProviderIcon, ProviderInstanceIcon } from "../../components/ProviderIcon";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import type { ThreadPrPresentation } from "../../state/thread-pr-presentation";
import { QueuedMessageIcon } from "./queued-message-icon";
import type { ThreadRowProviderInstance } from "./thread-provider-instance";
import {
  THREAD_LIST_V2_MONO_FONT as MONO_FONT,
  getThreadListV2RowAppearance,
  selectedThreadRowColors,
} from "./thread-list-v2-row-appearance";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { ThreadSearchMatchExcerpt } from "./thread-search-match";
import { RUNTIME_MODE_DETAILS } from "./thread-settings-options";
import type { ThreadListV2Status } from "./threadListV2";

const PLAN_LABELS = { mode: "Plan mode", ready: "Plan ready" } as const;

export function ForkThreadCardLayout(props: {
  readonly layout: MobileThreadCardLayout;
  /** The props of the row that shows this card. */
  readonly row: {
    readonly thread: EnvironmentThreadShell;
    readonly hasQueuedMessages?: boolean;
    readonly project: EnvironmentProject | null;
    readonly projectTitle?: string;
    readonly environmentLabel: string | null;
    readonly environmentMachine?: EnvironmentMachineKind;
    readonly searchMatch?: EnvironmentThreadSearchMatch;
    readonly searchQuery?: string;
  };
  /** Values the row already computed for its built-in card. */
  readonly status: ThreadListV2Status;
  readonly statusLabel:
    | {
        readonly label: string;
        readonly icon: AppSymbolName;
        readonly className: string;
        readonly iconTintClassName: string;
      }
    | undefined;
  readonly timeLabel: string;
  readonly selected: boolean;
  readonly recede: boolean;
  readonly isUnread: boolean;
  readonly pinnedRow: boolean;
  readonly sidebarPane: boolean;
  readonly rowAppearance: ReturnType<typeof getThreadListV2RowAppearance>;
  readonly pr: ThreadPrPresentation | null;
  readonly providerInstance: ThreadRowProviderInstance | null;
  readonly providerDrivers: ReadonlyArray<Parameters<typeof ProviderIcon>[0]["provider"]>;
  readonly providerIconUrl: string | undefined;
}) {
  const {
    row,
    status,
    statusLabel,
    timeLabel,
    selected,
    recede,
    isUnread,
    pinnedRow,
    sidebarPane,
    rowAppearance,
    pr,
    providerInstance,
    providerDrivers,
    providerIconUrl,
  } = props;
  const thread = row.thread;

  // The pieces below serve both the built-in card and a user layout, so each
  // element keeps one look whichever path places it.
  const mutedTextClassName = selected
    ? selectedThreadRowColors.mutedForegroundClassName
    : rowAppearance.mutedForegroundClassName;
  const tertiaryTextClassName = selected
    ? selectedThreadRowColors.mutedForegroundClassName
    : rowAppearance.tertiaryForegroundClassName;
  const projectTitle = row.projectTitle ?? row.project?.title ?? "";
  const lastError =
    (status === "failed" || status === "limited") && thread.runtime?.lastError
      ? thread.runtime.lastError
      : null;

  const favicon = row.project ? (
    <ProjectFavicon
      environmentId={thread.environmentId}
      faviconPath={row.project.faviconPath}
      projectIcon={row.project.projectIcon}
      size={15}
      projectTitle={row.project.title}
      workspaceRoot={row.project.workspaceRoot}
    />
  ) : null;
  const projectText = (flexClassName: string) => (
    <Text
      className={cn(flexClassName, "text-sm font-t3-medium", mutedTextClassName)}
      numberOfLines={1}
    >
      {projectTitle}
    </Text>
  );
  const queuedIcon = row.hasQueuedMessages ? <QueuedMessageIcon selected={selected} /> : null;
  const pinGlyph = pinnedRow ? (
    <SymbolView
      name="pin"
      size={11}
      tintColorClassName={rowAppearance.mutedIconTintClassName}
      type="monochrome"
    />
  ) : null;
  const statusOrTime = statusLabel ? (
    <View className="flex-row items-center gap-1">
      <SymbolView
        name={statusLabel.icon}
        size={13}
        tintColorClassName={
          selected ? selectedThreadRowColors.iconTintClassName : statusLabel.iconTintClassName
        }
        type="monochrome"
        weight="semibold"
      />
      <Text
        className={cn(
          "text-xs font-t3-bold",
          selected ? selectedThreadRowColors.foregroundClassName : statusLabel.className,
        )}
      >
        {statusLabel.label}
      </Text>
    </View>
  ) : (
    <Text
      className={cn(
        "text-xs tabular-nums",
        selected
          ? selectedThreadRowColors.foregroundClassName
          : rowAppearance.tertiaryForegroundClassName,
      )}
    >
      {timeLabel}
    </Text>
  );
  const titleText = (numberOfLines: number, spacingClassName?: string) => (
    <Text
      className={cn(
        spacingClassName,
        "text-base",
        !recede && "font-t3-medium",
        selected ? selectedThreadRowColors.foregroundClassName : rowAppearance.foregroundClassName,
      )}
      numberOfLines={numberOfLines}
    >
      {thread.title}
    </Text>
  );
  const searchExcerpt = row.searchMatch ? (
    <View className="mt-1">
      <ThreadSearchMatchExcerpt
        sidebar={sidebarPane}
        match={row.searchMatch}
        query={row.searchQuery ?? ""}
        selected={selected}
      />
    </View>
  ) : null;
  const lastErrorText = (flexClassName: string, text: string) => (
    <Text
      className={cn(
        flexClassName,
        "text-xs",
        selected
          ? selectedThreadRowColors.mutedForegroundClassName
          : status === "limited"
            ? "text-warning-foreground"
            : "text-danger-foreground",
      )}
      numberOfLines={1}
    >
      {text}
    </Text>
  );
  // Nested texts share one truncating line; a glyph cannot live inside it
  // without breaking truncation, so glyphs sit next to this line.
  const truncatingLine = (children: ReactNode) => (
    <Text className={cn("shrink text-xs", mutedTextClassName)} numberOfLines={1}>
      {children}
    </Text>
  );
  const branchText = thread.branch ? (
    <Text className={cn("text-xs", mutedTextClassName)} style={{ fontFamily: MONO_FONT }}>
      {thread.branch}
    </Text>
  ) : null;
  const environmentText = row.environmentLabel ? (
    <Text className={cn("text-xs", tertiaryTextClassName)}>{row.environmentLabel}</Text>
  ) : null;
  const machineSymbol =
    row.environmentLabel && row.environmentMachine ? (
      <EnvironmentMachineSymbol
        kind={row.environmentMachine}
        size={11}
        tintColorClassName={
          selected
            ? selectedThreadRowColors.mutedIconTintClassName
            : rowAppearance.tertiaryIconTintClassName
        }
      />
    ) : null;
  const prBadge = pr ? (
    <View className="flex-row items-center gap-1" accessibilityLabel={pr.accessibilityLabel}>
      <SymbolView
        name={pr.kind === "stack" ? PullRequestGlyph.stack : PullRequestGlyph.pullRequest}
        size={12}
        tintColorClassName={
          pr.state === null || pr.isDraft
            ? rowAppearance.mutedIconTintClassName
            : pr.state === "open"
              ? "accent-adaptive-emerald-600-400"
              : pr.state === "closed"
                ? "accent-adaptive-rose-600-400"
                : "accent-adaptive-violet-600-400"
        }
      />
      <Text
        accessibilityLabel={pr.accessibilityLabel}
        className={cn("text-xs", pr.textClassName)}
        style={{ fontFamily: MONO_FONT }}
      >
        {pr.label}
      </Text>
    </View>
  ) : null;
  const providerIcons = providerInstance ? (
    <View className="flex-row items-center">
      {providerDrivers.slice(0, -1).map((driver, index) => (
        <View key={`${driver}:${index}`} className="-mr-1 opacity-30">
          <ProviderIcon provider={driver} size={12} />
        </View>
      ))}
      <ProviderInstanceIcon
        iconUrl={providerIconUrl}
        provider={providerInstance.driverKind}
        size={14}
        displayName={providerInstance.displayName}
        accentColor={providerInstance.accentColor}
        showBadge={providerInstance.showBadge}
        surfaceColor={rowAppearance.providerIconSurfaceColor}
      />
    </View>
  ) : null;

  const mutedIconTintClassName = selected
    ? selectedThreadRowColors.mutedIconTintClassName
    : rowAppearance.mutedIconTintClassName;
  // A small glyph with optional text, the shape of every optional layout element.
  const metaItem = (input: {
    readonly icon: AppSymbolName;
    readonly label: string;
    readonly text?: string | number;
    /** Lets long text truncate instead of pushing the row's other items out. */
    readonly shrink?: boolean;
    readonly textClassName?: string;
    readonly iconTintClassName?: string;
  }) => (
    <View
      accessible
      accessibilityLabel={input.label}
      className={cn("flex-row items-center gap-1", input.shrink && "min-w-0 shrink")}
    >
      <SymbolView
        name={input.icon}
        size={11}
        tintColorClassName={
          selected ? mutedIconTintClassName : (input.iconTintClassName ?? mutedIconTintClassName)
        }
        type="monochrome"
      />
      {input.text === undefined ? null : (
        <Text
          className={cn(
            "text-xs tabular-nums",
            input.shrink && "shrink",
            selected ? mutedTextClassName : (input.textClassName ?? mutedTextClassName),
          )}
          numberOfLines={1}
        >
          {input.text}
        </Text>
      )}
    </View>
  );

  // The relative times (age, limit reset) refresh only when the thread changes:
  // the React Compiler caches them on `info`, not on the list's minute tick.
  // Precompute them on the list item, as timeLabel is, if a stale value shows.
  const renderLayoutElement = (
    element: MobileThreadCardElement,
    info: ThreadCardInfo,
  ): ReactNode => {
    switch (element) {
      case "favicon":
        return favicon;
      case "project":
        return projectTitle ? projectText("shrink") : null;
      case "branch":
        // A failed or limited thread shows its error in the branch slot, as
        // the built-in card does on its branch line.
        if (lastError) return lastErrorText("shrink", lastError);
        return branchText ? truncatingLine(branchText) : null;
      case "title":
        // One line keeps a custom card compact; a search hit sits under it.
        return (
          <View className="min-w-0 shrink">
            {titleText(1)}
            {searchExcerpt}
          </View>
        );
      case "pin":
        return pinGlyph;
      case "status":
        return (
          <>
            {queuedIcon}
            {statusOrTime}
          </>
        );
      case "pullRequest":
        return prBadge;
      case "machine":
        return environmentText ? (
          <View className="flex-row items-center gap-1">
            {truncatingLine(environmentText)}
            {machineSymbol}
          </View>
        ) : null;
      case "providers":
        return providerIcons;
      case "model":
        return (
          <Text className={cn("min-w-0 shrink text-xs", mutedTextClassName)} numberOfLines={1}>
            {formatModelSlugName(thread.modelSelection.model)}
          </Text>
        );
      case "access": {
        const access = RUNTIME_MODE_DETAILS[info.access];
        return metaItem({ icon: access.icon, label: access.label });
      }
      case "plan":
        return info.plan === null
          ? null
          : metaItem({
              icon: "checklist",
              label: PLAN_LABELS[info.plan],
              iconTintClassName: info.plan === "ready" ? "accent-adaptive-sky-600-400" : undefined,
            });
      case "backgroundTasks":
        return info.backgroundTaskCount === null
          ? null
          : metaItem({
              // Background tasks, not a pull request: the same layers glyph as the web card.
              // oxlint-disable-next-line t3code/no-mobile-pull-request-glyph-literals
              icon: "square.3.layers.3d",
              label: `${info.backgroundTaskCount} background ${info.backgroundTaskCount === 1 ? "task" : "tasks"}`,
              text: info.backgroundTaskCount,
            });
      case "goal":
        return info.goal === null
          ? null
          : metaItem({
              icon: "target",
              label: `Goal (${info.goal.status.replaceAll("_", " ")}): ${info.goal.objective}`,
              text: info.goal.objective,
              shrink: true,
            });
      case "lineage":
        return info.lineage === null
          ? null
          : info.lineage === "fork"
            ? metaItem({ icon: "arrow.triangle.branch", label: "Forked from another thread" })
            : metaItem({ icon: "cpu", label: "Subagent of another thread" });
      case "limitReset": {
        if (info.limitResetAt === null) return null;
        const resetIn = snoozeWakeLabel(info.limitResetAt, { now: new Date().toISOString() });
        return metaItem({
          icon: "clock",
          label: resetIn === "now" ? "Usage limit resets now" : `Usage limit resets in ${resetIn}`,
          text: resetIn,
          textClassName: "text-warning-foreground",
          iconTintClassName: "accent-warning-foreground",
        });
      }
      case "error":
        return info.error === null ? null : lastErrorText("min-w-0 shrink", info.error);
      case "unread":
        return isUnread ? (
          <View
            accessible
            accessibilityLabel="Unread"
            accessibilityRole="image"
            className="size-1.5 rounded-full bg-primary"
          />
        ) : null;
      case "age": {
        const age = relativeTime(info.createdAt);
        return metaItem({ icon: "calendar", label: `Started ${age} ago`, text: age });
      }
      case "messageCount":
        return info.messageCount === null
          ? null
          : metaItem({
              icon: "bubble.left",
              label: `${info.messageCount} ${info.messageCount === 1 ? "message" : "messages"}`,
              text: info.messageCount,
            });
    }
  };

  const cardLayout = props.layout;
  const layoutInfo = resolveThreadCardInfo(thread);
  return (
    <View className="gap-1">
      {cardLayout.rows.map((layoutRow, rowIndex) => (
        <View key={rowIndex} className="flex-row items-center gap-2">
          <View className="min-w-0 flex-1 flex-row items-center gap-1.5">
            {layoutRow.start.map((element) => (
              <Fragment key={element}>{renderLayoutElement(element, layoutInfo)}</Fragment>
            ))}
          </View>
          {layoutRow.end.length > 0 ? (
            <View className="shrink-0 flex-row items-center gap-1.5">
              {layoutRow.end.map((element) => (
                <Fragment key={element}>{renderLayoutElement(element, layoutInfo)}</Fragment>
              ))}
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

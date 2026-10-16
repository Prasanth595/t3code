import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ProviderThreadId,
  ThreadContextBreakdown,
  ThreadContextUsage,
  ThreadId,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, Minimize2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  buildContextBreakdownView,
  formatContextHeadlinePercentage,
  formatContextPercentage,
  type ContextBreakdownGroup,
  type ContextBreakdownRow,
  type ContextSwatch,
} from "./ThreadContextSection.logic";
import {
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
  THREAD_DETAILS_PANEL_ROW_TEXT_CLASS,
} from "./threadDetailsPanelStyles";
import { useThreadContextAttentionStore } from "./threadContextAttention";

const SWATCH_CLASS: Record<ContextSwatch, string> = {
  blue: "bg-blue-500",
  orange: "bg-orange-500",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  violet: "bg-violet-500",
  pink: "bg-pink-500",
  sky: "bg-sky-400",
  lime: "bg-lime-500",
  buffer: "bg-muted-foreground/45",
  free: "bg-muted-foreground/25",
  deferred: "bg-muted-foreground/30",
};

/**
 * What fills the thread's context window. Providers that can measure their own
 * context (Claude) list categories from the live session; every other provider
 * splits the latest usage report it sent.
 */
export function ThreadContextSection(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  /** The thread's active provider thread; null before any provider has run. */
  providerThreadId: ProviderThreadId | null;
  snapshot: ContextWindowSnapshot | null;
  /** Categories the provider saved after its last turn ("Remember context breakdown"). */
  savedBreakdown: ThreadContextBreakdown | null;
  /** Holds refreshes while a turn streams usage, so each turn asks once. */
  isWorking: boolean;
  /** Sends `/compact`, the same action as the composer meter. Absent when the provider cannot compact. */
  onCompact?: (() => void) | undefined;
  compactDisabledReason: string | null;
}) {
  // Keyed by provider thread and the latest settled usage report, so a
  // provider switch or a finished turn asks again and a cached answer never
  // describes another provider or an older turn. Reports streamed mid-turn
  // keep the last settled key, so each turn asks once.
  const settledRevision = props.isWorking ? null : (props.snapshot?.updatedAt ?? null);
  const [revision, setRevision] = useState(settledRevision);
  if (settledRevision !== null && settledRevision !== revision) setRevision(settledRevision);
  const query = useEnvironmentQuery(
    props.providerThreadId === null
      ? null
      : orchestrationEnvironment.threadContextUsage({
          environmentId: props.environmentId,
          input: {
            threadId: props.threadId,
            providerThreadId: props.providerThreadId,
            ...(revision === null ? {} : { revision }),
          },
        }),
  );
  // While the next key loads, keep showing the same provider thread's last
  // answer instead of flashing back to totals.
  const [lastUsage, setLastUsage] = useState<{
    readonly providerThreadId: ProviderThreadId;
    readonly usage: ThreadContextUsage;
  } | null>(null);
  if (
    props.providerThreadId !== null &&
    query.data !== null &&
    (lastUsage?.usage !== query.data || lastUsage.providerThreadId !== props.providerThreadId)
  ) {
    setLastUsage({ providerThreadId: props.providerThreadId, usage: query.data });
  }

  const failureReason =
    query.failure !== null &&
    typeof query.failure === "object" &&
    "_tag" in query.failure &&
    query.failure._tag === "ThreadContextUsageError"
      ? query.failure.reason
      : query.failure === null
        ? null
        : "request-failed";
  const liveUsage =
    failureReason !== null
      ? null
      : (query.data ??
        (lastUsage !== null && lastUsage.providerThreadId === props.providerThreadId
          ? lastUsage.usage
          : null));
  // A breakdown saved after the last turn stands in once the session stops.
  const savedUsage =
    liveUsage === null && props.savedBreakdown !== null
      ? { ...props.savedBreakdown, groups: [] }
      : null;
  const view = buildContextBreakdownView(props.snapshot, liveUsage ?? savedUsage);

  // `/context` lands here: the store expands the section, and the section
  // scrolls itself into view and pulses while the request is live.
  const threadKey = scopedThreadKey({
    environmentId: props.environmentId,
    threadId: props.threadId,
  });
  const attention = useThreadContextAttentionStore((state) =>
    state.attention?.threadKey === threadKey ? state.attention : null,
  );
  const requested = useThreadContextAttentionStore((state) =>
    state.requestedThreadKeys.has(threadKey),
  );
  const expanded = useThreadContextAttentionStore(
    (state) => !state.collapsedThreadKeys.has(threadKey),
  );
  const toggleCollapsed = useThreadContextAttentionStore((state) => state.toggleCollapsed);
  const sectionRef = useRef<HTMLElement | null>(null);
  const attentionId = attention?.id ?? null;
  useEffect(() => {
    if (attentionId === null) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    sectionRef.current?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "nearest",
    });
  }, [attentionId]);
  const pulsing = attention?.highlight === true;

  if (view === null) {
    // Nothing reported yet. Only `/context` asks for the section anyway, so the
    // user sees why it is empty instead of nothing happening.
    if (!requested) return null;
    return (
      <ThreadDetailsSection
        ref={sectionRef}
        headingId="thread-details-context-heading"
        title="Context"
        data-thread-context-panel
        data-attention={pulsing ? "" : undefined}
      >
        <p
          className={cn(
            "pb-1 text-2xs text-muted-foreground",
            THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
          )}
        >
          Context usage appears once the provider reports it for this thread.
        </p>
      </ThreadDetailsSection>
    );
  }

  const usedPercentage = view.usedPercentage;
  const note =
    savedUsage !== null
      ? "As of the last turn. Send a message to refresh."
      : view.source === "categories"
        ? null
        : failureReason === "session-stopped"
          ? "Send a message to see what fills the window."
          : failureReason === "request-failed"
            ? "The provider could not report what fills the window."
            : failureReason === "provider-unsupported"
              ? "This provider reports token totals, not what fills the window."
              : null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-context-heading"
      ref={sectionRef}
      title="Context"
      data-thread-context-panel
      data-attention={pulsing ? "" : undefined}
      actions={
        <>
          {props.onCompact ? (
            <CompactButton
              onCompact={props.onCompact}
              disabledReason={props.compactDisabledReason}
            />
          ) : null}
          <ThreadDetailsControl
            size="icon-xs"
            variant="ghost"
            part="icon"
            aria-label={expanded ? "Hide context breakdown" : "Show context breakdown"}
            aria-expanded={expanded}
            onClick={() => toggleCollapsed(threadKey)}
          >
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", !expanded && "-rotate-90")}
            />
          </ThreadDetailsControl>
        </>
      }
    >
      <div className={cn("flex flex-col gap-2 pb-1", THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS)}>
        <div className="flex items-baseline justify-between gap-3">
          <span
            className={cn(
              "font-medium text-foreground/90 tabular-nums",
              THREAD_DETAILS_PANEL_ROW_TEXT_CLASS,
            )}
          >
            {usedPercentage === null
              ? `${formatContextWindowTokens(view.usedTokens)} used`
              : `${formatContextHeadlinePercentage(usedPercentage)} used`}
          </span>
          {view.maxTokens !== null ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatContextWindowTokens(view.usedTokens)} /{" "}
              {formatContextWindowTokens(view.maxTokens)}
            </span>
          ) : null}
        </div>
        {view.maxTokens !== null ? <ContextUsageBar rows={view.rows} /> : null}
      </div>
      {expanded ? (
        <>
          <ul className="m-0 mt-1 list-none p-0" aria-label="Context window usage by category">
            {view.rows.map((row) => (
              <ContextUsageRow key={`${row.kind}:${row.label}`} row={row} />
            ))}
          </ul>
          {view.deferredRows.length > 0 ? (
            <ul className="m-0 mt-1.5 list-none p-0" aria-label="Tools outside the context window">
              {view.deferredRows.map((row) => (
                <ContextUsageRow key={`${row.kind}:${row.label}`} row={row} />
              ))}
            </ul>
          ) : null}
          {view.groups.length > 0 ? (
            <div className="mt-1.5">
              {view.groups.map((group) => (
                <ContextUsageGroup key={group.id} group={group} />
              ))}
            </div>
          ) : null}
          {note ? (
            <p
              className={cn(
                "pt-1.5 text-2xs text-muted-foreground",
                THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
              )}
            >
              {note}
            </p>
          ) : null}
        </>
      ) : null}
    </ThreadDetailsSection>
  );
}

function CompactButton(props: { onCompact: () => void; disabledReason: string | null }) {
  const button = (
    <ThreadDetailsControl
      part="meta"
      disabled={props.disabledReason !== null}
      onClick={props.onCompact}
    >
      <Minimize2Icon aria-hidden className="size-3" />
      Compact
    </ThreadDetailsControl>
  );
  if (props.disabledReason === null) return button;
  // A disabled button gets no pointer events, so the wrapper carries the tooltip.
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{button}</TooltipTrigger>
      <TooltipPopup>{props.disabledReason}</TooltipPopup>
    </Tooltip>
  );
}

function ContextUsageBar(props: { rows: ReadonlyArray<ContextBreakdownRow> }) {
  const segments = props.rows.filter(
    (row) => (row.kind === "used" || row.kind === "buffer") && (row.percentage ?? 0) > 0,
  );
  return (
    <div className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted/60" aria-hidden>
      {segments.map((row) => (
        <div
          key={`${row.kind}:${row.label}`}
          className={cn("h-full shrink-0", SWATCH_CLASS[row.swatch])}
          style={{ width: `${Math.min(100, row.percentage ?? 0)}%` }}
        />
      ))}
    </div>
  );
}

function ContextUsageRow(props: { row: ContextBreakdownRow }) {
  const { row } = props;
  const deferred = row.kind === "deferred";
  return (
    <li
      className={cn(
        "flex h-7 items-center tabular-nums",
        THREAD_DETAILS_PANEL_ROW_TEXT_CLASS,
        THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
      )}
    >
      <span aria-hidden className={cn("size-2.5 shrink-0 rounded-xs", SWATCH_CLASS[row.swatch])} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          deferred ? "text-muted-foreground/70" : "text-foreground/80",
        )}
      >
        {row.label}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {formatContextWindowTokens(row.tokens)}
      </span>
      <span
        className={cn(
          "w-11 shrink-0 text-right text-xs",
          deferred ? "text-muted-foreground/70" : "font-medium text-foreground/80",
        )}
      >
        {formatContextPercentage(row.percentage)}
      </span>
    </li>
  );
}

function ContextUsageGroup(props: { group: ContextBreakdownGroup }) {
  const [open, setOpen] = useState(false);
  const { group } = props;
  return (
    <div>
      <ThreadDetailsControl aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate">{group.label}</span>
        <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
          {group.items.length}
        </span>
      </ThreadDetailsControl>
      {open ? (
        <ul
          aria-label={group.label}
          className="m-0 max-h-[13.5rem] list-none overflow-y-auto overscroll-contain p-0 ps-6"
        >
          {group.items.map((item) => (
            <li
              key={`${item.detail ?? ""}:${item.name}`}
              className={cn(
                "flex min-h-7 items-center py-1",
                THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-foreground/80">{item.name}</span>
                {item.detail ? (
                  <span className="block truncate text-2xs text-muted-foreground">
                    {item.detail}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {formatContextWindowTokens(item.tokens)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

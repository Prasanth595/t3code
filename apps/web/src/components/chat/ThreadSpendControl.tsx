import { useAtomValue } from "@effect/atom-react";
import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type ThreadId,
  type UsageSessionSpendResult,
} from "@t3tools/contracts";
import { formatUsd, makeWindow } from "@t3tools/shared/usageFormat";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { cn } from "~/lib/utils";
import { useThreadShells } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useJoinedSpendSessions } from "./spendSessions";
import {
  buildThreadSpendView,
  formatSpendLabel,
  formatSpendMoney,
  spendResultIncomplete,
  THREAD_SPEND_WINDOW_DAYS,
  type SpendMoney,
  type ThreadSpendView,
} from "./threadSpend";

const idleSpendAtom = Atom.make(AsyncResult.success<UsageSessionSpendResult | null>(null)).pipe(
  Atom.withLabel("thread-spend:idle"),
);

function MoneyLine(props: { label: string; money: SpendMoney }) {
  const formatted = formatSpendMoney(props.money);
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{props.label}</span>
      <span className="text-right tabular-nums">
        <span className="text-foreground">{formatted.dollars}</span>
        <span className="text-muted-foreground"> · {formatted.tokens}</span>
      </span>
    </div>
  );
}

function viewLabel(view: ThreadSpendView, failed: boolean): string {
  if (failed) return "Usage unavailable";
  if (view.kind === "loading") return "Spend";
  if (view.kind === "empty") {
    if (view.refreshing) return "Scanning";
    return view.partial ? "Usage unknown" : "No usage yet";
  }
  if (view.kind === "unsplit") return "In parent";
  return formatSpendLabel(view.own, view.partial);
}

/** Thread API spend, shown in the chat header next to the thread title. */
export function ThreadSpendControl(props: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
}) {
  const navigate = useNavigate();
  const canRead = useEnvironmentScope(props.environmentId, AuthDiagnosticsReadScope);
  const shells = useThreadShells(canRead && props.threadId !== null);
  const joined = useJoinedSpendSessions({
    enabled: canRead,
    environmentId: props.environmentId,
    shells,
    focusThreadId: props.threadId,
  });
  const nodes = joined.nodes;
  const thread = nodes.find((candidate) => candidate.id === props.threadId) ?? null;
  const sessions = joined.sessions;
  const spendWindow = makeWindow(THREAD_SPEND_WINDOW_DAYS);
  const spendAtom =
    !canRead || props.environmentId === null || thread?.sessions == null || sessions.length === 0
      ? idleSpendAtom
      : serverEnvironment.usageSessionSpend({
          environmentId: props.environmentId,
          input: {
            sinceDay: spendWindow.sinceDay,
            untilDay: spendWindow.untilDay,
            timeZone: spendWindow.timeZone,
            sessions,
          },
        });
  const result = useAtomValue(
    spendAtom as Atom.Atom<AsyncResult.AsyncResult<UsageSessionSpendResult | null>>,
  );
  if (!canRead || props.environmentId === null) return null;

  const value = Option.getOrNull(AsyncResult.value(result));
  const failed = result._tag === "Failure";
  const requested = thread?.sessions != null && thread.sessions.length > 0;
  const sources = value?.sources ?? [];
  const view = buildThreadSpendView({
    thread: props.threadId === null ? null : thread,
    threads: nodes,
    priced: failed || !requested ? [] : (value?.sessions ?? null),
    refreshing:
      sources.some((source) => source.refreshing === true) || (result.waiting && value !== null),
    partial: spendResultIncomplete(value),
    sinceDay: value?.sinceDay ?? null,
    untilDay: value?.untilDay ?? null,
  });
  const label = joined.overCap ? "Too many sessions" : viewLabel(view, failed);
  const own = view.kind === "ready" ? formatSpendMoney(view.own) : null;
  const dim = !failed && view.kind === "ready" && view.refreshing;

  return (
    <>
      {joined.loaders}
      <Popover>
        <PopoverTrigger
          openOnHover
          delay={150}
          render={
            <button
              type="button"
              aria-label={own === null ? `Thread spend: ${label}` : `Thread spend ${label}`}
              className={cn(
                "inline-flex h-6 shrink-0 cursor-pointer items-center rounded-md px-1.5 text-xs font-medium tabular-nums text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                dim && "opacity-60",
              )}
            />
          }
        >
          {label}
        </PopoverTrigger>
        <PopoverPopup
          tooltipStyle
          side="bottom"
          align="end"
          padding="none"
          width="sm"
          className="text-left whitespace-normal"
        >
          <div className="flex flex-col gap-2 p-(--floating-content-inset) text-xs">
            <div className="font-medium text-foreground">Thread spend</div>
            {failed ? <p className="text-muted-foreground">Usage could not be read.</p> : null}
            {!failed && joined.overCap ? (
              <p className="text-muted-foreground">
                This thread has more sessions than can be priced at once.
              </p>
            ) : null}
            {!failed && !joined.overCap && view.kind === "loading" ? (
              <p className="text-muted-foreground">Reading usage…</p>
            ) : null}
            {!failed && view.kind === "empty" ? (
              <p className="text-muted-foreground">
                {view.refreshing
                  ? "No usage priced yet; the scan is still running."
                  : view.partial
                    ? "No usage could be read for this thread."
                    : "No usage yet for this thread."}
              </p>
            ) : null}
            {!failed && view.kind === "unsplit" ? (
              <p className="text-muted-foreground">
                This subagent&apos;s spend is inside {view.parentTitle ?? "the parent thread"} and
                is not split.
              </p>
            ) : null}
            {!failed && !joined.overCap && view.kind === "ready" ? (
              <>
                <MoneyLine label="This thread" money={view.own} />
                {view.includingSubagents !== null ? (
                  <MoneyLine label="Including subagents" money={view.includingSubagents} />
                ) : null}
                {view.subagentsNotIncluded ? (
                  <p className="text-muted-foreground">Subagent spend is not included.</p>
                ) : null}
                {view.isSubagent && view.parentTitle !== null ? (
                  <p className="text-muted-foreground">Subagent of {view.parentTitle}</p>
                ) : null}
                {view.own.unpriced ? (
                  <p className="text-muted-foreground">
                    No price for these models, so only tokens are shown.
                  </p>
                ) : view.own.unpricedRecords > 0 ? (
                  <p className="text-muted-foreground">
                    {view.own.unpricedRecords} record
                    {view.own.unpricedRecords === 1 ? " has" : "s have"} no price; the dollar figure
                    is a lower bound.
                  </p>
                ) : null}
                {view.partial ? (
                  <p className="text-muted-foreground">
                    The usage scan is incomplete, so this is a lower bound.
                  </p>
                ) : null}
                {(value?.unresolvedThreads ?? 0) > 0 ? (
                  <p className="text-muted-foreground">
                    {value?.unresolvedThreads} thread
                    {(value?.unresolvedThreads ?? 0) === 1 ? " could" : "s could"} not be resolved.
                  </p>
                ) : null}
                {view.own.category !== null ? (
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground tabular-nums">
                    <span>Input {formatUsd(view.own.category.input)}</span>
                    <span>Cache read {formatUsd(view.own.category.cacheRead)}</span>
                    <span>Cache write {formatUsd(view.own.category.cacheWrite)}</span>
                    <span>Output {formatUsd(view.own.category.output)}</span>
                  </div>
                ) : null}
                {view.sinceDay !== null && view.untilDay !== null ? (
                  <p className="text-muted-foreground">
                    {view.sinceDay} to {view.untilDay}
                    {view.refreshing ? " · Still scanning" : ""}
                  </p>
                ) : null}
              </>
            ) : null}
            <p className="text-muted-foreground">API estimate, not the subscription bill.</p>
            <button
              type="button"
              className="self-start text-foreground underline-offset-2 hover:underline"
              onClick={() => void navigate({ to: "/usage" })}
            >
              Open Usage
            </button>
          </div>
        </PopoverPopup>
      </Popover>
    </>
  );
}

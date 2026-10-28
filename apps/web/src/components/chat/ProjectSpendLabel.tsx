import { useAtomValue } from "@effect/atom-react";
import {
  AuthDiagnosticsReadScope,
  MAX_SESSION_SPEND_THREADS,
  type EnvironmentId,
  type ProjectId,
  type UsageSessionSpendResult,
} from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { cn } from "~/lib/utils";
import { useThreadShellsForProjectRefs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import {
  buildProjectSpendView,
  formatSpendLabel,
  formatSpendMoney,
  spendResultIncomplete,
  THREAD_SPEND_WINDOW_DAYS,
} from "./threadSpend";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const idleSpendAtom = Atom.make(AsyncResult.success<UsageSessionSpendResult | null>(null)).pipe(
  Atom.withLabel("project-spend:idle"),
);

/** One read prices at most this many sessions; past it the label stays a lower bound. */
const MAX_QUERIED_THREADS = MAX_SESSION_SPEND_THREADS;

/** Project API spend, shown in the chat header next to the project name. */
export function ProjectSpendLabel(props: {
  environmentId: EnvironmentId | null;
  projectId: ProjectId | null;
}) {
  const navigate = useNavigate();
  const shells = useThreadShellsForProjectRefs(
    props.environmentId === null || props.projectId === null
      ? []
      : [{ environmentId: props.environmentId, projectId: props.projectId }],
  );
  const environmentId = props.environmentId ?? shells[0]?.environmentId ?? null;
  const canRead = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  // The server resolves each thread to its provider sessions, so the header never has to open
  // every thread's stream. Newest threads first so a capped read keeps the busiest work.
  const threadIds =
    environmentId === null
      ? []
      : shells
          .filter((shell) => shell.environmentId === environmentId && shell.deletedAt === null)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, MAX_QUERIED_THREADS)
          .map((shell) => shell.id);
  const spendWindow = makeWindow(THREAD_SPEND_WINDOW_DAYS);
  const spendAtom =
    !canRead || environmentId === null || threadIds.length === 0
      ? idleSpendAtom
      : serverEnvironment.usageSessionSpend({
          environmentId,
          input: {
            sinceDay: spendWindow.sinceDay,
            untilDay: spendWindow.untilDay,
            timeZone: spendWindow.timeZone,
            sessions: [],
            threadIds,
          },
        });
  const result = useAtomValue(
    spendAtom as Atom.Atom<AsyncResult.AsyncResult<UsageSessionSpendResult | null>>,
  );
  if (!canRead || environmentId === null || props.projectId === null) return null;

  const value = Option.getOrNull(AsyncResult.value(result));
  const failed = result._tag === "Failure";
  const sources = value?.sources ?? [];
  const rows = value?.sessions ?? null;
  const projectThreadCount =
    environmentId === null
      ? 0
      : shells.filter((shell) => shell.environmentId === environmentId && shell.deletedAt === null)
          .length;
  // Threads past the cap are never requested, so the server cannot report them as dropped.
  const uncountedThreads = Math.max(0, projectThreadCount - threadIds.length);
  const view = buildProjectSpendView({
    priced: failed ? [] : rows,
    threads: threadIds.length,
    partial: spendResultIncomplete(value) || uncountedThreads > 0,
    refreshing:
      sources.some((source) => source.refreshing === true) || (result.waiting && value !== null),
    sinceDay: value?.sinceDay ?? null,
    untilDay: value?.untilDay ?? null,
  });
  const label = failed
    ? "Usage unavailable"
    : view.kind === "loading"
      ? "project spend"
      : view.kind === "empty"
        ? view.refreshing
          ? "project spend scanning"
          : view.partial
            ? "project usage incomplete"
            : "no project usage"
        : formatSpendLabel(view.money, view.partial);
  const formatted = view.kind === "ready" ? formatSpendMoney(view.money) : null;
  const detail = [
    "Project spend: API estimate for T3 threads in this project, not the subscription bill.",
    view.kind === "ready" && view.money.unpriced
      ? "Only tokens are shown; no price for these models."
      : null,
    view.kind === "ready" && view.money.unpricedRecords > 0 && !view.money.unpriced
      ? "Some records have no price."
      : null,
    view.kind === "ready" && view.partial ? "Some usage could not be read." : null,
    view.kind === "ready" && uncountedThreads > 0
      ? `Only the newest ${threadIds.length} threads are priced; ${uncountedThreads} are not counted.`
      : null,
    view.kind === "empty" && view.partial
      ? "No usage was read, but some sources were incomplete, so usage may exist."
      : null,
    view.kind === "empty" && view.refreshing ? "The usage scan is still running." : null,
    view.kind === "ready" && view.sinceDay !== null && view.untilDay !== null
      ? `${view.sinceDay} to ${view.untilDay}`
      : null,
  ]
    .filter((line) => line !== null)
    .join(" ");
  const dim = !failed && view.kind === "ready" && view.refreshing;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "max-w-44 min-w-0 shrink truncate rounded-sm px-1 text-xs font-normal tabular-nums text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              dim && "opacity-60",
            )}
            aria-label={
              formatted === null
                ? `Project spend: ${label}`
                : `Project spend ${formatted.dollars}, ${formatted.tokens} tokens`
            }
            onClick={() => void navigate({ to: "/usage" })}
          />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup side="bottom" align="start">
        {detail}
      </TooltipPopup>
    </Tooltip>
  );
}

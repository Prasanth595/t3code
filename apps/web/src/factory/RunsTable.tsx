import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";

import type { FactoryRunRow } from "./api";
import { formatAge, labelForState, parseRunId, stateBadgeVariant } from "./format";

const startedMs = (run: FactoryRunRow) =>
  run.started_ts ? Date.parse(run.started_ts) : Number.NaN;

/** Newest first; a run with no readable start goes last. */
const newestFirst = (a: FactoryRunRow, b: FactoryRunRow) => {
  const x = startedMs(a);
  const y = startedMs(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : -1;
  return y - x;
};

/** `#30` for a GitHub pull request URL, else a plain label. */
const prLabel = (url: string) => {
  const match = /\/pull\/(\d+)/.exec(url);
  return match ? `#${match[1]}` : "PR";
};

const stateBadge = (run: FactoryRunRow) =>
  run.unreadable ? (
    <Badge variant="error">unreadable</Badge>
  ) : (
    <Badge variant={stateBadgeVariant(run.state)}>{labelForState(run.state)}</Badge>
  );

/** One run for a phone: a single link to the run, so the whole card is the tap target. */
function RunCard({ run, nowMs }: { run: FactoryRunRow; nowMs: number }) {
  const parsed = parseRunId(run.id);
  const pr = run.pr_url
    ? run.pr_url.startsWith("https://github.com/")
      ? prLabel(run.pr_url)
      : run.pr_url
    : null;
  return (
    <li>
      <Link
        className="flex min-h-11 flex-col gap-1 rounded-lg border bg-card px-3 py-2 text-sm"
        params={{ runId: run.id }}
        to="/factory/$runId"
      >
        <span className="flex items-start justify-between gap-2">
          <span className="min-w-0 break-words font-medium">
            {parsed ? `${parsed.owner}/${parsed.repo}` : run.id}
          </span>
          {stateBadge(run)}
        </span>
        <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {parsed ? (
            <span>{/^[0-9]+$/.test(parsed.issue) ? `#${parsed.issue}` : parsed.issue}</span>
          ) : null}
          <span className="min-w-0 break-words">{run.step ?? run.last_event ?? "—"}</span>
          <span>{formatAge(startedMs(run), nowMs)}</span>
          {pr ? <span className="min-w-0 break-all">{pr}</span> : null}
        </span>
      </Link>
    </li>
  );
}

/**
 * The runs the server listed: by default every unfinished run and the finished ones of the last
 * week (`partial`), kept fresh by the poll, or every run the factory ever made, read once.
 */
export function RunsTable({
  runs,
  nowMs,
  partial,
  onShowAll,
  onShowRecent,
}: {
  runs: ReadonlyArray<FactoryRunRow>;
  nowMs: number;
  partial: boolean;
  onShowAll: () => void;
  onShowRecent: () => void;
}) {
  const cards = useMediaQuery("max-sm");
  const sorted = useMemo(() => [...runs].sort(newestFirst), [runs]);
  const showAll = partial ? (
    <Button onClick={onShowAll} size="touch" variant="ghost">
      Show all runs
    </Button>
  ) : (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>Every run, read once.</span>
      <Button onClick={onShowRecent} size="touch" variant="ghost">
        Show recent runs
      </Button>
    </div>
  );
  if (runs.length === 0) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>{partial ? "No runs in the last week" : "No runs yet"}</EmptyTitle>
        </EmptyHeader>
        {showAll}
      </Empty>
    );
  }
  if (cards) {
    return (
      <>
        <ul className="flex flex-col gap-2" data-layout="cards">
          {sorted.map((run) => (
            <RunCard key={run.id} nowMs={nowMs} run={run} />
          ))}
        </ul>
        {showAll}
      </>
    );
  }
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Repo</TableHead>
            <TableHead>Issue</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Step</TableHead>
            <TableHead>Age</TableHead>
            <TableHead>Pull request</TableHead>
            <TableHead>Run</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((run) => {
            const parsed = parseRunId(run.id);
            return (
              <TableRow key={run.id}>
                <TableCell>{parsed ? `${parsed.owner}/${parsed.repo}` : "—"}</TableCell>
                <TableCell>
                  {parsed ? (
                    /^[0-9]+$/.test(parsed.issue) ? (
                      <a
                        className="underline-offset-2 hover:underline"
                        href={`https://github.com/${parsed.owner}/${parsed.repo}/issues/${parsed.issue}`}
                        rel="noreferrer"
                        target="_blank"
                      >
                        #{parsed.issue}
                      </a>
                    ) : (
                      parsed.issue
                    )
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell>{stateBadge(run)}</TableCell>
                <TableCell>{run.step ?? run.last_event ?? "—"}</TableCell>
                <TableCell>{formatAge(startedMs(run), nowMs)}</TableCell>
                <TableCell>
                  {run.pr_url?.startsWith("https://github.com/") ? (
                    <a
                      className="underline-offset-2 hover:underline"
                      href={run.pr_url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {prLabel(run.pr_url)}
                    </a>
                  ) : (
                    run.pr_url || "—"
                  )}
                </TableCell>
                <TableCell>
                  <Link
                    className="font-mono text-xs underline-offset-2 hover:underline"
                    params={{ runId: run.id }}
                    to="/factory/$runId"
                  >
                    {run.id}
                  </Link>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {showAll}
    </>
  );
}

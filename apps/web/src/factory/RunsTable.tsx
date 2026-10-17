import { Link } from "@tanstack/react-router";

import { Badge } from "~/components/ui/badge";
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

export function RunsTable({ runs, nowMs }: { runs: ReadonlyArray<FactoryRunRow>; nowMs: number }) {
  if (runs.length === 0) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>No runs yet</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
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
        {[...runs].sort(newestFirst).map((run) => {
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
              <TableCell>
                {run.unreadable ? (
                  <Badge variant="error">unreadable</Badge>
                ) : (
                  <Badge variant={stateBadgeVariant(run.state)}>{labelForState(run.state)}</Badge>
                )}
              </TableCell>
              <TableCell>{run.step ?? run.last_event ?? "—"}</TableCell>
              <TableCell>{formatAge(startedMs(run), nowMs)}</TableCell>
              <TableCell>
                {run.pr_url ? (
                  <a
                    className="underline-offset-2 hover:underline"
                    href={run.pr_url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {prLabel(run.pr_url)}
                  </a>
                ) : (
                  "—"
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
  );
}

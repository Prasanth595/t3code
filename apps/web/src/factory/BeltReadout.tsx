import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { cn } from "~/lib/utils";

import { factoryApi } from "./api";
import { STATION_META, type BeltRun, type Station } from "./belt";
import { BeltDot } from "./BeltDot";
import { formatAge, messageOf, prRef } from "./format";
import { Ref } from "./Ref";

/** The id of the one open readout, which the picked post names in `aria-controls`. */
export const READOUT_ID = "factory-readout";

/** A column the narrow belt leaves out; the run page has the rest. */
const WIDE_ONLY = "hidden @3xl:table-cell";

const withKey = (set: ReadonlySet<string>, key: string, member: boolean) => {
  const next = new Set(set);
  if (member) next.add(key);
  else next.delete(key);
  return next;
};

/**
 * The open post's runs as a table under the rail, with a notch pointing at the post: a grid of the
 * posts' own column template, so the notch sits in the post's column without measuring. A row is a
 * link to its run's page, stretched over the whole row; its Stop and pull request link sit above it.
 * Stop is enabled as the run page enables its own, and shows the answer of `stopRun` below the table.
 */
export function BeltReadout({
  station,
  runs,
  selectedId,
  nowMs,
  column,
  refreshStatus,
}: {
  station: Station;
  runs: ReadonlyArray<BeltRun>;
  selectedId: EnvironmentId;
  nowMs: number;
  /** The wide belt's column class of the picked post, which the notch takes. */
  column: string;
  refreshStatus: (environmentId: EnvironmentId) => void;
}) {
  const { name, tag } = STATION_META[station];
  // The runs with a stop in flight: one row's Stop never disables another's.
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const [note, setNote] = useState<string | null>(null);

  const stop = async ({ key, environmentId, id }: BeltRun) => {
    setStopping((current) => withKey(current, key, true));
    let answer: string;
    try {
      answer = (await factoryApi.stopRun(environmentId, id)).message;
    } catch (error) {
      answer = messageOf(error);
    }
    setNote(answer);
    setStopping((current) => withKey(current, key, false));
    refreshStatus(environmentId);
  };

  return (
    <section
      aria-label={`${name} readout`}
      className="relative mt-4 min-w-0 rounded-lg border border-(--factory-station) bg-card @3xl:col-span-5 @3xl:col-start-1 @3xl:row-start-3"
      data-readout=""
      data-station={station}
      id={READOUT_ID}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-2 grid grid-cols-1 gap-x-2 @3xl:grid-cols-(--factory-cols)"
      >
        <span
          className={cn(
            "ml-6 size-3.5 rotate-45 border-t border-l border-(--factory-station) bg-card @3xl:ml-0 @3xl:justify-self-center",
            column,
          )}
          data-part="notch"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2.5">
        <span aria-hidden className="size-2.5 rounded-xs bg-(--factory-station)" />
        <h2 className="text-sm font-semibold">{name}</h2>
        <span className="font-mono text-xs text-muted-foreground">{tag}</span>
        <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">
          {runs.length} {runs.length === 1 ? "run" : "runs"}
        </span>
      </div>
      {runs.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">Nothing at {name}.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Issue</TableHead>
              <TableHead>Title</TableHead>
              <TableHead className={WIDE_ONLY}>Env</TableHead>
              <TableHead className={WIDE_ONLY}>Step</TableHead>
              <TableHead>Elapsed</TableHead>
              <TableHead className={WIDE_ONLY}>PR</TableHead>
              <TableHead>
                <span className="sr-only">Stop</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => {
              const pr = prRef(run.prUrl);
              return (
                <TableRow className="relative" key={run.key}>
                  <TableCell>
                    <Link
                      className="font-mono font-semibold after:absolute after:inset-0 hover:underline"
                      params={{ environmentId: run.environmentId, runId: run.id }}
                      to="/factory/$environmentId/$runId"
                    >
                      {run.issue}
                    </Link>
                  </TableCell>
                  <TableCell className="w-full max-w-0">
                    <span className="block truncate">{run.title ?? run.issue}</span>
                  </TableCell>
                  <TableCell className={WIDE_ONLY}>
                    <span className="inline-flex items-center gap-1.5">
                      <BeltDot selected={run.environmentId === selectedId} />
                      {run.label}
                    </span>
                  </TableCell>
                  <TableCell className={WIDE_ONLY}>
                    <span className="font-mono">{run.step ?? "-"}</span>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono">
                      {run.forMs === null ? "-" : formatAge(nowMs - run.forMs, nowMs)}
                    </span>
                  </TableCell>
                  <TableCell className={WIDE_ONLY}>
                    {pr ? (
                      <span className="relative z-10">
                        <Ref {...pr} />
                      </span>
                    ) : (
                      "-"
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="relative z-10">
                      <Button
                        aria-label={`Stop ${run.issue}`}
                        disabled={!run.stoppable || stopping.has(run.key)}
                        onClick={() => void stop(run)}
                        size="sm"
                        variant="destructive-outline"
                      >
                        Stop
                      </Button>
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {note ? (
        <p className="break-words border-t px-4 py-2 text-sm text-muted-foreground" role="status">
          {note}
        </p>
      ) : null}
    </section>
  );
}

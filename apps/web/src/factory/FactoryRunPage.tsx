import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { usePrimaryEnvironmentId } from "~/state/environments";

import { FactoryApiError, factoryApi, type FactoryEntry } from "./api";
import { FactoryFrame } from "./FactoryFrame";
import { FactoryError, FactoryLoading } from "./FactoryNotices";
import {
  currentStep,
  labelForState,
  lastGateOutput,
  runIsFinished,
  runState,
  stateBadgeVariant,
  threadIdOf,
} from "./format";
import { useFactoryRun } from "./useFactoryData";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function GateOutput({ entries }: { entries: ReadonlyArray<FactoryEntry> }) {
  const gate = lastGateOutput(entries);
  const empty = gate.commands.length === 0 && gate.message === null && gate.stuckReason === null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Last gate output</h2>
      {empty ? <p className="text-sm text-muted-foreground">No gate has run</p> : null}
      {gate.commands.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Command</TableHead>
              <TableHead>Exit code</TableHead>
              <TableHead>Duration (ms)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {gate.commands.map((command, index) => (
              <TableRow key={`${index}:${command.command}`}>
                <TableCell className="font-mono text-xs">{command.command}</TableCell>
                <TableCell>
                  <Badge variant={command.exit_code === 0 ? "success" : "error"}>
                    {command.exit_code}
                  </Badge>
                </TableCell>
                <TableCell>{command.duration_ms}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      {/* The session's own words: plain text in a pre, never markdown or HTML. */}
      {gate.message !== null ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border bg-card p-3 font-mono text-xs">
          {gate.message}
        </pre>
      ) : null}
      {gate.stuckReason !== null ? (
        <p className="text-sm text-muted-foreground">Stuck: {gate.stuckReason}</p>
      ) : null}
    </section>
  );
}

function Ledger({
  entries,
  truncated,
  skipped,
}: {
  entries: ReadonlyArray<FactoryEntry>;
  truncated: boolean;
  skipped: number;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Ledger</h2>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No ledger entries</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Data</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry, index) => {
              const data = JSON.stringify(entry.data);
              return (
                <TableRow key={`${index}:${entry.ts}`}>
                  <TableCell className="whitespace-nowrap font-mono text-xs">{entry.ts}</TableCell>
                  <TableCell className="whitespace-nowrap">{entry.event}</TableCell>
                  <TableCell className="max-w-md truncate font-mono text-xs" title={data}>
                    {data}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {truncated ? (
        <p className="text-xs text-muted-foreground">
          The ledger is truncated; older entries are not shown.
        </p>
      ) : null}
      {skipped > 0 ? (
        <p className="text-xs text-muted-foreground">{skipped} unreadable lines skipped.</p>
      ) : null}
    </section>
  );
}

export function FactoryRunPage({ runId }: { runId: string }) {
  const run = useFactoryRun(runId);
  const environmentId = usePrimaryEnvironmentId() ?? PRIMARY_LOCAL_ENVIRONMENT_ID;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const stop = async () => {
    setBusy(true);
    try {
      setNote((await factoryApi.stopRun(runId)).message);
    } catch (error) {
      setNote(messageOf(error));
    } finally {
      setBusy(false);
      run.refresh();
    }
  };

  const entries = run.data?.entries ?? [];
  const state = runState(entries);
  const canStop = run.data !== null && state === "building" && !runIsFinished(entries);
  const step = currentStep(entries);
  const threadId = threadIdOf(entries);

  let body;
  if (run.status === "error" && run.data === null) {
    body =
      run.error instanceof FactoryApiError && run.error.status === 404 ? (
        <FactoryError
          message="It may be finished and cleaned up, or the id is wrong."
          title={`No run ${runId}`}
        />
      ) : (
        <FactoryError message={messageOf(run.error)} onRetry={run.refresh} />
      );
  } else if (run.data === null) {
    body = <FactoryLoading label="Loading run" />;
  } else {
    body = (
      <>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <Badge variant={stateBadgeVariant(state)}>{labelForState(state)}</Badge>
          <span className="text-muted-foreground">Step: {step ?? "—"}</span>
          {threadId ? (
            <Link
              className="underline-offset-2 hover:underline"
              params={{ environmentId, threadId }}
              to="/$environmentId/$threadId"
            >
              Thread
            </Link>
          ) : (
            <span className="text-muted-foreground">no thread yet</span>
          )}
          <Button
            className="ml-auto"
            disabled={!canStop || busy}
            onClick={() => void stop()}
            size="sm"
            variant="destructive-outline"
          >
            Stop
          </Button>
        </div>
        {note ? (
          <p className="text-sm text-muted-foreground" role="status">
            {note}
          </p>
        ) : null}
        <GateOutput entries={entries} />
        <Ledger entries={entries} skipped={run.data.skipped} truncated={run.data.truncated} />
      </>
    );
  }

  return (
    <FactoryFrame
      header={
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Link className="text-sm text-muted-foreground hover:text-foreground" to="/factory">
            Back
          </Link>
          <h1 className="min-w-0 truncate font-mono text-sm font-medium">{runId}</h1>
        </div>
      }
    >
      {body}
    </FactoryFrame>
  );
}

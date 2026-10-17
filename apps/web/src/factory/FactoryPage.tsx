import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";

import { factoryApi } from "./api";
import { AttentionList } from "./AttentionList";
import { FactoryFrame } from "./FactoryFrame";
import { FactoryError, FactoryLoading } from "./FactoryNotices";
import { formatAge } from "./format";
import { RunsTable } from "./RunsTable";
import { useFactoryRuns, useFactoryStatus } from "./useFactoryData";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function FactoryPage() {
  const status = useFactoryStatus();
  const runs = useFactoryRuns();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const control = async (call: () => Promise<{ readonly message: string }>) => {
    setBusy(true);
    try {
      setNote((await call()).message);
    } catch (error) {
      setNote(messageOf(error));
    } finally {
      setBusy(false);
      status.refresh();
    }
  };

  // A failed poll only replaces the page while there is nothing to show; otherwise it is a notice.
  const errored = [status, runs].filter((resource) => resource.status === "error");
  const failed = errored.find((resource) => resource.data === null) ?? null;
  const stale = failed === null ? (errored[0] ?? null) : null;
  const retry = () => {
    status.refresh();
    runs.refresh();
  };
  // The age labels move on when a poll lands, not on every render.
  const nowMs = useMemo(() => Date.now(), [status.data, runs.data]);
  const report = status.data;
  const paused = report?.paused_by_hand ?? null;

  let body;
  if (failed) {
    body = <FactoryError message={messageOf(failed.error)} onRetry={retry} />;
  } else if (report === null || runs.data === null) {
    body = <FactoryLoading label="Loading factory" />;
  } else {
    body = (
      <>
        {stale ? (
          <div
            className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground"
            role="alert"
          >
            <span className="min-w-0 flex-1 truncate">
              Could not refresh: {messageOf(stale.error)}
            </span>
            <Button onClick={retry} size="sm" variant="outline">
              Retry
            </Button>
          </div>
        ) : null}
        {report.state === "idle" ? (
          <p className="rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground">
            The factory is idle{report.reason ? `: ${report.reason}` : "."}
          </p>
        ) : null}
        <AttentionList items={report.attention} nowMs={nowMs} />
        <RunsTable nowMs={nowMs} runs={runs.data.runs} />
      </>
    );
  }

  return (
    <FactoryFrame
      header={
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <h1 className="text-sm font-medium">Factory</h1>
          {report ? (
            <div className="ml-auto flex items-center gap-3">
              {note ? (
                <span className="truncate text-xs text-muted-foreground" role="status">
                  {note}
                </span>
              ) : null}
              {paused ? (
                <>
                  <span className="text-xs text-muted-foreground">
                    paused since {formatAge(Date.parse(paused.since), nowMs)}
                  </span>
                  <Button
                    disabled={busy}
                    onClick={() => void control(() => factoryApi.resumeClaims())}
                    size="sm"
                    variant="outline"
                  >
                    Resume claims
                  </Button>
                </>
              ) : (
                <Button
                  disabled={busy}
                  onClick={() => void control(() => factoryApi.pauseClaims())}
                  size="sm"
                  variant="outline"
                >
                  Pause claims
                </Button>
              )}
            </div>
          ) : null}
        </div>
      }
    >
      {body}
    </FactoryFrame>
  );
}

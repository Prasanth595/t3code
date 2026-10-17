import { useMemo, useState } from "react";

import { Alert, AlertAction, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";

import { factoryApi, type FactoryAttentionItem } from "./api";
import { AttentionList } from "./AttentionList";
import { FactoryFrame } from "./FactoryFrame";
import { FactoryError, FactoryLoading } from "./FactoryNotices";
import { formatAge, messageOf } from "./format";
import { RunsTable } from "./RunsTable";
import { useFactoryEnvironmentId, useFactoryRuns, useFactoryStatus } from "./useFactoryData";

/**
 * An item as raised once: an id the factory clears and raises again comes back with a new
 * `first_seen`, so a dismissal on this page never hides the new one.
 */
const attentionKey = (item: FactoryAttentionItem) => `${item.id}@${item.first_seen}`;

export function FactoryPage() {
  const environmentId = useFactoryEnvironmentId();
  const status = useFactoryStatus(environmentId);
  // The recent window until the user asks for every run; the switch starts a fresh read.
  const [allRuns, setAllRuns] = useState(false);
  const runs = useFactoryRuns(environmentId, allRuns);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // The attention items dismissed on this page, hidden before the server's next status says so.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  const control = async (call: () => Promise<{ readonly message?: string }>) => {
    setBusy(true);
    try {
      const { message } = await call();
      if (message !== undefined) setNote(message);
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
  const attention = (report?.attention ?? []).filter((item) => !dismissed.has(attentionKey(item)));

  const dismiss = (items: ReadonlyArray<FactoryAttentionItem>) => {
    if (environmentId === null || items.length === 0) return;
    const keys = items.map(attentionKey);
    const change = (hide: boolean) =>
      setDismissed((current) => {
        const next = new Set(current);
        for (const key of keys) {
          if (hide) next.add(key);
          else next.delete(key);
        }
        return next;
      });
    change(true);
    // Not through `control`: a dismiss that ends must not clear the busy flag of a pause or
    // resume still in flight.
    factoryApi
      .dismissAttention(
        environmentId,
        items.map((item) => item.id),
      )
      .catch((error: unknown) => {
        change(false);
        setNote(messageOf(error));
      })
      .finally(() => status.refresh());
  };

  let body;
  if (failed) {
    body = <FactoryError message={messageOf(failed.error)} onRetry={retry} />;
  } else if (report === null || runs.data === null) {
    body = <FactoryLoading label="Loading factory" />;
  } else {
    body = (
      <>
        <AttentionList items={attention} nowMs={nowMs} onDismiss={dismiss} />
        {stale ? (
          <Alert variant="error">
            <AlertDescription>Could not refresh: {messageOf(stale.error)}</AlertDescription>
            <AlertAction>
              <Button onClick={retry} size="sm" variant="outline">
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : null}
        {report.state === "idle" ? (
          <Alert variant="info">
            <AlertDescription>
              The factory is idle{report.reason ? `: ${report.reason}` : "."}
            </AlertDescription>
          </Alert>
        ) : null}
        {paused ? (
          <p className="text-sm text-muted-foreground">
            Claims paused since {formatAge(Date.parse(paused.since), nowMs)}
          </p>
        ) : null}
        {note ? (
          <p className="break-words text-sm text-muted-foreground" role="status">
            {note}
          </p>
        ) : null}
        <RunsTable
          nowMs={nowMs}
          onShowAll={() => setAllRuns(true)}
          onShowRecent={() => setAllRuns(false)}
          partial={!allRuns}
          runs={runs.data.runs}
        />
      </>
    );
  }

  return (
    <FactoryFrame
      header={
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <h1 className="min-w-0 truncate text-sm font-medium">Factory</h1>
          {report ? (
            <Button
              className="ml-auto shrink-0"
              disabled={busy || environmentId === null}
              onClick={() => {
                if (environmentId === null) return;
                void control(() =>
                  paused
                    ? factoryApi.resumeClaims(environmentId)
                    : factoryApi.pauseClaims(environmentId),
                );
              }}
              size="sm"
              variant="outline"
            >
              {paused ? "Resume claims" : "Pause claims"}
            </Button>
          ) : null}
        </div>
      }
    >
      {body}
    </FactoryFrame>
  );
}

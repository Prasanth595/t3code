import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { Alert, AlertAction, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";

import { factoryApi } from "./api";
import { AttentionList, type EnvironmentAttention } from "./AttentionList";
import { EnvironmentStatusRows } from "./EnvironmentStatusRows";
import { FactoryFrame } from "./FactoryFrame";
import { FactoryError, FactoryLoading } from "./FactoryNotices";
import { messageOf } from "./format";
import { RunsTable } from "./RunsTable";
import {
  useFactoryEnvironments,
  useFactoryRunsOf,
  useFactorySupported,
  type FactoryEnvironment,
} from "./useFactoryData";

/**
 * An item as raised once, by one environment: an id the factory clears and raises again comes back
 * with a new `first_seen`, so a dismissal on this page never hides the new one, and two
 * environments may raise the same id.
 */
const attentionKey = ({ environmentId, item }: EnvironmentAttention) =>
  `${environmentId} ${item.id}@${item.first_seen}`;

const withEnvironment = (set: ReadonlySet<EnvironmentId>, id: EnvironmentId, member: boolean) => {
  const next = new Set(set);
  if (member) next.add(id);
  else next.delete(id);
  return next;
};

export function FactoryPage() {
  const environments = useFactoryEnvironments();
  const supported = useFactorySupported();
  // The recent window until the user asks for every run; the switch starts a fresh read.
  const [allRuns, setAllRuns] = useState(false);
  const runsOf = useFactoryRunsOf(
    environments.map(({ environmentId }) => environmentId),
    allRuns,
  );
  // The environments with a pause or resume in flight: one row's control never disables another's.
  const [busy, setBusy] = useState<ReadonlySet<EnvironmentId>>(() => new Set());
  const [note, setNote] = useState<string | null>(null);
  // The attention items dismissed on this page, hidden before the server's next status says so.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  const togglePause = async ({ environmentId, status }: FactoryEnvironment) => {
    const paused = status.data?.paused_by_hand != null;
    setBusy((current) => withEnvironment(current, environmentId, true));
    try {
      const { message } = await (paused
        ? factoryApi.resumeClaims(environmentId)
        : factoryApi.pauseClaims(environmentId));
      if (message !== undefined) setNote(message);
    } catch (error) {
      setNote(messageOf(error));
    } finally {
      setBusy((current) => withEnvironment(current, environmentId, false));
      status.refresh();
    }
  };

  const attention = environments
    .flatMap(({ environmentId, label, status }) =>
      (status.data?.attention ?? []).map((item) => ({ environmentId, label, item })),
    )
    .filter((entry) => !dismissed.has(attentionKey(entry)))
    .sort((a, b) => Date.parse(a.item.first_seen) - Date.parse(b.item.first_seen));

  const dismiss = (entries: ReadonlyArray<EnvironmentAttention>) => {
    const byEnvironment = new Map<EnvironmentId, Array<EnvironmentAttention>>();
    for (const entry of entries) {
      byEnvironment.set(entry.environmentId, [
        ...(byEnvironment.get(entry.environmentId) ?? []),
        entry,
      ]);
    }
    const change = (group: ReadonlyArray<EnvironmentAttention>, hide: boolean) =>
      setDismissed((current) => {
        const next = new Set(current);
        for (const entry of group) {
          if (hide) next.add(attentionKey(entry));
          else next.delete(attentionKey(entry));
        }
        return next;
      });
    for (const [environmentId, group] of byEnvironment) {
      change(group, true);
      // Not through `togglePause`: a dismiss that ends must not clear the busy flag of a pause or
      // resume still in flight.
      factoryApi
        .dismissAttention(
          environmentId,
          group.map(({ item }) => item.id),
        )
        .catch((error: unknown) => {
          change(group, false);
          setNote(messageOf(error));
        })
        .finally(() =>
          environments
            .find((environment) => environment.environmentId === environmentId)
            ?.status.refresh(),
        );
    }
  };

  const nowMs = Math.max(
    0,
    ...environments.map(({ status }) => status.readAt),
    ...runsOf.map(({ readAt }) => readAt),
  );
  const showEnvironment = environments.length > 1;
  const runs = environments.flatMap(({ environmentId, label }, i) =>
    (runsOf[i]?.data?.runs ?? []).map((run) => ({ environmentId, label, run })),
  );
  const runsListed = runsOf.some(({ data }) => data !== null);
  const runsPending = runsOf.some(({ status }) => status === "loading");
  // A failed read is a notice naming its environment while the rest of the page stays.
  const notices = environments.flatMap(({ label, status }, i) => {
    const runsRead = runsOf[i];
    const failed =
      runsRead?.status === "error"
        ? runsRead
        : status.status === "error" && status.data !== null
          ? status
          : null;
    if (failed === null) return [];
    return [
      {
        label,
        message: messageOf(failed.error),
        retry: () => {
          status.refresh();
          runsRead?.refresh();
        },
      },
    ];
  });

  let body;
  if (environments.length === 0) {
    body = supported ? (
      <FactoryLoading label="Loading factory" />
    ) : (
      <FactoryError
        message="None of the connected environments runs a factory."
        title="No factory"
      />
    );
  } else if (environments.every(({ status }) => status.status === "loading")) {
    body = <FactoryLoading label="Loading factory" />;
  } else {
    body = (
      <>
        <EnvironmentStatusRows
          busy={busy}
          environments={environments}
          nowMs={nowMs}
          onTogglePause={(environment) => void togglePause(environment)}
        />
        <AttentionList
          items={attention}
          nowMs={nowMs}
          onDismiss={dismiss}
          showEnvironment={showEnvironment}
        />
        {notices.map(({ label, message, retry }) => (
          <Alert key={label} variant="error">
            <AlertDescription>
              Could not refresh {label}: {message}
            </AlertDescription>
            <AlertAction>
              <Button onClick={retry} size="sm" variant="outline">
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ))}
        {note ? (
          <p className="break-words text-sm text-muted-foreground" role="status">
            {note}
          </p>
        ) : null}
        {!runsListed && runsPending ? (
          <FactoryLoading label="Loading runs" />
        ) : runsListed ? (
          <RunsTable
            nowMs={nowMs}
            onShowAll={() => setAllRuns(true)}
            onShowRecent={() => setAllRuns(false)}
            partial={!allRuns}
            runs={runs}
            showEnvironment={showEnvironment}
          />
        ) : null}
      </>
    );
  }

  return (
    <FactoryFrame
      header={
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <h1 className="min-w-0 truncate text-sm font-medium">Factory</h1>
        </div>
      }
    >
      {body}
    </FactoryFrame>
  );
}

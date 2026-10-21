import type { EnvironmentId } from "@t3tools/contracts";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";

import { formatAge, messageOf } from "./format";
import type { FactoryEnvironment } from "./useFactoryData";

function Row({
  environment: { label, status },
  busy,
  nowMs,
  onTogglePause,
}: {
  environment: FactoryEnvironment;
  busy: boolean;
  nowMs: number;
  onTogglePause: () => void;
}) {
  const report = status.data;
  const paused = report?.paused_by_hand ?? null;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card px-3 py-2 text-sm">
      <span className="min-w-0 break-words font-medium">{label}</span>
      {report ? (
        <>
          <span className="min-w-0 break-words text-muted-foreground">
            {report.state === "idle"
              ? report.reason
                ? `Idle: ${report.reason}`
                : "Idle"
              : "Running"}
          </span>
          {paused ? (
            <span className="text-muted-foreground">
              Claims paused since {formatAge(Date.parse(paused.since), nowMs)}
            </span>
          ) : null}
          <Button
            aria-label={`${paused ? "Resume" : "Pause"} claims on ${label}`}
            className="ml-auto shrink-0"
            disabled={busy}
            onClick={onTogglePause}
            size="sm"
            variant="outline"
          >
            {paused ? "Resume claims" : "Pause claims"}
          </Button>
        </>
      ) : status.status === "error" ? (
        <>
          <span className="min-w-0 break-words text-destructive-foreground">
            {messageOf(status.error)}
          </span>
          <Button
            aria-label={`Retry ${label}`}
            className="ml-auto shrink-0"
            onClick={status.refresh}
            size="sm"
            variant="outline"
          >
            Retry
          </Button>
        </>
      ) : (
        <Skeleton aria-label={`Loading ${label}`} className="h-5 w-24" role="status" />
      )}
    </li>
  );
}

/**
 * One row per listed environment: whether its factory runs or why it is idle, since when its
 * claims are paused by hand, and the control for that. A row loads, fails and pauses by itself.
 */
export function EnvironmentStatusRows({
  environments,
  busy,
  nowMs,
  onTogglePause,
}: {
  environments: ReadonlyArray<FactoryEnvironment>;
  busy: ReadonlySet<EnvironmentId>;
  nowMs: number;
  onTogglePause: (environment: FactoryEnvironment) => void;
}) {
  return (
    <section aria-label="Factories">
      <ul className="flex flex-col gap-2">
        {environments.map((environment) => (
          <Row
            busy={busy.has(environment.environmentId)}
            environment={environment}
            key={environment.environmentId}
            nowMs={nowMs}
            onTogglePause={() => onTogglePause(environment)}
          />
        ))}
      </ul>
    </section>
  );
}

import {
  type ArrowRecord,
  DEFAULT_MACHINE_MAP_PORTAL_URL,
  type EnvironmentId,
  type MachineMapPanelState,
  type MachineRecord,
  type MachinesReadResult,
} from "@t3tools/contracts";
import { ExternalLinkIcon, NetworkIcon, RefreshCwIcon } from "lucide-react";

import { useEnvironmentQuery } from "~/state/query";
import { machinesRead, useMachineMapState } from "~/state/machineMap";
import { formatRelativeTimeLabel, formatRelativeTimeUntil } from "~/timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";

type Unavailable = Extract<MachineMapPanelState, { readonly _tag: "unavailable" }>;

const UNAVAILABLE_TITLES: Record<Unavailable["reason"], string> = {
  off: "Not on the machine map",
  paused: "Everything is paused",
  "not-connected": "No portal connection",
  "timed-out": "The portal did not answer",
  refused: "The portal refused the read",
  unreadable: "Unknown map format",
};

/** Fork: MM-1701. The machine map as `machines_read` returns it, read only. */
export function MachinesPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(machinesRead({ environmentId, input: {} }));
  const panel = query.data;
  const portalUrl =
    useMachineMapState(environmentId).state?.portalUrl ?? DEFAULT_MACHINE_MAP_PORTAL_URL;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        {panel === null ? (
          <CenteredMessage
            title={query.error === null ? "Loading the machine map" : "Could not read the map"}
            detail={query.error ?? ""}
          />
        ) : panel._tag === "unavailable" ? (
          <CenteredMessage title={UNAVAILABLE_TITLES[panel.reason]} detail={panel.detail} />
        ) : (
          <div className="flex flex-col gap-2 p-2">
            {panel.map.machines.map((machine) => (
              <MachineCard key={machine.id} machine={machine} read={panel} />
            ))}
          </div>
        )}
      </ScrollArea>
      <footer className="flex items-center justify-between border-t border-border/60 px-2 py-1.5 text-2xs text-muted-foreground">
        <span>
          {panel?._tag === "read"
            ? `${panel.map.machines.length} machines · revision ${panel.map.revision}`
            : "Machine map"}
        </span>
        <div className="flex items-center gap-1">
          <Button size="xs" variant="ghost" onClick={query.refresh} disabled={query.isPending}>
            <RefreshCwIcon className="size-3.5" />
            Refresh
          </Button>
          <Button
            size="xs"
            variant="ghost"
            render={<a href={portalUrl} target="_blank" rel="noreferrer" />}
          >
            <ExternalLinkIcon className="size-3.5" />
            Open portal
          </Button>
        </div>
      </footer>
    </div>
  );
}

function CenteredMessage({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-2 p-6 text-center">
      <NetworkIcon aria-hidden className="size-6 text-muted-foreground/60" />
      <p className="text-sm font-medium">{title}</p>
      {detail.length > 0 ? (
        <p className="max-w-60 text-xs text-muted-foreground">{detail}</p>
      ) : null}
    </div>
  );
}

/** A future time, for example "in 14h", "soon" or "expired". */
const untilLabel = (isoDate: string) => {
  const until = formatRelativeTimeUntil(isoDate);
  if (until === null) return "";
  return until.suffix === null ? until.value.toLowerCase() : `in ${until.value}`;
};

const machineName = (read: MachinesReadResult, id: string) =>
  read.map.machines.find((machine) => machine.id === id)?.name ?? id;

const arrowLabel = (read: MachinesReadResult, arrow: ArrowRecord) =>
  `${machineName(read, arrow.from)} uses ${machineName(read, arrow.to)}: ${arrow.level}` +
  (arrow.agentTools ? ", agent tools" : "") +
  (arrow.expiresAt === null ? "" : `, ends ${untilLabel(arrow.expiresAt)}`);

/** An unknown kind of a newer portal shows as its raw name. */
const alertLabel = (alert: MachinesReadResult["resources"]["alerts"][number]) =>
  alert.kind === "offline"
    ? `Offline for ${Math.round(alert.value)} minutes`
    : `${alert.kind} ${Math.round(alert.value)}${alert.kind === "swap" ? " MB/s" : "%"} (limit ${alert.threshold})`;

function MachineCard({ machine, read }: { machine: MachineRecord; read: MachinesReadResult }) {
  const presence = read.presence[machine.id];
  const status = presence?.status ?? null;
  const queued = read.commands.filter(
    (command) => command.machineId === machine.id && command.status === "queued",
  ).length;
  const alerts = read.resources.alerts.filter(
    (alert) => alert.machineId === machine.id && alert.endedAt === null,
  );
  // Arrows at `none` give nothing, so only the ones that grant access show.
  const arrows = read.map.arrows.filter(
    (arrow) => arrow.from === machine.id && arrow.level !== "none",
  );
  const tasks = status?.tasks ?? [];

  return (
    <section className="flex flex-col gap-1.5 rounded-md border border-border/60 p-2 text-xs">
      <header className="flex items-center gap-2">
        <span
          aria-hidden
          className={`size-2 shrink-0 rounded-full ${presence?.online === true ? "bg-success" : "bg-muted-foreground/40"}`}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{machine.name}</span>
        {status !== null ? <Badge variant="outline">{status.build}</Badge> : null}
      </header>
      <p className="text-muted-foreground">
        {presence?.online === true
          ? "Online"
          : presence?.lastSeenAt
            ? `Offline, seen ${formatRelativeTimeLabel(presence.lastSeenAt)}`
            : "Never connected"}
        {status !== null
          ? ` · ${status.runningTurns} running · ${status.waitingThreads} waiting · ${queued} queued`
          : queued > 0
            ? ` · ${queued} queued`
            : ""}
      </p>
      {alerts.map((alert) => (
        <Badge key={alert.id} variant="warning" className="self-start">
          {alertLabel(alert)}
        </Badge>
      ))}
      {arrows.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {arrows.map((arrow) => (
            <li key={`${arrow.from}-${arrow.to}`}>{arrowLabel(read, arrow)}</li>
          ))}
        </ul>
      ) : null}
      {tasks.length > 0 ? (
        <ul className="flex flex-col gap-0.5 border-t border-border/40 pt-1.5">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate">{task.title}</span>
              <span className="shrink-0 text-muted-foreground">
                {task.enabled ? task.schedule : "Paused"}
                {task.enabled && task.nextRunAt !== null
                  ? ` · next ${untilLabel(task.nextRunAt)}`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * MM-1506, MM-1508: resources and health in the page. Bars on the machine cards, the Resources
 * part of the machine panel, and the Health view. Everything redraws only when a sample, an
 * alert or a fetch arrives; nothing animates.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { MachineId, MachineRecord } from "@t3tools/contracts/machineMap";
import {
  DEFAULT_HEALTH_THRESHOLDS,
  type HealthAlert,
  type HealthThresholds,
  type ResourceHistory,
  type ResourceProcess,
  type ResourceRange,
  type ResourceSample,
  type ResourcesOverview,
} from "@t3tools/contracts/machineMapResources";

import type { SampleResponse } from "../api.ts";
import { percentOf, pointOf, RANGE, thresholdsFor } from "../rules/health.ts";
import { callApi } from "./apiClient.ts";
import { chartLines, chartY, countMax, withLivePoint, type ChartFrame } from "./chart.ts";
import { usePortalContext } from "./context.ts";
import {
  ALERT_STICKER,
  ALERT_TEXT,
  alertValue,
  duration,
  formatBytes,
  formatPercent,
  PRESENCE_STICKER,
  presenceState,
  timeAgo,
} from "./format.ts";
import { KindIcon } from "./icons.tsx";
import { StickerLink } from "./StickerLink.tsx";

const RANGE_LABEL: Record<ResourceRange, string> = {
  hour: "1 hour",
  day: "24 hours",
  month: "30 days",
};
const RANGE_START: Record<ResourceRange, string> = {
  hour: "1 h ago",
  day: "24 h ago",
  month: "30 days ago",
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const machinePath = (id: string) => `/api/machines/${encodeURIComponent(id)}`;

export const activeAlerts = (
  alerts: ReadonlyArray<HealthAlert>,
  machineId: string,
): ReadonlyArray<HealthAlert> =>
  alerts.filter((alert) => alert.machineId === machineId && alert.endedAt === null);

/** MM-1501: asks an online machine for a fresh sample. A refusal is fine: one comes each minute. */
const requestSample = (machineId: string) => {
  callApi<SampleResponse>("POST", `${machinePath(machineId)}/sample`).catch(() => undefined);
};

/** The latest sample of an online machine. An offline machine has none: its last one is old news. */
function liveSample(health: ResourcesOverview, online: boolean, id: string): ResourceSample | null {
  return online ? (health.latest[id] ?? null) : null;
}

// ---------------------------------------------------------------- bars and stickers

function Meter({
  label,
  value,
  limit,
  detail,
}: {
  label: string;
  value: number | null;
  limit: number | null;
  detail?: string;
}) {
  const hot = value !== null && limit !== null && value > limit;
  return (
    <span className="meter">
      <span className="meter-label">{label}</span>
      <span className="meter-bar" aria-hidden>
        <span
          className={`meter-fill${hot ? " hot" : ""}`}
          style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%` }}
        />
      </span>
      <span className="meter-value">{detail ?? formatPercent(value)}</span>
    </span>
  );
}

/** MM-1506: the CPU and memory bars of a machine card. */
export function CardMeters({ machineId }: { machineId: MachineId }) {
  const { health, snapshot } = usePortalContext();
  const sample = liveSample(health, snapshot.presence[machineId]?.online === true, machineId);
  if (sample === null) return null;
  const limits = thresholdsFor(health.thresholds, machineId);
  return (
    <span className="meters">
      <Meter label="CPU" value={sample.cpuPercent} limit={limits.cpuPercent} />
      <Meter
        label="Memory"
        value={percentOf(sample.memoryUsedBytes, sample.memoryTotalBytes)}
        limit={limits.memoryPercent}
      />
    </span>
  );
}

/** MM-1505: one sticker per active alert. */
/** With `href`, each alert links there. The Health view leaves it out: its card is a button. */
export function AlertStickers({ machineId, href }: { machineId: MachineId; href?: string }) {
  const { health } = usePortalContext();
  return (
    <>
      {activeAlerts(health.alerts, machineId).map((alert) =>
        href === undefined ? (
          <span key={alert.id} className="sticker warn" aria-label={ALERT_TEXT[alert.kind]}>
            {ALERT_STICKER[alert.kind]}
          </span>
        ) : (
          <StickerLink
            key={alert.id}
            className="sticker warn"
            href={href}
            label={ALERT_TEXT[alert.kind]}
          >
            {ALERT_STICKER[alert.kind]}
          </StickerLink>
        ),
      )}
    </>
  );
}

// ---------------------------------------------------------------- charts

const CHART_WIDTH = 300;
const CHART_HEIGHT = 60;

interface Line {
  readonly values: ReadonlyArray<number | null>;
  readonly className: string;
}

function Chart({
  title,
  value,
  history,
  lines,
  max,
  limit,
  range,
  now,
}: {
  title: string;
  value: string;
  history: ResourceHistory;
  lines: ReadonlyArray<Line>;
  max: number;
  limit: number | null;
  range: ResourceRange;
  now: number;
}) {
  const frame: ChartFrame = {
    startMs: now - RANGE[range].spanMs,
    endMs: now,
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    max,
  };
  return (
    <figure className="chart">
      <figcaption>
        <span className="chart-title">{title}</span>
        <span className="chart-value">{value}</span>
      </figcaption>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${title}, ${RANGE_LABEL[range]}`}
      >
        <line
          className="grid"
          x1={0}
          x2={CHART_WIDTH}
          y1={CHART_HEIGHT / 2}
          y2={CHART_HEIGHT / 2}
        />
        {limit !== null && limit < max && (
          <line
            className="limit"
            x1={0}
            x2={CHART_WIDTH}
            y1={chartY(limit, frame)}
            y2={chartY(limit, frame)}
          />
        )}
        {lines.flatMap((line, i) =>
          chartLines(history.at, line.values, history.stepMs, frame).map((points, j) => (
            <polyline key={`${i}:${j}`} className={line.className} points={points} />
          )),
        )}
      </svg>
      <div className="chart-axis">
        <span>{RANGE_START[range]}</span>
        <span>now</span>
      </div>
    </figure>
  );
}

const lastValue = (values: ReadonlyArray<number | null>): number | null => {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i];
    if (value !== null && value !== undefined) return value;
  }
  return null;
};

/** The history of one machine and range, with the live sample on top for hour and day. */
function useHistory(machineId: string, range: ResourceRange, sample: ResourceSample | null) {
  const [history, setHistory] = useState<ResourceHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    setHistory(null);
    setError(null);
    callApi<ResourceHistory>("GET", `${machinePath(machineId)}/resources?range=${range}`)
      .then((loaded) => {
        if (!stale) setHistory(loaded);
      })
      .catch((cause: unknown) => {
        if (!stale) setError(errorText(cause));
      });
    return () => {
      stale = true;
    };
  }, [machineId, range]);
  const shown = useMemo(
    () =>
      history !== null && sample !== null && range !== "month"
        ? withLivePoint(history, Date.parse(sample.at), pointOf(sample), RANGE[range].spanMs)
        : history,
    [history, sample, range],
  );
  return { history: shown, error };
}

// ---------------------------------------------------------------- machine panel

const PROCESS_LIMIT = 5;

function ProcessTable({
  title,
  processes,
  empty,
}: {
  title: string;
  processes: ReadonlyArray<ResourceProcess> | null;
  empty: string;
}) {
  return (
    <div className="stack tight">
      <div className="small strong">{title}</div>
      {processes === null || processes.length === 0 ? (
        <p className="small muted">{empty}</p>
      ) : (
        <table className="procs">
          <tbody>
            {processes.slice(0, PROCESS_LIMIT).map((process, i) => (
              <tr key={`${process.name}:${i}`}>
                <td className="mono">{process.name}</td>
                <td className="num">
                  {process.cpuPercent === null ? "—" : `${Math.round(process.cpuPercent)}%`}
                </td>
                <td className="num">{formatBytes(process.memoryBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const usedOf = (used: number | null, total: number | null) =>
  used === null || total === null
    ? "—"
    : `${formatBytes(used)} of ${formatBytes(total)} (${formatPercent(percentOf(used, total))})`;

const perSecond = (bytes: number | null) => (bytes === null ? "—" : `${formatBytes(bytes)}/s`);

/** MM-1504: the thresholds of one machine. An empty field turns a check off. */
function ThresholdsForm({ machine }: { machine: MachineRecord }) {
  const portal = usePortalContext();
  const custom = portal.health.thresholds[machine.id];
  const current = custom ?? DEFAULT_HEALTH_THRESHOLDS;
  const [draft, setDraft] = useState(() => toFields(current));
  const field = (key: keyof HealthThresholds, label: string, unit: string, optional: boolean) => (
    <label className="field inline">
      {label}
      <input
        type="number"
        min={key.endsWith("Minutes") ? 1 : 0}
        max={key.endsWith("Percent") ? 100 : undefined}
        step="any"
        inputMode="decimal"
        value={draft[key]}
        placeholder={optional ? "off" : undefined}
        required={!optional}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      />
      <span className="muted">{unit}</span>
    </label>
  );
  const save = (event: FormEvent) => {
    event.preventDefault();
    const thresholds = fromFields(draft);
    if (thresholds === null) return;
    portal.call(
      () => callApi("POST", `${machinePath(machine.id)}/thresholds`, { thresholds }),
      `Saved the thresholds of ${machine.name}.`,
    );
  };
  return (
    <details className="more">
      <summary>Thresholds{custom ? " (own values)" : " (defaults)"}</summary>
      <form className="stack" onSubmit={save}>
        <div className="threshold-grid">
          {field("cpuPercent", "CPU above", "%", true)}
          {field("cpuMinutes", "for", "min", false)}
          {field("memoryPercent", "Memory above", "%", true)}
          {field("diskPercent", "Disk above", "%", true)}
          {field("swapMegabytesPerSecond", "Swap above", "MB/s", true)}
          {field("swapMinutes", "for", "min", false)}
          {field("offlineMinutes", "Offline for", "min", true)}
        </div>
        <div className="actions">
          <button type="submit" className="btn small primary">
            Save
          </button>
          <button
            type="button"
            className="btn small"
            disabled={!custom}
            onClick={() => {
              setDraft(toFields(DEFAULT_HEALTH_THRESHOLDS));
              portal.call(
                () =>
                  callApi("POST", `${machinePath(machine.id)}/thresholds`, { thresholds: null }),
                `${machine.name} uses the default thresholds.`,
              );
            }}
          >
            Use defaults
          </button>
        </div>
      </form>
    </details>
  );
}

type Fields = Record<keyof HealthThresholds, string>;

function toFields(t: HealthThresholds): Fields {
  const text = (value: number | null) => (value === null ? "" : String(value));
  return {
    cpuPercent: text(t.cpuPercent),
    cpuMinutes: text(t.cpuMinutes),
    memoryPercent: text(t.memoryPercent),
    diskPercent: text(t.diskPercent),
    swapMegabytesPerSecond: text(t.swapMegabytesPerSecond),
    swapMinutes: text(t.swapMinutes),
    offlineMinutes: text(t.offlineMinutes),
  };
}

/** Null when a required field is empty; the form's own checks catch that first. */
function fromFields(fields: Fields): HealthThresholds | null {
  const optional = (text: string) => (text.trim() === "" ? null : Number(text));
  const minutes = (text: string) => Math.max(1, Math.round(Number(text)));
  if (fields.cpuMinutes.trim() === "" || fields.swapMinutes.trim() === "") return null;
  const offline = optional(fields.offlineMinutes);
  return {
    cpuPercent: optional(fields.cpuPercent),
    cpuMinutes: minutes(fields.cpuMinutes),
    memoryPercent: optional(fields.memoryPercent),
    diskPercent: optional(fields.diskPercent),
    swapMegabytesPerSecond: optional(fields.swapMegabytesPerSecond),
    swapMinutes: minutes(fields.swapMinutes),
    offlineMinutes: offline === null ? null : minutes(String(offline)),
  };
}

function AlertList({
  alerts,
  showMachine,
}: {
  alerts: ReadonlyArray<HealthAlert>;
  showMachine: boolean;
}) {
  const { map, now, select } = usePortalContext();
  return (
    <ul className="alerts">
      {alerts.map((alert) => (
        <li key={alert.id} className={alert.endedAt === null ? "active" : "ended"}>
          <span className={`sticker ${alert.endedAt === null ? "warn" : "none"} flat`}>
            {ALERT_STICKER[alert.kind]}
          </span>
          <span className="grow">
            {showMachine && (
              <button
                type="button"
                className="link"
                onClick={() => select({ _tag: "machine", id: alert.machineId })}
              >
                {map.machines.find((m) => m.id === alert.machineId)?.name ?? alert.machineId}
              </button>
            )}
            {showMachine && " · "}
            {ALERT_TEXT[alert.kind]}: {alertValue(alert.kind, alert.value, alert.threshold)}
            <span className="small muted">
              {" "}
              · {alert.endedAt === null ? "since" : "started"} {timeAgo(alert.startedAt, now)}
              {alert.endedAt !== null &&
                `, lasted ${duration(alert.startedAt, Date.parse(alert.endedAt))}`}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** MM-1506: the Resources part of the machine panel. */
export function ResourcesSection({ machine }: { machine: MachineRecord }) {
  const portal = usePortalContext();
  const { health, snapshot, now } = portal;
  const [range, setRange] = useState<ResourceRange>("hour");
  const online = snapshot.presence[machine.id]?.online === true;
  const sample = liveSample(health, online, machine.id);
  const { history, error } = useHistory(machine.id, range, sample);
  const limits = thresholdsFor(health.thresholds, machine.id);
  const status = snapshot.presence[machine.id]?.status ?? null;
  const lastBundle = snapshot.commands.find(
    (c) => c.machineId === machine.id && c.input._tag === "collectDiagnostics",
  );

  useEffect(() => {
    if (online) requestSample(machine.id);
  }, [machine.id, online]);

  const machineAlerts = health.alerts.filter((alert) => alert.machineId === machine.id);
  const lastSample = health.latest[machine.id];

  return (
    <>
      <div className="seg wide" role="group" aria-label="Chart range">
        {(["hour", "day", "month"] as const).map((r) => (
          <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}>
            {RANGE_LABEL[r]}
          </button>
        ))}
      </div>
      {error !== null ? (
        <p className="small error-text">{error}</p>
      ) : history === null ? (
        <p className="small muted">Loading the history.</p>
      ) : history.at.length === 0 ? (
        <p className="small muted">
          No samples yet. A machine sends one each minute while it is online.
        </p>
      ) : (
        <div className="charts">
          <Chart
            title="CPU"
            value={formatPercent(lastValue(history.cpu))}
            history={history}
            lines={[
              ...(range === "month" ? [{ values: history.cpuMax, className: "peak" }] : []),
              { values: history.cpu, className: "line" },
            ]}
            max={100}
            limit={limits.cpuPercent}
            range={range}
            now={now}
          />
          <Chart
            title="Memory"
            value={formatPercent(lastValue(history.memory))}
            history={history}
            lines={[{ values: history.memory, className: "line" }]}
            max={100}
            limit={limits.memoryPercent}
            range={range}
            now={now}
          />
          <Chart
            title="Disk"
            value={formatPercent(lastValue(history.disk))}
            history={history}
            lines={[{ values: history.disk, className: "line" }]}
            max={100}
            limit={limits.diskPercent}
            range={range}
            now={now}
          />
          <Chart
            title="Agent processes"
            value={String(lastValue(history.agents) ?? "—")}
            history={history}
            lines={[{ values: history.agents, className: "line" }]}
            max={countMax(history.agents)}
            limit={null}
            range={range}
            now={now}
          />
        </div>
      )}

      {lastSample ? (
        <dl className="facts small">
          <dt>Sampled</dt>
          <dd>
            {timeAgo(lastSample.at, now)}
            {!online && " (offline)"}
          </dd>
          <dt>Load</dt>
          <dd>
            {lastSample.load === null ? "—" : lastSample.load.join(" · ")}
            {lastSample.cpuCount !== null && ` on ${lastSample.cpuCount} cores`}
          </dd>
          <dt>Memory</dt>
          <dd>{usedOf(lastSample.memoryUsedBytes, lastSample.memoryTotalBytes)}</dd>
          <dt>Swap</dt>
          <dd>
            {usedOf(lastSample.swapUsedBytes, lastSample.swapTotalBytes)}
            {lastSample.swapBytesPerSecond !== null &&
              ` · ${perSecond(lastSample.swapBytesPerSecond)}`}
          </dd>
          <dt>Disk</dt>
          <dd>{usedOf(lastSample.diskUsedBytes, lastSample.diskTotalBytes)}</dd>
          <dt>Network</dt>
          <dd>
            in {perSecond(lastSample.netInBytesPerSecond)} · out{" "}
            {perSecond(lastSample.netOutBytesPerSecond)}
          </dd>
          <dt>T3 server</dt>
          <dd>
            {lastSample.t3 === null
              ? "—"
              : `${formatPercent(lastSample.t3.cpuPercent)} CPU · ${formatBytes(lastSample.t3.memoryBytes)}`}
          </dd>
          <dt>Agents</dt>
          <dd>
            {lastSample.agents === null
              ? "—"
              : `${lastSample.agents.count} processes · ${formatPercent(lastSample.agents.cpuPercent)} CPU · ${formatBytes(lastSample.agents.memoryBytes)}`}
          </dd>
        </dl>
      ) : (
        <p className="small muted">This machine has not sent a resource sample yet.</p>
      )}

      {lastSample && (
        <div className="procs-grid">
          <ProcessTable
            title="Busiest now"
            processes={lastSample.topCpu}
            empty={
              lastSample.topMemory === null
                ? "Not available on this machine."
                : "Shows from the second sample on."
            }
          />
          <ProcessTable
            title="Most memory"
            processes={lastSample.topMemory}
            empty="Not available on this machine."
          />
        </div>
      )}

      <div className="actions spaced">
        {status?.commands.includes("collectDiagnostics") && (
          <button
            type="button"
            className="btn small"
            onClick={() => portal.command(machine.id, { _tag: "collectDiagnostics" })}
          >
            Collect diagnostics
          </button>
        )}
        {lastBundle && (
          <button
            type="button"
            className="btn small"
            onClick={() => portal.select({ _tag: "command", id: lastBundle.id })}
          >
            Last bundle
          </button>
        )}
      </div>

      {machineAlerts.length > 0 && <AlertList alerts={machineAlerts} showMachine={false} />}
      <ThresholdsForm
        key={JSON.stringify(health.thresholds[machine.id] ?? null)}
        machine={machine}
      />
    </>
  );
}

// ---------------------------------------------------------------- Health view

function Sparkline({ history, now }: { history: ResourceHistory; now: number }) {
  const frame: ChartFrame = {
    startMs: now - RANGE.hour.spanMs,
    endMs: now,
    width: CHART_WIDTH,
    height: 40,
    max: 100,
  };
  return (
    <svg
      className="spark"
      viewBox={`0 0 ${CHART_WIDTH} 40`}
      preserveAspectRatio="none"
      role="img"
      aria-label="CPU and memory, last hour"
    >
      {chartLines(history.at, history.memory, history.stepMs, frame).map((points, i) => (
        <polyline key={`m${i}`} className="line memory" points={points} />
      ))}
      {chartLines(history.at, history.cpu, history.stepMs, frame).map((points, i) => (
        <polyline key={`c${i}`} className="line" points={points} />
      ))}
    </svg>
  );
}

function HealthCard({ machine }: { machine: MachineRecord }) {
  const portal = usePortalContext();
  const { health, snapshot, now } = portal;
  const presence = snapshot.presence[machine.id];
  const state = presenceState(presence);
  const online = presence?.online === true;
  const sample = liveSample(health, online, machine.id);
  const { history } = useHistory(machine.id, "hour", sample);
  const limits = thresholdsFor(health.thresholds, machine.id);
  const on = portal.route.selection._tag === "machine" && portal.route.selection.id === machine.id;
  return (
    <button
      type="button"
      className={`card health-card${on ? " on" : ""}`}
      onClick={() => portal.select({ _tag: "machine", id: machine.id })}
      aria-label={`${machine.name}, ${state}`}
    >
      <span className="health-head">
        <span className="icon">
          <KindIcon kind={machine.kind} />
        </span>
        <span className="health-name">{machine.name}</span>
        <span className="stickers">
          <span className={`sticker ${PRESENCE_STICKER[state]}`}>{state}</span>
          <AlertStickers machineId={machine.id} />
        </span>
      </span>
      {sample === null ? (
        <span className="small muted">
          {state === "online"
            ? "Waiting for the first sample."
            : state === "offline"
              ? `Offline since ${timeAgo(presence?.lastSeenAt ?? null, now)}.`
              : "Waiting to join."}
        </span>
      ) : (
        <>
          <span className="meters">
            <Meter label="CPU" value={sample.cpuPercent} limit={limits.cpuPercent} />
            <Meter
              label="Memory"
              value={percentOf(sample.memoryUsedBytes, sample.memoryTotalBytes)}
              limit={limits.memoryPercent}
            />
            <Meter
              label="Disk"
              value={percentOf(sample.diskUsedBytes, sample.diskTotalBytes)}
              limit={limits.diskPercent}
            />
            <Meter
              label="Swap"
              value={percentOf(sample.swapUsedBytes, sample.swapTotalBytes)}
              limit={null}
              detail={
                sample.swapTotalBytes === 0
                  ? "none"
                  : formatPercent(percentOf(sample.swapUsedBytes, sample.swapTotalBytes))
              }
            />
          </span>
          <span className="health-facts small">
            <span>Load {sample.load === null ? "—" : sample.load[0]}</span>
            <span>
              Agents {sample.agents === null ? "—" : sample.agents.count}
              {sample.agents !== null && ` · ${formatPercent(sample.agents.cpuPercent)}`}
            </span>
            <span>Net {perSecond(sample.netInBytesPerSecond)} in</span>
          </span>
        </>
      )}
      {history !== null && history.at.length > 0 && <Sparkline history={history} now={now} />}
    </button>
  );
}

/** MM-1506: every machine side by side, and the alerts with when they started. */
export function HealthView() {
  const { map, health, snapshot } = usePortalContext();
  const onlineIds = map.machines
    .filter((m) => snapshot.presence[m.id]?.online === true)
    .map((m) => m.id)
    .join(",");
  useEffect(() => {
    for (const id of onlineIds.split(",")) if (id) requestSample(id);
  }, [onlineIds]);

  if (map.machines.length === 0) {
    return (
      <div className="card view">
        <div className="empty">
          <h3>No machines yet</h3>
          <p>Add a machine. Its CPU, memory and disk show here.</p>
        </div>
      </div>
    );
  }
  const active = health.alerts.filter((alert) => alert.endedAt === null);
  const ended = health.alerts.filter((alert) => alert.endedAt !== null);
  return (
    <div className="stack">
      <div className="health-grid">
        {map.machines.map((machine) => (
          <HealthCard key={machine.id} machine={machine} />
        ))}
      </div>
      <section className="card view stack">
        <h2>Alerts</h2>
        {active.length === 0 ? (
          <div className="empty compact-empty">
            <span className="stamp">✓ all clear</span>
            <p>No machine crosses a threshold now.</p>
          </div>
        ) : (
          <AlertList alerts={active} showMachine />
        )}
        {ended.length > 0 && (
          <>
            <h3 className="section">Ended</h3>
            <AlertList alerts={ended} showMachine />
          </>
        )}
      </section>
    </div>
  );
}

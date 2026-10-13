import { useEffect, useState, type ReactNode } from "react";
import type {
  MachineCommand,
  MachineMapDocument,
  MapActor,
  MapRevision,
} from "@t3tools/contracts/machineMap";

import type {
  DevicesResponse,
  MapAtResponse,
  SignOutEverywhereResponse,
  WriteResult,
} from "../api.ts";
import { usesText } from "../rules/access.ts";
import { effectiveSettings, findArrow, MAP_ROLES, roleRank } from "../rules/map.ts";
import { callApi } from "./apiClient.ts";
import { usePortalContext } from "./context.ts";
import { buildStandings } from "./build.ts";
import { BuildLabel, BuildSticker } from "./BuildLabel.tsx";
import { machineQueue } from "./derive.ts";
import {
  actorText,
  ALERT_STICKER,
  ALERT_TEXT,
  COMMAND_LABEL,
  COMMAND_STICKER,
  LEVEL_LABEL,
  machineName,
  PRESENCE_STICKER,
  presenceState,
  presenceText,
  shortTime,
  timeAgo,
  timeUntil,
  valueText,
} from "./format.ts";
import {
  actorKey,
  actorLabel,
  entryActor,
  entryKey,
  groupHistory,
  groupSummary,
  HISTORY_KIND,
  HISTORY_KINDS,
  historyEntries,
  localDay,
  matchesFilter,
  NO_FILTER,
  revisionDiff,
  type HistoryEntry,
  type HistoryFilter,
  type HistoryItem,
  type HistoryKind,
} from "./history.ts";
import { ClockIcon, RobotIcon, UndoIcon } from "./icons.tsx";
import { MapView } from "./MapView.tsx";

/** An empty list: a short title, what fills it, and a stamp when the empty state is good news. */
function Empty({
  title,
  settled = false,
  children,
}: {
  title: string;
  settled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      {settled && <span className="stamp">✓ all clear</span>}
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

/**
 * One row of a list. The whole row opens the item; buttons inside the row keep their own
 * action. The main part is a real button, so Tab and Enter reach it.
 */
function Item({
  on,
  open,
  label,
  children,
  side,
  kind,
}: {
  on: boolean;
  open: () => void;
  label: string;
  children: ReactNode;
  side?: ReactNode;
  /** MM-715: the history colours a row by its meaning. */
  kind?: HistoryKind;
}) {
  return (
    <li className={`item${on ? " on" : ""}${kind ? ` hk-${kind}` : ""}`}>
      <button type="button" className="item-main" aria-label={label} onClick={open}>
        {children}
      </button>
      {side}
    </li>
  );
}

/** MM-1102 Table: the arrow matrix and the machine list. */
export function TableView() {
  const portal = usePortalContext();
  const { map, snapshot, route, now } = portal;
  const standings = buildStandings(snapshot.presence);
  const selected = route.selection;
  if (map.machines.length === 0)
    return (
      <div className="card view">
        <Empty title="No machines yet">Add a machine. Its arrows show here as a grid.</Empty>
      </div>
    );
  return (
    <div className="card view stack">
      <h2>Who can use whom</h2>
      <p className="small muted">
        Each cell is what the machine of the row can do on the machine of the column.
      </p>
      <div className="scroll">
        <table className="matrix">
          <thead>
            <tr>
              <th className="corner" scope="col">
                Row uses column
              </th>
              {map.machines.map((m) => (
                <th key={m.id} scope="col">
                  {m.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {map.machines.map((from) => (
              <tr key={from.id}>
                <th scope="row">{from.name}</th>
                {map.machines.map((to) => {
                  if (from.id === to.id)
                    return <td key={to.id} className="self" aria-label="Same machine" />;
                  const arrow = findArrow(map, from.id, to.id);
                  const on =
                    selected._tag === "arrow" && selected.from === from.id && selected.to === to.id;
                  return (
                    <td key={to.id} className={`cell${on ? " on" : ""}`}>
                      <button
                        type="button"
                        className="cell-btn"
                        aria-label={`${usesText(from.name, to.name)}: ${LEVEL_LABEL[arrow.level]}`}
                        onClick={() => portal.select({ _tag: "arrow", from: from.id, to: to.id })}
                      >
                        <span className={`sticker lvl-${arrow.level}`}>
                          {LEVEL_LABEL[arrow.level]}
                        </span>
                        {(arrow.agentTools || arrow.expiresAt) && (
                          <span className="stickers">
                            {arrow.agentTools && <span className="sticker accent flat">tools</span>}
                            {arrow.expiresAt && <span className="sticker warn flat">temp</span>}
                          </span>
                        )}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Machines</h2>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th className="left" scope="col">
                Machine
              </th>
              <th scope="col">State</th>
              <th scope="col">Build</th>
              <th scope="col">Applied</th>
              <th scope="col">Map role</th>
            </tr>
          </thead>
          <tbody>
            {map.machines.map((machine) => {
              const presence = snapshot.presence[machine.id];
              const state = presenceState(presence);
              const on = selected._tag === "machine" && selected.id === machine.id;
              const applied = presence?.appliedRevision ?? null;
              return (
                <tr key={machine.id} className={on ? "on" : ""}>
                  <td className="left cell">
                    <button
                      type="button"
                      className="cell-btn left"
                      onClick={() => portal.select({ _tag: "machine", id: machine.id })}
                    >
                      <b>{machine.name}</b>
                    </button>
                  </td>
                  <td>
                    <span className={`sticker ${PRESENCE_STICKER[state]}`}>{state}</span>
                    {state === "offline" && (
                      <div className="small muted">
                        {timeAgo(presence?.lastSeenAt ?? null, now)}
                      </div>
                    )}
                  </td>
                  <td>
                    {presence?.status ? <BuildLabel status={presence.status} /> : "—"}{" "}
                    <BuildSticker standing={standings.get(machine.id)} />
                  </td>
                  <td className="mono">
                    {applied === null ? "—" : `${applied} of ${map.revision}`}
                  </td>
                  <td>
                    <select
                      aria-label={`Map role of ${machine.name}`}
                      value={machine.mapRole}
                      onChange={(e) => {
                        const role = MAP_ROLES.find((r) => r === e.target.value);
                        if (role)
                          portal.submit(`${machine.name} map role ${role}`, [
                            { _tag: "putMachine", machine: { ...machine, mapRole: role } },
                          ]);
                      }}
                    >
                      {MAP_ROLES.map((role) => (
                        <option
                          key={role}
                          value={role}
                          disabled={
                            portal.pause !== null && roleRank(role) > roleRank(machine.mapRole)
                          }
                        >
                          {role}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** MM-405: one row per managed setting, one column per machine, drift marked. */
export function SettingsView() {
  const portal = usePortalContext();
  const { map, snapshot, route } = portal;
  const managed = map.settings.managed;
  const selected = route.selection;
  return (
    <div className="card view stack">
      <div className="view-head">
        <div>
          <h2>Settings</h2>
          <p className="small muted">The map manages only the settings that you add here.</p>
        </div>
        <button
          type="button"
          className="btn primary"
          onClick={() => portal.open({ _tag: "manageSetting" })}
        >
          Manage a setting
        </button>
      </div>
      {managed.length === 0 ? (
        <Empty title="No managed settings yet">
          Pick a setting with "Manage a setting". Its value then syncs to every machine.
        </Empty>
      ) : (
        <>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th className="left" scope="col">
                    Setting
                  </th>
                  <th scope="col">Shared</th>
                  {map.machines.map((m) => (
                    <th key={m.id} scope="col">
                      {m.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {managed.map(({ scope, key }) => {
                  const shared = map.settings.shared[scope];
                  const hasShared = Object.hasOwn(shared, key);
                  const on =
                    selected._tag === "setting" && selected.scope === scope && selected.key === key;
                  const open = () => portal.select({ _tag: "setting", scope, key });
                  return (
                    <tr key={`${scope}.${key}`} className={on ? "on" : ""}>
                      <td className="left cell">
                        <button type="button" className="cell-btn left" onClick={open}>
                          <b className="mono-title">{key}</b>{" "}
                          <span className="small muted">{scope}</span>
                        </button>
                      </td>
                      <td>{hasShared ? valueText(shared[key]) : "—"}</td>
                      {map.machines.map((machine) => {
                        const own = map.settings.overrides[machine.id]?.[scope];
                        const hasOwn = own !== undefined && Object.hasOwn(own, key);
                        const effective = effectiveSettings(map, machine.id)[scope][key];
                        const reported = snapshot.reportedSettings[machine.id]?.[scope];
                        const reportedValue =
                          reported && Object.hasOwn(reported, key) ? reported[key] : undefined;
                        const drift =
                          hasOwn ||
                          (reportedValue !== undefined &&
                            hasShared &&
                            !sameValue(reportedValue, shared[key]));
                        const pending =
                          reportedValue !== undefined && !sameValue(reportedValue, effective);
                        return (
                          <td key={machine.id}>
                            {valueText(reportedValue ?? effective)}
                            {(drift || pending) && (
                              <div className="stickers">
                                {hasOwn && <span className="sticker warn flat">own</span>}
                                {drift && !hasOwn && <span className="sticker flat">drift</span>}
                                {pending && <span className="sticker wait flat">queued</span>}
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="legend small muted">
            <span>
              <span className="sticker warn flat">own</span> the machine keeps its own value
            </span>
            <span>
              <span className="sticker flat">drift</span> the machine reports another value
            </span>
            <span>
              <span className="sticker wait flat">queued</span> the new value waits for the machine
            </span>
          </p>
        </>
      )}
    </div>
  );
}

type QueueItem =
  | {
      readonly _tag: "revision";
      readonly at: string;
      readonly machineIds: Array<string>;
      readonly revision: MapRevision;
    }
  | { readonly _tag: "command"; readonly at: string; readonly command: MachineCommand }
  | {
      readonly _tag: "rotation";
      readonly at: string;
      readonly machineId: string;
      readonly expiresAt: string;
    };

/** MM-608: every queued change and command of every machine, oldest first. MM-606: recent results. */
export function QueueView() {
  const portal = usePortalContext();
  const { map, snapshot, now } = portal;
  const items: Array<QueueItem> = [];
  const byRevision = new Map<number, Extract<QueueItem, { _tag: "revision" }>>();
  for (const machine of map.machines) {
    const queue = machineQueue(snapshot, portal.rotations, machine);
    // MM-602, MM-603: a machine that never joined gets the current map when it joins.
    for (const revision of queue.waitingToJoin ? [] : queue.revisions) {
      const item = byRevision.get(revision.revision);
      if (item) item.machineIds.push(machine.id);
      else
        byRevision.set(revision.revision, {
          _tag: "revision",
          at: revision.at,
          machineIds: [machine.id],
          revision,
        });
    }
    for (const command of queue.commands)
      items.push({ _tag: "command", at: command.createdAt, command });
    if (queue.rotation) {
      items.push({
        _tag: "rotation",
        at: queue.rotation.createdAt,
        machineId: machine.id,
        expiresAt: queue.rotation.expiresAt,
      });
    }
  }
  items.push(...byRevision.values());
  items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const finished = snapshot.commands.filter((c) => c.status !== "queued").slice(0, 30);
  const selected = portal.route.selection;
  const names = (ids: ReadonlyArray<string>) => ids.map((id) => machineName(map, id)).join(", ");
  return (
    <div className="card view stack">
      <h2>Waiting</h2>
      {items.length === 0 ? (
        <Empty title="Nothing waits" settled>
          Every machine has the current map.
        </Empty>
      ) : (
        <ul className="list">
          {items.map((item) => {
            switch (item._tag) {
              case "revision":
                return (
                  <Item
                    key={`r${item.revision.revision}`}
                    on={false}
                    label={`Rev ${item.revision.revision}: ${item.revision.summary}`}
                    open={() =>
                      portal.select(
                        { _tag: "revision", revision: item.revision.revision },
                        "history",
                      )
                    }
                  >
                    <span className="rev">rev {item.revision.revision}</span>
                    <span className="grow">
                      <b>{item.revision.summary}</b>
                      <span className="sub">
                        Change for {names(item.machineIds)} · {timeAgo(item.at, now)}
                      </span>
                    </span>
                  </Item>
                );
              case "command": {
                const command = item.command;
                return (
                  <Item
                    key={command.id}
                    on={selected._tag === "command" && selected.id === command.id}
                    label={`${COMMAND_LABEL[command.input._tag]} on ${machineName(map, command.machineId)}`}
                    open={() => portal.select({ _tag: "command", id: command.id })}
                    side={
                      <button
                        type="button"
                        className="btn small danger"
                        onClick={() =>
                          portal.call(
                            () =>
                              callApi(
                                "POST",
                                `/api/commands/${encodeURIComponent(command.id)}/cancel`,
                              ),
                            "Cancelled.",
                          )
                        }
                      >
                        Cancel
                      </button>
                    }
                  >
                    <span className="rev">cmd</span>
                    <span className="grow">
                      <b>{COMMAND_LABEL[command.input._tag]}</b> on{" "}
                      {machineName(map, command.machineId)}
                      <span className="sub">
                        {command.delivery === "idle" ? "When online and idle" : "When online"} ·
                        expires {timeUntil(command.expiresAt, now)}
                      </span>
                    </span>
                  </Item>
                );
              }
              case "rotation":
                return (
                  <Item
                    key={`rot:${item.machineId}`}
                    on={false}
                    label={`Token rotation for ${machineName(map, item.machineId)}`}
                    open={() => portal.select({ _tag: "machine", id: item.machineId })}
                  >
                    <span className="rev">key</span>
                    <span className="grow">
                      <b>Token rotation</b> for {machineName(map, item.machineId)}
                      <span className="sub">expires {timeUntil(item.expiresAt, now)}</span>
                    </span>
                  </Item>
                );
            }
          })}
        </ul>
      )}
      <h2>Recent commands</h2>
      {finished.length === 0 ? (
        <Empty title="No commands yet">
          Commands that you or agents send show here with their result.
        </Empty>
      ) : (
        <ul className="list">
          {finished.map((command) => (
            <Item
              key={command.id}
              on={selected._tag === "command" && selected.id === command.id}
              label={`${COMMAND_LABEL[command.input._tag]} on ${machineName(map, command.machineId)}: ${command.status}`}
              open={() => portal.select({ _tag: "command", id: command.id })}
            >
              <span className="rev">cmd</span>
              <span className="grow">
                <b>{COMMAND_LABEL[command.input._tag]}</b> on {machineName(map, command.machineId)}
                <span className="sub">
                  {timeAgo(command.updatedAt, now)}
                  {command.error && ` · ${command.error}`}
                </span>
              </span>
              <span className={`sticker ${COMMAND_STICKER[command.status]}`}>{command.status}</span>
            </Item>
          ))}
        </ul>
      )}
    </div>
  );
}

/** MM-701 to MM-704, MM-714 to MM-716: revisions and commands newest first, with a time slider. */
export function HistoryView() {
  const portal = usePortalContext();
  const { map, now, history } = portal;
  const [atRevision, setAtRevision] = useState<number | null>(null);
  const [past, setPast] = useState<
    { revision: number; map: MachineMapDocument } | { revision: number; error: string } | null
  >(null);
  const [filter, setFilter] = useState<HistoryFilter>(NO_FILTER);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const viewing = atRevision !== null && atRevision !== map.revision ? atRevision : null;

  // MM-704: the slider shows the map at a revision, read only.
  useEffect(() => {
    if (viewing === null) return;
    let current = true;
    callApi<MapAtResponse>("GET", `/api/map-at?revision=${viewing}`)
      .then((response) => current && setPast({ revision: viewing, map: response.map }))
      .catch(
        (error: unknown) =>
          current &&
          setPast({
            revision: viewing,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    return () => {
      current = false;
    };
  }, [viewing]);
  const shown = past !== null && past.revision === viewing ? past : null;

  const entries = historyEntries(history, portal.snapshot.commands, portal.health.alerts);
  const actors = new Map<string, string>();
  for (const entry of entries) {
    const actor = entryActor(entry);
    actors.set(actorKey(actor), actorLabel(actor, map));
  }
  const days = groupHistory(entries.filter((entry) => matchesFilter(entry, filter)));
  const filtered =
    filter.machineId !== null ||
    filter.kind !== null ||
    filter.actor !== null ||
    filter.importantOnly;
  const selected = portal.route.selection;
  const oldest = history.at(-1)?.revision ?? 1;
  const today = localDay(new Date(now).toISOString());
  const yesterday = localDay(new Date(now - 86_400_000).toISOString());
  const dayLabel = (day: string) =>
    day === today
      ? "Today"
      : day === yesterday
        ? "Yesterday"
        : new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
            weekday: "long",
            day: "numeric",
            month: "long",
          });
  const undo = (revision: number) =>
    portal.call(
      () => callApi<WriteResult>("POST", "/api/undo", { revision }),
      `Undid rev ${revision}.`,
    );
  const when = (at: string) => (
    <time className="tip" dateTime={at} data-tip={shortTime(at)}>
      {timeAgo(at, now)}
    </time>
  );
  const kindSticker = (kind: HistoryKind) => (
    <span className={`sticker hk hk-${kind}`}>
      {kind === "expiry" && <ClockIcon label="Expiry" />}
      {HISTORY_KIND[kind].sticker}
    </span>
  );
  const agentSticker = (actor: MapActor) =>
    actor._tag === "agent" && (
      <span className="sticker hk hk-agent">
        <RobotIcon />
        agent
      </span>
    );

  const entryRow = (entry: HistoryEntry) => {
    if (entry._tag === "revision") {
      const revision = entry.revision;
      const diff = revisionDiff(revision, map);
      return (
        <Item
          key={`rev${revision.revision}`}
          kind={entry.kind}
          on={selected._tag === "revision" && selected.revision === revision.revision}
          label={`Rev ${revision.revision}: ${revision.summary}`}
          open={() => portal.select({ _tag: "revision", revision: revision.revision })}
          side={
            <>
              <button
                type="button"
                className="btn small"
                aria-label={`Undo rev ${revision.revision}`}
                onClick={() => undo(revision.revision)}
              >
                <UndoIcon />
                Undo
              </button>
              {diff.length > 0 && (
                <details className="diff">
                  <summary>Before and after</summary>
                  <table>
                    <tbody>
                      {diff.map((row) => (
                        <tr key={`${row.label}:${row.before}:${row.after}`}>
                          <th scope="row">{row.label}</th>
                          <td className="before">{row.before}</td>
                          <td aria-hidden>→</td>
                          <td className="after">{row.after}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </>
          }
        >
          {kindSticker(entry.kind)}
          <span className="grow">
            <b>{revision.summary}</b>
            <span className="sub">
              {actorText(revision.actor, map)} · {when(entry.at)} ·{" "}
              <span className="mono">rev {revision.revision}</span>
            </span>
          </span>
          {agentSticker(revision.actor)}
        </Item>
      );
    }
    if (entry._tag === "alert") {
      const { alert, ended } = entry;
      const title = `${ALERT_TEXT[alert.kind]} on ${machineName(map, alert.machineId)}${ended ? ": ended" : ""}`;
      return (
        <Item
          key={entryKey(entry)}
          kind="alert"
          on={false}
          label={title}
          open={() => portal.select({ _tag: "machine", id: alert.machineId })}
        >
          {kindSticker("alert")}
          <span className="grow">
            <b>{title}</b>
            <span className="sub">Portal · {when(entry.at)}</span>
          </span>
          <span className={`sticker ${ended ? "ok" : "warn"}`}>
            {ended ? "ended" : ALERT_STICKER[alert.kind]}
          </span>
        </Item>
      );
    }
    const command = entry.command;
    return (
      <Item
        key={command.id}
        kind="command"
        on={selected._tag === "command" && selected.id === command.id}
        label={`${COMMAND_LABEL[command.input._tag]} on ${machineName(map, command.machineId)}: ${command.status}`}
        open={() => portal.select({ _tag: "command", id: command.id })}
      >
        {kindSticker("command")}
        <span className="grow">
          <b>
            {COMMAND_LABEL[command.input._tag]} on {machineName(map, command.machineId)}
          </b>
          <span className="sub">
            {actorText(command.actor, map)} · {when(entry.at)}
          </span>
        </span>
        {agentSticker(command.actor)}
        <span className={`sticker ${COMMAND_STICKER[command.status]}`}>{command.status}</span>
      </Item>
    );
  };

  const groupRow = (group: Extract<HistoryItem, { _tag: "group" }>) => {
    const first = group.entries[0];
    if (!first) return null;
    const key = entryKey(first);
    const open = expanded.has(key);
    const actor = entryActor(first);
    const toggle = () =>
      setExpanded((current) => {
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        return next;
      });
    return (
      <li key={`group:${key}`} className={`item group hk-${group.kind}`}>
        <button type="button" className="item-main" aria-expanded={open} onClick={toggle}>
          {kindSticker(group.kind)}
          <span className="grow">
            <b>{groupSummary(group, map)}</b>
            <span className="sub">
              {actorText(actor, map)} · {when(first.at)}
            </span>
          </span>
          {agentSticker(actor)}
          <span className="more-toggle">{open ? "Hide" : `Show ${group.entries.length}`}</span>
        </button>
        {open && <ul className="list nested">{group.entries.map(entryRow)}</ul>}
      </li>
    );
  };

  return (
    <div className="stack">
      <div className="card view">
        <div className="slider">
          <label className="field" htmlFor="time-travel">
            <span>
              Time travel{" "}
              <span className="muted">
                {viewing === null
                  ? `now, rev ${map.revision}`
                  : `rev ${viewing} of ${map.revision}`}
              </span>
            </span>
          </label>
          <input
            id="time-travel"
            type="range"
            min={0}
            max={map.revision}
            value={atRevision ?? map.revision}
            onChange={(e) => setAtRevision(Number(e.target.value))}
          />
        </div>
        {viewing !== null && shown === null && (
          <p className="small muted">Loading rev {viewing}…</p>
        )}
        {shown && "error" in shown && <p className="error-text">{shown.error}</p>}
        {shown && "map" in shown && (
          <>
            <div className="readonly-banner">
              <span className="sticker wait">read only</span>
              <span className="grow">The map at rev {shown.revision}.</span>
              <button type="button" className="btn" onClick={() => setAtRevision(null)}>
                Back to now
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() =>
                  portal.open({
                    _tag: "confirm",
                    title: `Restore the map to rev ${shown.revision}?`,
                    body: "Every arrow, setting, machine fact, card place and note returns to how it was then, as one new revision. Undo reverses it.",
                    confirmLabel: "Restore",
                    tone: "primary",
                    action: () =>
                      portal.call(
                        () =>
                          callApi<WriteResult>("POST", "/api/restore", {
                            revision: shown.revision,
                          }),
                        `Restored the map to rev ${shown.revision}.`,
                      ),
                  })
                }
              >
                Restore
              </button>
            </div>
            <MapView map={shown.map} readOnly />
          </>
        )}
      </div>
      <div className="card view">
        <div className="history-filters" role="group" aria-label="Filter the history">
          <select
            aria-label="Machine"
            value={filter.machineId ?? ""}
            onChange={(e) => setFilter({ ...filter, machineId: e.target.value || null })}
          >
            <option value="">Every machine</option>
            {map.machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Kind"
            value={filter.kind ?? ""}
            onChange={(e) =>
              setFilter({
                ...filter,
                kind: HISTORY_KINDS.find((kind) => kind === e.target.value) ?? null,
              })
            }
          >
            <option value="">Every kind</option>
            {HISTORY_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {HISTORY_KIND[kind].label}
              </option>
            ))}
          </select>
          <select
            aria-label="Actor"
            value={filter.actor ?? ""}
            onChange={(e) => setFilter({ ...filter, actor: e.target.value || null })}
          >
            <option value="">Everyone</option>
            {[...actors].map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <label className="toggle">
            <input
              type="checkbox"
              className="switch"
              checked={filter.importantOnly}
              onChange={(e) => setFilter({ ...filter, importantOnly: e.target.checked })}
            />
            Important only
          </label>
          {filtered && (
            <button type="button" className="btn small" onClick={() => setFilter(NO_FILTER)}>
              Clear filters
            </button>
          )}
        </div>
        {entries.length === 0 ? (
          <Empty title="No history yet">Every change of the map shows here.</Empty>
        ) : days.length === 0 ? (
          <Empty title="Nothing matches">Clear a filter to see more of the history.</Empty>
        ) : (
          days.map(({ day, items }) => (
            <section key={day} className="history-day" aria-label={dayLabel(day)}>
              <h3 className="day-sep">
                <span>{dayLabel(day)}</span>
              </h3>
              <ul className="list">
                {items.map((item) =>
                  item._tag === "single" ? entryRow(item.entry) : groupRow(item),
                )}
              </ul>
            </section>
          ))
        )}
        {oldest > 1 && (
          <div className="actions centered">
            <button type="button" className="btn" onClick={portal.loadOlderHistory}>
              Load older revisions
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** MM-804. */
export function InboxView() {
  const portal = usePortalContext();
  const { snapshot, map, now } = portal;
  const selected = portal.route.selection;
  const decide = (id: string, verdict: "approve" | "reject") =>
    portal.call(
      async () => {
        const result = await callApi<WriteResult | { rejected: string }>(
          "POST",
          `/api/proposals/${encodeURIComponent(id)}/${verdict}`,
        );
        if (selected._tag === "proposal" && selected.id === id) portal.select({ _tag: "none" });
        return result;
      },
      verdict === "approve" ? "Approved." : "Rejected.",
    );
  return (
    <div className="card view stack">
      <h2>Inbox</h2>
      {snapshot.proposals.length === 0 ? (
        <Empty title="Inbox zero" settled>
          Agents with the map role "propose" send their changes here for you to approve.
        </Empty>
      ) : (
        <ul className="list">
          {snapshot.proposals.map((proposal) => (
            <Item
              key={proposal.id}
              on={selected._tag === "proposal" && selected.id === proposal.id}
              label={proposal.summary}
              open={() => portal.select({ _tag: "proposal", id: proposal.id })}
              side={
                <span className="actions">
                  <button
                    type="button"
                    className="btn small primary"
                    onClick={() => decide(proposal.id, "approve")}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn small danger"
                    onClick={() => decide(proposal.id, "reject")}
                  >
                    Reject
                  </button>
                </span>
              }
            >
              <span className="grow">
                <b>{proposal.summary}</b>
                <span className="sub">
                  {actorText(proposal.actor, map)} · {timeAgo(proposal.at, now)} · expires{" "}
                  {timeUntil(proposal.expiresAt, now)}
                </span>
              </span>
              <span className={`sticker ${proposal.reason === "self-escalation" ? "" : "wait"}`}>
                {proposal.reason === "self-escalation" ? "own access" : "proposal"}
              </span>
            </Item>
          ))}
        </ul>
      )}
    </div>
  );
}

/** MM-901 to MM-903. */
export function DevicesView() {
  const portal = usePortalContext();
  const { map, snapshot, now } = portal;
  const standings = buildStandings(snapshot.presence);
  const [devices, setDevices] = useState<DevicesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let current = true;
    callApi<DevicesResponse>("GET", "/api/devices")
      .then((response) => {
        if (!current) return;
        setDevices(response);
        setError(null);
      })
      .catch(
        (reason: unknown) =>
          current && setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `reload` is the refresh trigger of the button.
  }, [reload]);
  const load = () => {
    setLoading(true);
    setReload((n) => n + 1);
  };

  const signOutEverywhere = () =>
    portal.open({
      _tag: "confirm",
      title: "Sign out everywhere?",
      body: "This ends every owner sign-in in Cloudflare Access and every owner T3 session. Offline machines get it as a queued command. This page signs out too.",
      confirmLabel: "Sign out everywhere",
      action: () =>
        portal.call(async () => {
          const result = await callApi<SignOutEverywhereResponse>(
            "POST",
            "/api/devices/sign-out-everywhere",
          );
          return `${result.revokeCommands} T3 sessions revoked. ${result.accessMessage ?? "Cloudflare Access sessions ended."}`;
        }),
    });

  return (
    <div className="card view stack">
      <div className="view-head">
        <div>
          <h2>Devices</h2>
          <p className="small muted">Where you are signed in, to the portal and to each machine.</p>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={load} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
          <button type="button" className="btn danger" onClick={signOutEverywhere}>
            Sign out everywhere
          </button>
        </div>
      </div>
      {error && <p className="error-text">{error}</p>}
      <h3>Portal sign-ins</h3>
      {devices === null ? (
        <p className="small muted">
          {loading ? "Loading sign-ins…" : "No answer from the portal."}
        </p>
      ) : devices.portalSignIns.length === 0 ? (
        <p className="small muted">No sign-ins recorded.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th className="left" scope="col">
                  Device
                </th>
                <th scope="col">Browser</th>
                <th scope="col">Place</th>
                <th scope="col">Last use</th>
              </tr>
            </thead>
            <tbody>
              {devices.portalSignIns.map((signIn) => (
                <tr key={signIn.id}>
                  <td className="left">{signIn.device}</td>
                  <td>{signIn.browser}</td>
                  <td>{signIn.place}</td>
                  <td>{timeAgo(signIn.lastUsedAt, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>Cloudflare Access sessions</h3>
      {devices?.access._tag === "unavailable" && (
        <p className="small muted">{devices.access.message}</p>
      )}
      {devices?.access._tag === "available" &&
        (devices.access.sessions.length === 0 ? (
          <p className="small muted">No active sessions.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th className="left" scope="col">
                    Session
                  </th>
                  <th scope="col">Place</th>
                  <th scope="col">Address</th>
                  <th scope="col">Signed in</th>
                  <th scope="col">Expires</th>
                </tr>
              </thead>
              <tbody>
                {devices.access.sessions.map((session) => (
                  <tr key={`${session.name}:${session.signedInAt}:${session.ip}`}>
                    <td className="left">{session.name}</td>
                    <td>{session.country ?? "—"}</td>
                    <td className="mono">{session.ip ?? "—"}</td>
                    <td>{session.signedInAt ? timeAgo(session.signedInAt, now) : "—"}</td>
                    <td>{session.expiresAt ? shortTime(session.expiresAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      <h3>T3 sessions on machines</h3>
      {map.machines.length === 0 && <p className="small muted">No machines yet.</p>}
      {map.machines.map((machine) => {
        const presence = snapshot.presence[machine.id];
        const clients = presence?.status?.clients ?? [];
        return (
          <div key={machine.id} className="stack tight">
            <div className="section">
              {machine.name} · {presenceText(presence, now)}
              {presence?.status && (
                <>
                  {" · "}
                  <BuildLabel status={presence.status} />
                </>
              )}{" "}
              <BuildSticker standing={standings.get(machine.id)} />
            </div>
            {clients.length === 0 ? (
              <p className="small muted">No sessions reported.</p>
            ) : (
              <ul className="list">
                {clients.map((client) => (
                  <li key={client.sessionId} className="item static">
                    <span className="grow">
                      <b>{client.label ?? client.deviceType ?? "Client"}</b>
                      <span className="sub">
                        {[client.os, client.browser, client.subject].filter(Boolean).join(" · ")} ·{" "}
                        {client.connected ? "connected" : `seen ${timeAgo(client.lastSeenAt, now)}`}
                      </span>
                    </span>
                    {client.connected && <span className="sticker ok">live</span>}
                    <button
                      type="button"
                      className="btn small danger"
                      onClick={() =>
                        portal.command(machine.id, {
                          _tag: "revokeClient",
                          sessionId: client.sessionId,
                        })
                      }
                    >
                      Sign out
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

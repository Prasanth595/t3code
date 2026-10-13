import { useEffect, useState, type ReactNode } from "react";
import type {
  MachineCommand,
  MachineMapDocument,
  MapRevision,
} from "@t3tools/contracts/machineMap";

import type {
  DevicesResponse,
  MapAtResponse,
  SignOutEverywhereResponse,
  WriteResult,
} from "../api.ts";
import { effectiveSettings, findArrow, MAP_ROLES, roleRank } from "../rules/map.ts";
import { callApi } from "./apiClient.ts";
import { usePortalContext } from "./context.ts";
import { describeChange, machineQueue } from "./derive.ts";
import {
  actorText,
  COMMAND_LABEL,
  LEVEL_LABEL,
  machineName,
  presenceText,
  shortTime,
  timeAgo,
  timeUntil,
  valueText,
} from "./format.ts";
import { UndoIcon } from "./icons.tsx";
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

/** MM-1102 Table: the arrow matrix and the machine list. */
export function TableView() {
  const portal = usePortalContext();
  const { map, snapshot, route, now } = portal;
  const selected = route.selection;
  return (
    <div className="card view stack">
      <h2>Who can use whom</h2>
      <table>
        <thead>
          <tr>
            <th className="corner">Row can use column →</th>
            {map.machines.map((m) => (
              <th key={m.id}>{m.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {map.machines.map((from) => (
            <tr key={from.id}>
              <th>{from.name}</th>
              {map.machines.map((to) => {
                if (from.id === to.id) return <td key={to.id} className="self" />;
                const arrow = findArrow(map, from.id, to.id);
                const on =
                  selected._tag === "arrow" && selected.from === from.id && selected.to === to.id;
                return (
                  <td
                    key={to.id}
                    className={`cell${on ? " on" : ""}`}
                    onClick={() => portal.select({ _tag: "arrow", from: from.id, to: to.id })}
                  >
                    <span className={`sticker lvl-${arrow.level}`}>{LEVEL_LABEL[arrow.level]}</span>
                    {(arrow.agentTools || arrow.expiresAt) && (
                      <div className="stickers">
                        {arrow.agentTools && <span className="sticker accent flat">tools</span>}
                        {arrow.expiresAt && <span className="sticker warn flat">temp</span>}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="small muted">
        Each cell is what the row machine can do on the column machine.
      </div>
      <h2>Machines</h2>
      <table>
        <thead>
          <tr>
            <th className="left">Machine</th>
            <th>State</th>
            <th>Build</th>
            <th>Applied</th>
            <th>Map role</th>
          </tr>
        </thead>
        <tbody>
          {map.machines.map((machine) => {
            const presence = snapshot.presence[machine.id];
            const on = selected._tag === "machine" && selected.id === machine.id;
            return (
              <tr key={machine.id} className={on ? "on" : ""}>
                <td className="left">
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => portal.select({ _tag: "machine", id: machine.id })}
                  >
                    {machine.name}
                  </button>
                </td>
                <td>{presenceText(presence, now)}</td>
                <td className="mono">{presence?.status?.build ?? "—"}</td>
                <td className="mono">
                  {presence?.appliedRevision ?? "—"} / {map.revision}
                </td>
                <td>
                  <select
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
      <div className="actions">
        <button
          type="button"
          className="btn primary"
          onClick={() => portal.open({ _tag: "manageSetting" })}
        >
          Manage a setting
        </button>
        <span className="small muted">The map manages only the settings that you add here.</span>
      </div>
      {managed.length === 0 ? (
        <Empty title="No managed settings yet">
          Pick a setting with "Manage a setting". Its value then syncs to every machine.
        </Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="left">Setting</th>
              <th>Shared</th>
              {map.machines.map((m) => (
                <th key={m.id}>{m.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {managed.map(({ scope, key }) => {
              const shared = map.settings.shared[scope];
              const hasShared = Object.hasOwn(shared, key);
              const on =
                selected._tag === "setting" && selected.scope === scope && selected.key === key;
              return (
                <tr key={`${scope}.${key}`} className={on ? "on" : ""}>
                  <td
                    className="left cell"
                    onClick={() => portal.select({ _tag: "setting", scope, key })}
                  >
                    <b>{key}</b> <span className="small muted">{scope}</span>
                  </td>
                  <td
                    className="cell"
                    onClick={() => portal.select({ _tag: "setting", scope, key })}
                  >
                    {hasShared ? valueText(shared[key]) : "—"}
                  </td>
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
                      <td
                        key={machine.id}
                        className="cell"
                        onClick={() => portal.select({ _tag: "setting", scope, key })}
                      >
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
    for (const revision of queue.revisions) {
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
                  <li
                    key={`r${item.revision.revision}`}
                    className="item"
                    onClick={() =>
                      portal.select(
                        { _tag: "revision", revision: item.revision.revision },
                        "history",
                      )
                    }
                  >
                    <span className="rev">rev {item.revision.revision}</span>
                    <span className="grow">{item.revision.summary}</span>
                    {item.machineIds.map((machineId) => (
                      <span key={machineId} className="sticker wait">
                        for {machineName(map, machineId)}
                      </span>
                    ))}
                    <span className="small muted">{timeAgo(item.at, now)}</span>
                  </li>
                );
              case "command":
                return (
                  <li
                    key={item.command.id}
                    className={`item${selected._tag === "command" && selected.id === item.command.id ? " on" : ""}`}
                    onClick={() => portal.select({ _tag: "command", id: item.command.id })}
                  >
                    <span className="grow">
                      <b>{COMMAND_LABEL[item.command.input._tag]}</b> on{" "}
                      {machineName(map, item.command.machineId)}
                    </span>
                    <span className="sticker wait">
                      {item.command.delivery === "idle" ? "when idle" : "when online"}
                    </span>
                    <span className="small muted">
                      expires {timeUntil(item.command.expiresAt, now)}
                    </span>
                    <button
                      type="button"
                      className="btn small danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        portal.call(
                          () =>
                            callApi(
                              "POST",
                              `/api/commands/${encodeURIComponent(item.command.id)}/cancel`,
                            ),
                          "Cancelled.",
                        );
                      }}
                    >
                      Cancel
                    </button>
                  </li>
                );
              case "rotation":
                return (
                  <li
                    key={`rot:${item.machineId}`}
                    className="item"
                    onClick={() => portal.select({ _tag: "machine", id: item.machineId })}
                  >
                    <span className="grow">
                      <b>Token rotation</b> for {machineName(map, item.machineId)}
                    </span>
                    <span className="small muted">expires {timeUntil(item.expiresAt, now)}</span>
                  </li>
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
            <li
              key={command.id}
              className={`item${selected._tag === "command" && selected.id === command.id ? " on" : ""}`}
              onClick={() => portal.select({ _tag: "command", id: command.id })}
            >
              <span className="grow">
                <b>{COMMAND_LABEL[command.input._tag]}</b> on {machineName(map, command.machineId)}
                {command.error && <span className="small muted"> · {command.error}</span>}
              </span>
              <span
                className={`sticker ${command.status === "succeeded" ? "ok" : command.status === "delivered" ? "wait" : ""}`}
              >
                {command.status}
              </span>
              <span className="small muted">{timeAgo(command.updatedAt, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** MM-701 to MM-704, MM-503: revisions and commands newest first, with a time slider. */
export function HistoryView() {
  const portal = usePortalContext();
  const { map, now, history } = portal;
  const [atRevision, setAtRevision] = useState<number | null>(null);
  const [past, setPast] = useState<
    { revision: number; map: MachineMapDocument } | { revision: number; error: string } | null
  >(null);
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

  const entries: Array<{ at: string; revision?: MapRevision; command?: MachineCommand }> = [
    ...history.map((revision) => ({ at: revision.at, revision })),
    ...portal.snapshot.commands.map((command) => ({ at: command.createdAt, command })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const selected = portal.route.selection;
  const oldest = history.at(-1)?.revision ?? 1;

  return (
    <div className="stack">
      <div className="card view">
        <div className="slider">
          <label className="field">
            Map at revision {atRevision ?? map.revision}
            <input
              type="range"
              min={0}
              max={map.revision}
              value={atRevision ?? map.revision}
              onChange={(e) => setAtRevision(Number(e.target.value))}
            />
          </label>
        </div>
        {shown && "error" in shown && (
          <div className="small" style={{ color: "var(--error-fg)" }}>
            {shown.error}
          </div>
        )}
        {shown && "map" in shown && (
          <>
            <div className="readonly-banner">
              <span className="sticker wait">read only</span>
              <span>The map at rev {shown.revision}.</span>
              <button
                type="button"
                className="btn primary"
                onClick={() =>
                  portal.call(
                    () =>
                      callApi<WriteResult>("POST", "/api/restore", { revision: shown.revision }),
                    `Restored the map to rev ${shown.revision}.`,
                  )
                }
              >
                Restore
              </button>
              <button type="button" className="btn" onClick={() => setAtRevision(null)}>
                Back to now
              </button>
            </div>
            <MapView map={shown.map} readOnly />
          </>
        )}
      </div>
      <div className="card view">
        {entries.length === 0 ? (
          <Empty title="No history yet">Every change of the map shows here.</Empty>
        ) : (
          <ul className="list">
            {entries.map((entry) =>
              entry.revision ? (
                <li
                  key={`rev${entry.revision.revision}`}
                  className={`item${selected._tag === "revision" && selected.revision === entry.revision.revision ? " on" : ""}`}
                  onClick={() =>
                    entry.revision &&
                    portal.select({ _tag: "revision", revision: entry.revision.revision })
                  }
                >
                  <span className="rev">rev {entry.revision.revision}</span>
                  <span className="grow">
                    <b>{entry.revision.summary}</b>
                    <div className="small muted">
                      {actorText(entry.revision.actor, map)} · {timeAgo(entry.at, now)}
                    </div>
                    <div className="small muted">
                      {entry.revision.changes
                        .slice(0, 3)
                        .map((c) => describeChange(c, map))
                        .join(" · ")}
                      {entry.revision.changes.length > 3 &&
                        ` · ${entry.revision.changes.length - 3} more`}
                    </div>
                  </span>
                  <button
                    type="button"
                    className="btn small"
                    onClick={(e) => {
                      e.stopPropagation();
                      const revision = entry.revision?.revision;
                      if (revision !== undefined) {
                        portal.call(
                          () => callApi<WriteResult>("POST", "/api/undo", { revision }),
                          `Undid rev ${revision}.`,
                        );
                      }
                    }}
                  >
                    <UndoIcon />
                    Undo
                  </button>
                </li>
              ) : entry.command ? (
                <li
                  key={entry.command.id}
                  className={`item${selected._tag === "command" && selected.id === entry.command.id ? " on" : ""}`}
                  onClick={() =>
                    entry.command && portal.select({ _tag: "command", id: entry.command.id })
                  }
                >
                  <span className="rev">cmd</span>
                  <span className="grow">
                    <b>
                      {COMMAND_LABEL[entry.command.input._tag]} on{" "}
                      {machineName(map, entry.command.machineId)}
                    </b>
                    <div className="small muted">
                      {actorText(entry.command.actor, map)} · {timeAgo(entry.at, now)}
                    </div>
                  </span>
                  <span
                    className={`sticker ${entry.command.status === "succeeded" ? "ok" : entry.command.status === "queued" || entry.command.status === "delivered" ? "wait" : ""}`}
                  >
                    {entry.command.status}
                  </span>
                </li>
              ) : null,
            )}
          </ul>
        )}
        {oldest > 1 && (
          <div className="actions" style={{ marginTop: 10 }}>
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
  return (
    <div className="card view">
      {snapshot.proposals.length === 0 ? (
        <Empty title="Inbox zero" settled>
          Agents with the map role "propose" send their changes here for you to approve.
        </Empty>
      ) : (
        <ul className="list">
          {snapshot.proposals.map((proposal) => (
            <li
              key={proposal.id}
              className={`item${selected._tag === "proposal" && selected.id === proposal.id ? " on" : ""}`}
              onClick={() => portal.select({ _tag: "proposal", id: proposal.id })}
            >
              <span className="grow">
                <b>{proposal.summary}</b>
                <div className="small muted">
                  {actorText(proposal.actor, map)} · {timeAgo(proposal.at, now)} · expires{" "}
                  {timeUntil(proposal.expiresAt, now)}
                </div>
              </span>
              <span className={`sticker ${proposal.reason === "self-escalation" ? "" : "wait"}`}>
                {proposal.reason === "self-escalation" ? "own access" : "proposal"}
              </span>
            </li>
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
      body: "This ends every owner sign-in in Cloudflare Access and every owner T3 session. Offline machines get it as a queued command.",
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
      <div className="actions">
        <button type="button" className="btn danger" onClick={signOutEverywhere}>
          Sign out everywhere
        </button>
        <button type="button" className="btn" onClick={load} disabled={loading}>
          {loading ? "Loading" : "Refresh"}
        </button>
      </div>
      {error && (
        <div className="small" style={{ color: "var(--error-fg)" }}>
          {error}
        </div>
      )}
      <h2>Portal sign-ins</h2>
      {devices && devices.portalSignIns.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th className="left">Device</th>
              <th>Browser</th>
              <th>Place</th>
              <th>Last use</th>
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
      ) : (
        <div className="small muted">{devices ? "No sign-ins recorded." : ""}</div>
      )}
      <h2>Cloudflare Access sessions</h2>
      {devices?.access._tag === "unavailable" && (
        <div className="small muted">{devices.access.message}</div>
      )}
      {devices?.access._tag === "available" &&
        (devices.access.sessions.length === 0 ? (
          <div className="small muted">No active sessions.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="left">Session</th>
                <th>Place</th>
                <th>Address</th>
                <th>Signed in</th>
                <th>Expires</th>
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
        ))}
      <h2>T3 sessions on machines</h2>
      {map.machines.map((machine) => {
        const presence = snapshot.presence[machine.id];
        const clients = presence?.status?.clients ?? [];
        return (
          <div key={machine.id} className="stack">
            <div className="section">
              {machine.name} · {presenceText(presence, now)}
            </div>
            {clients.length === 0 ? (
              <div className="small muted">No sessions reported.</div>
            ) : (
              <ul className="list">
                {clients.map((client) => (
                  <li key={client.sessionId} className="item">
                    <span className="grow">
                      <b>{client.label ?? client.deviceType ?? "Client"}</b>
                      <div className="small muted">
                        {[client.os, client.browser, client.subject].filter(Boolean).join(" · ")} ·{" "}
                        {client.connected ? "connected" : `seen ${timeAgo(client.lastSeenAt, now)}`}
                      </div>
                    </span>
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

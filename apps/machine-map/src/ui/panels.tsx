import { useState } from "react";
import {
  MACHINE_LEVEL_SCOPES,
  type CommandDelivery,
  type MachineCommandInput,
  type MachineId,
  type MachineLevel,
  type MachineMapRole,
  type MachineRecord,
  type SettingScope,
} from "@t3tools/contracts/machineMap";

import type { WriteResult } from "../api.ts";
import { arrowChange } from "../rules/access.ts";
import {
  effectiveSettings,
  findArrow,
  findMachine,
  LEVELS,
  levelRank,
  MAP_ROLES,
  roleRank,
} from "../rules/map.ts";
import { DEFAULT_COMMAND_MINUTES } from "../rules/queue.ts";
import { callApi } from "./apiClient.ts";
import { usePortalContext, type CommandOptions } from "./context.ts";
import { arrowApplied, describeChange, machineQueue } from "./derive.ts";
import {
  actorText,
  COMMAND_LABEL,
  DANGEROUS_COMMANDS,
  LEVEL_LABEL,
  LEVEL_TEXT,
  machineName,
  presenceText,
  ROLE_TEXT,
  shortTime,
  timeAgo,
  timeUntil,
  valueText,
} from "./format.ts";
import { KindIcon } from "./icons.tsx";
import { NO_SELECTION, type Selection } from "./route.ts";
import { settingControl, settingProblem } from "./settingControls.ts";

export function Panel({ selection }: { selection: Selection }) {
  const portal = usePortalContext();
  const body = (() => {
    switch (selection._tag) {
      case "none":
        return null;
      case "arrow":
        return <ArrowPanel from={selection.from} to={selection.to} />;
      case "machine":
        return <MachinePanel id={selection.id} />;
      case "revision":
        return <RevisionPanel revision={selection.revision} />;
      case "proposal":
        return <ProposalPanel id={selection.id} />;
      case "setting":
        return <SettingPanel scope={selection.scope} settingKey={selection.key} />;
      case "command":
        return <CommandPanel id={selection.id} />;
    }
  })();
  if (!body) return null;
  return (
    <aside className="card panel">
      <div className="head">
        <div />
        <button
          type="button"
          className="btn small close"
          onClick={() => portal.select(NO_SELECTION)}
        >
          Close
        </button>
      </div>
      {body}
    </aside>
  );
}

const Missing = ({ what }: { what: string }) => (
  <div className="muted">This {what} is no longer here.</div>
);

/** MM-711: while paused, access only goes down, so raising controls are off. */
const PausedNote = () => (
  <div className="paused-note">
    <span className="sticker">paused</span> Access only goes down until you resume.
  </div>
);

type Duration = "permanent" | "hour" | "day" | "until";

/** MM-304: null for a permanent level, undefined for a time that is not in the future. */
function durationExpiry(duration: Duration, until: string, now: number): string | null | undefined {
  if (duration === "permanent") return null;
  if (duration === "hour") return new Date(now + 3_600_000).toISOString();
  if (duration === "day") return new Date(now + 86_400_000).toISOString();
  const at = Date.parse(until);
  return Number.isNaN(at) || at <= now ? undefined : new Date(at).toISOString();
}

/** MM-301 to MM-307, MM-604. */
function ArrowPanel({ from, to }: { from: string; to: string }) {
  const portal = usePortalContext();
  const { map, snapshot, now } = portal;
  const [duration, setDuration] = useState<Duration>("permanent");
  const [until, setUntil] = useState("");
  const source = map.machines.find((m) => m.id === from);
  const target = map.machines.find((m) => m.id === to);
  if (!source || !target || source.id === target.id) return <Missing what="arrow" />;
  const arrow = findArrow(map, source.id, target.id);
  const f = source.name;
  const t = target.name;

  const setLevel = (level: MachineLevel) => {
    // oxlint-disable-next-line react/purity -- This runs in a click handler, not during render.
    const expiry = durationExpiry(duration, until, Date.now());
    if (expiry === undefined) {
      portal.call(() => Promise.reject(new Error("Pick a time in the future.")));
      return;
    }
    const suffix = expiry === null ? "" : ` until ${shortTime(expiry)}`;
    portal.submit(`${f} → ${t} set to ${LEVEL_LABEL[level]}${suffix}`, [
      arrowChange(map, { from: source.id, to: target.id, level, expiresAt: expiry }),
    ]);
  };

  const applied = arrowApplied(snapshot, source.id, target.id);
  const online = (id: MachineId) => snapshot.presence[id]?.online === true;
  const appliedText = [
    applied.to ? `applied on ${t}` : `queued for ${t}${online(target.id) ? "" : " (offline)"}`,
    applied.from ? `applied on ${f}` : `queued for ${f}${online(source.id) ? "" : " (offline)"}`,
  ].join(", ");
  const lastTest = snapshot.commands.find(
    (c) => c.machineId === source.id && c.input._tag === "testArrow" && c.input.to === target.id,
  );

  return (
    <>
      <h2>
        {f} → {t}
      </h2>
      <div className="desc">
        What {f} can do on {t}.
      </div>
      {portal.pause && <PausedNote />}
      <div className="section">Duration</div>
      <div className="seg wide">
        {(["permanent", "hour", "day", "until"] as const).map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={duration === d}
            onClick={() => setDuration(d)}
          >
            {{ permanent: "Always", hour: "1 hour", day: "1 day", until: "Until…" }[d]}
          </button>
        ))}
      </div>
      {duration === "until" && (
        <input
          type="datetime-local"
          value={until}
          onChange={(e) => setUntil(e.target.value)}
          style={{ marginTop: 6 }}
        />
      )}
      <div className="section">Level</div>
      <div className="seg wide">
        {LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            aria-pressed={arrow.level === level}
            disabled={portal.pause !== null && levelRank(level) > levelRank(arrow.level)}
            onClick={() => setLevel(level)}
          >
            {LEVEL_LABEL[level]}
          </button>
        ))}
      </div>
      <div className="desc">{LEVEL_TEXT[arrow.level]}</div>
      {arrow.level !== "none" && (
        <div className="small muted mono">{MACHINE_LEVEL_SCOPES[arrow.level].join(", ")}</div>
      )}
      {arrow.expiresAt && arrow.revertLevel && (
        <div className="row">
          <div className="v">
            Returns to {LEVEL_LABEL[arrow.revertLevel]} {timeUntil(arrow.expiresAt, now)}.
          </div>
          <button
            type="button"
            className="btn small"
            onClick={() =>
              portal.submit(`${f} → ${t} made permanent`, [
                arrowChange(map, {
                  from: source.id,
                  to: target.id,
                  level: arrow.level,
                  expiresAt: null,
                }),
              ])
            }
          >
            Keep
          </button>
        </div>
      )}
      <div className="section">Agents</div>
      <div className="row">
        <div>
          <div className="t">
            Agents on {f} use {t}'s T3 tools
          </div>
          <div className="v">Within the scopes of the level.</div>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={arrow.agentTools}
          disabled={portal.pause !== null && !arrow.agentTools}
          onChange={(e) =>
            portal.submit(`${f} → ${t} agent tools ${e.target.checked ? "on" : "off"}`, [
              arrowChange(map, {
                from: source.id,
                to: target.id,
                level: arrow.level,
                agentTools: e.target.checked,
                expiresAt: arrow.expiresAt,
              }),
            ])
          }
        />
      </div>
      <div className="section">State</div>
      <div className="v small">{appliedText}</div>
      <div className="actions" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn"
          onClick={() => portal.command(source.id, { _tag: "testArrow", to: target.id })}
        >
          Test
        </button>
        {lastTest && (
          <span
            className={`sticker ${lastTest.status === "succeeded" ? "ok" : lastTest.status === "failed" ? "" : "wait"}`}
          >
            {lastTest.status}
          </span>
        )}
      </div>
      {lastTest?.result != null && <pre>{JSON.stringify(lastTest.result, null, 2)}</pre>}
      {lastTest?.error && (
        <div className="small" style={{ color: "var(--error-fg)" }}>
          {lastTest.error}
        </div>
      )}
      <p className="desc">
        {f} proves who it is with its own Cloudflare service token,{" "}
        <code>{source.tokenClientId}</code>. {t} applies a change in under a second and ends open
        sessions from {f} when access drops.
      </p>
    </>
  );
}

/** Commands without input, in the order of the panel. */
const SIMPLE_COMMANDS: ReadonlyArray<
  Extract<
    MachineCommandInput,
    {
      _tag:
        | "collectDiagnostics"
        | "reloadWindows"
        | "pauseScheduledTasks"
        | "resumeScheduledTasks"
        | "stopAllAgents"
        | "restartServer";
    }
  >
> = [
  { _tag: "collectDiagnostics" },
  { _tag: "reloadWindows" },
  { _tag: "pauseScheduledTasks" },
  { _tag: "resumeScheduledTasks" },
  { _tag: "stopAllAgents" },
  { _tag: "restartServer" },
];

/** MM-206, MM-207, MM-208, MM-5xx, MM-1003, MM-1004. */
function MachinePanel({ id }: { id: string }) {
  const portal = usePortalContext();
  const { map, snapshot, now } = portal;
  const [delivery, setDelivery] = useState<CommandDelivery>("online");
  const [expiresInMinutes, setExpiry] = useState(DEFAULT_COMMAND_MINUTES);
  const [thread, setThread] = useState({ projectId: "", title: "", message: "" });
  const machine = map.machines.find((m) => m.id === id);
  if (!machine) return <Missing what="machine" />;
  const presence = snapshot.presence[machine.id];
  const status = presence?.status ?? null;
  const supported = new Set(status?.commands ?? []);
  const options: CommandOptions = { delivery, expiresInMinutes };
  const queue = machineQueue(snapshot, portal.rotations, machine);
  const put = (summary: string, next: MachineRecord) =>
    portal.submit(summary, [{ _tag: "putMachine", machine: next }]);

  const rename = () => {
    const name = window.prompt("New name", machine.name)?.trim();
    if (name && name !== machine.name)
      put(`Renamed ${machine.name} to ${name}`, { ...machine, name });
  };

  const settings = effectiveSettings(map, machine.id);
  const own = map.settings.overrides[machine.id];

  return (
    <>
      <h2 className="with-icon">
        <span className="icon">
          <KindIcon kind={machine.kind} />
        </span>
        {machine.name}
      </h2>
      <div className="desc">
        <span className="mono">{machine.id}</span> · applied rev{" "}
        {presence?.appliedRevision ?? "none"} of {map.revision}
      </div>
      <div className="actions" style={{ marginTop: 8 }}>
        <span className={`sticker ${presence?.online ? "ok" : "wait"}`}>
          {presenceText(presence, now)}
        </span>
        {status && status.runningTurns > 0 && (
          <span className="sticker ok">{status.runningTurns} running</span>
        )}
        {status && status.waitingThreads > 0 && (
          <span className="sticker wait">{status.waitingThreads} wait for you</span>
        )}
        {status?.updateWaiting && (
          <span className="sticker info">update {status.updateWaiting}</span>
        )}
        {queue.count > 0 && <span className="sticker wait">{queue.count} queued</span>}
      </div>
      <div className="actions" style={{ marginTop: 10 }}>
        {machine.hostname ? (
          <a
            className="btn primary"
            href={`https://${machine.hostname}`}
            target="_blank"
            rel="noreferrer"
          >
            Open
          </a>
        ) : (
          <button type="button" className="btn" disabled>
            Open
          </button>
        )}
        <button type="button" className="btn" onClick={rename}>
          Rename
        </button>
        <select
          value={machine.kind}
          onChange={(e) => {
            const kind = e.target.value;
            if (kind === "laptop" || kind === "desktop" || kind === "server") {
              put(`${machine.name} is a ${kind}`, { ...machine, kind });
            }
          }}
        >
          <option value="laptop">Laptop</option>
          <option value="desktop">Desktop</option>
          <option value="server">Server</option>
        </select>
      </div>

      <div className="section">Status</div>
      {status ? (
        <div className="small">
          <div>
            T3 {status.t3Version} · <span className="mono">{status.build}</span>
          </div>
          <div className="muted">
            up {Math.round(status.uptimeSeconds / 3600)} h · {status.scheduledTasks} scheduled tasks
            {status.cpuPercent !== null && ` · CPU ${Math.round(status.cpuPercent)}%`}
            {status.memoryPercent !== null && ` · memory ${Math.round(status.memoryPercent)}%`}
          </div>
          <div className="muted">{machine.hostname ?? "no hostname yet"}</div>
        </div>
      ) : (
        <div className="small muted">
          No status yet. The machine shows here after its first connection.
        </div>
      )}

      <div className="section">Map role</div>
      {portal.pause && <PausedNote />}
      <div className="seg wide">
        {MAP_ROLES.map((role: MachineMapRole) => (
          <button
            key={role}
            type="button"
            aria-pressed={machine.mapRole === role}
            disabled={portal.pause !== null && roleRank(role) > roleRank(machine.mapRole)}
            onClick={() => put(`${machine.name} map role ${role}`, { ...machine, mapRole: role })}
          >
            {role}
          </button>
        ))}
      </div>
      <div className="desc">{ROLE_TEXT[machine.mapRole]}</div>

      <div className="section">Commands</div>
      <div className="actions">
        <select
          value={delivery}
          onChange={(e) => setDelivery(e.target.value === "idle" ? "idle" : "online")}
        >
          <option value="online">When online</option>
          <option value="idle">When online and idle</option>
        </select>
        <select value={expiresInMinutes} onChange={(e) => setExpiry(Number(e.target.value))}>
          <option value={60}>Expires in 1 h</option>
          <option value={DEFAULT_COMMAND_MINUTES}>Expires in 24 h</option>
          <option value={7 * 24 * 60}>Expires in 7 d</option>
        </select>
      </div>
      <div className="actions" style={{ marginTop: 8 }}>
        {status === null && (
          <span className="small muted">Commands show after the machine reports them.</span>
        )}
        {SIMPLE_COMMANDS.filter((input) => supported.has(input._tag)).map((input) => (
          <button
            key={input._tag}
            type="button"
            className={`btn small${DANGEROUS_COMMANDS.has(input._tag) ? " danger" : ""}`}
            onClick={() => portal.command(machine.id, input, options)}
          >
            {COMMAND_LABEL[input._tag]}
          </button>
        ))}
        {supported.has("installUpdate") && (
          <>
            <button
              type="button"
              className="btn small"
              onClick={() =>
                portal.command(machine.id, { _tag: "installUpdate", whenIdle: false }, options)
              }
            >
              Install update now
            </button>
            <button
              type="button"
              className="btn small"
              onClick={() =>
                portal.command(machine.id, { _tag: "installUpdate", whenIdle: true }, options)
              }
            >
              Install update when idle
            </button>
          </>
        )}
      </div>
      {supported.has("startThread") && (
        <form
          className="stack"
          style={{ marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            const projectId = thread.projectId.trim();
            const title = thread.title.trim();
            const message = thread.message.trim();
            if (!projectId || !title || !message) return;
            portal.command(machine.id, { _tag: "startThread", projectId, title, message }, options);
          }}
        >
          <input
            placeholder="Project id"
            value={thread.projectId}
            onChange={(e) => setThread({ ...thread, projectId: e.target.value })}
          />
          <input
            placeholder="Thread title"
            value={thread.title}
            onChange={(e) => setThread({ ...thread, title: e.target.value })}
          />
          <input
            placeholder="Message"
            value={thread.message}
            onChange={(e) => setThread({ ...thread, message: e.target.value })}
          />
          <button type="submit" className="btn small">
            Start thread
          </button>
        </form>
      )}

      {map.settings.managed.length > 0 && <div className="section">Settings</div>}
      {map.settings.managed.map(({ scope, key }) => {
        const mine = own !== undefined && Object.hasOwn(own[scope], key);
        return (
          <div className="row" key={`${scope}.${key}`}>
            <div>
              <div className="t">{key}</div>
              <div className="v">{valueText(settings[scope][key])}</div>
            </div>
            <button
              type="button"
              className={`sticker ${mine ? "warn" : "info"}`}
              onClick={() =>
                portal.submit(
                  mine
                    ? `${machine.name} follows shared ${key}`
                    : `${machine.name} keeps its own ${key}`,
                  [
                    {
                      _tag: "setSetting",
                      machineId: machine.id,
                      scope,
                      key,
                      present: !mine,
                      value: mine ? null : (settings[scope][key] ?? null),
                    },
                  ],
                )
              }
            >
              {mine ? "this machine" : "shared"}
            </button>
          </div>
        );
      })}

      <div className="section">Token</div>
      <div className="small">
        <code>{machine.tokenClientId}</code>
      </div>
      {queue.rotation && (
        <div className="small muted">
          Rotation waits for the machine. It expires {timeUntil(queue.rotation.expiresAt, now)}.
        </div>
      )}
      <div className="actions" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn small"
          onClick={() =>
            portal.call(async () => {
              const result = await callApi<{ delivered: boolean }>(
                "POST",
                `/api/machines/${encodeURIComponent(machine.id)}/rotate`,
              );
              return result;
            }, "The new secret waits for the machine.")
          }
        >
          Rotate token
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() =>
            portal.open({ _tag: "newJoinCode", machineId: machine.id, machineName: machine.name })
          }
        >
          New join code
        </button>
        <button
          type="button"
          className="btn small danger"
          onClick={() =>
            portal.open({
              _tag: "confirm",
              title: `Remove ${machine.name}?`,
              body: "This deletes its machine token, its arrows, its settings overrides and its queue.",
              confirmLabel: "Remove",
              action: () =>
                portal.call(async () => {
                  await callApi("DELETE", `/api/machines/${encodeURIComponent(machine.id)}`);
                  portal.select(NO_SELECTION);
                }, `${machine.name} left the map.`),
            })
          }
        >
          Remove machine
        </button>
      </div>
    </>
  );
}

/** MM-701 to MM-704, MM-806. */
function RevisionPanel({ revision }: { revision: number }) {
  const portal = usePortalContext();
  const entry = portal.history.find((r) => r.revision === revision);
  if (!entry) return <Missing what="revision" />;
  const actor = entry.actor;
  const agentMachine =
    actor._tag === "agent" ? findMachine(portal.map, actor.machineId) : undefined;
  return (
    <>
      <h2>
        <span className="mono">rev {entry.revision}</span> {entry.summary}
      </h2>
      <div className="desc">
        {shortTime(entry.at)} · {actorText(actor, portal.map)}
      </div>
      {agentMachine?.hostname && actor._tag === "agent" && actor.threadId && (
        <div className="small">
          Thread <span className="mono">{actor.threadId}</span> on{" "}
          <a href={`https://${agentMachine.hostname}`} target="_blank" rel="noreferrer">
            {agentMachine.name}
          </a>
        </div>
      )}
      <div className="section">Changes</div>
      <ul className="small">
        {entry.changes.map((change) => (
          <li key={JSON.stringify(change)}>{describeChange(change, portal.map)}</li>
        ))}
      </ul>
      <div className="actions">
        <button
          type="button"
          className="btn"
          onClick={() =>
            portal.call(
              () => callApi<WriteResult>("POST", "/api/undo", { revision: entry.revision }),
              `Undid rev ${entry.revision}.`,
            )
          }
        >
          Undo
        </button>
        <button
          type="button"
          className="btn"
          onClick={() =>
            portal.call(
              () => callApi<WriteResult>("POST", "/api/restore", { revision: entry.revision }),
              `Restored the map to rev ${entry.revision}.`,
            )
          }
        >
          Restore this revision
        </button>
      </div>
    </>
  );
}

/** MM-804. */
function ProposalPanel({ id }: { id: string }) {
  const portal = usePortalContext();
  const proposal = portal.snapshot.proposals.find((p) => p.id === id);
  if (!proposal) return <Missing what="proposal" />;
  return (
    <>
      <h2>{proposal.summary}</h2>
      <div className="desc">
        {actorText(proposal.actor, portal.map)} · {timeAgo(proposal.at, portal.now)} · expires{" "}
        {timeUntil(proposal.expiresAt, portal.now)}
      </div>
      <div className="actions" style={{ marginTop: 8 }}>
        <span className={`sticker ${proposal.reason === "self-escalation" ? "" : "wait"}`}>
          {proposal.reason === "self-escalation" ? "raises its own access" : "map role propose"}
        </span>
      </div>
      <div className="section">Changes</div>
      <ul className="small">
        {proposal.changes.map((change) => (
          <li key={JSON.stringify(change)}>{describeChange(change, portal.map)}</li>
        ))}
      </ul>
      <div className="actions">
        <button
          type="button"
          className="btn primary"
          onClick={() =>
            portal.call(async () => {
              await callApi("POST", `/api/proposals/${encodeURIComponent(proposal.id)}/approve`);
              portal.select(NO_SELECTION);
            }, "Approved.")
          }
        >
          Approve
        </button>
        <button
          type="button"
          className="btn danger"
          onClick={() =>
            portal.call(async () => {
              await callApi("POST", `/api/proposals/${encodeURIComponent(proposal.id)}/reject`);
              portal.select(NO_SELECTION);
            }, "Rejected.")
          }
        >
          Reject
        </button>
      </div>
    </>
  );
}

/** MM-401 to MM-407. */
function SettingPanel({ scope, settingKey }: { scope: SettingScope; settingKey: string }) {
  const portal = usePortalContext();
  const { map, snapshot } = portal;
  const managed = map.settings.managed.some((s) => s.scope === scope && s.key === settingKey);
  if (!managed) return <Missing what="setting" />;
  const shared = map.settings.shared[scope];
  const hasShared = Object.hasOwn(shared, settingKey);
  const set = (machineId: MachineId | null, value: unknown, summary: string) =>
    portal.submit(summary, [
      { _tag: "setSetting", machineId, scope, key: settingKey, present: true, value },
    ]);
  const clear = (machineId: MachineId, summary: string) =>
    portal.submit(summary, [
      { _tag: "setSetting", machineId, scope, key: settingKey, present: false, value: null },
    ]);

  return (
    <>
      <h2>{settingKey}</h2>
      <div className="desc">{scope === "server" ? "Server setting" : "Client setting"}</div>
      <div className="section">Shared value</div>
      <SettingEditor
        key={JSON.stringify(hasShared ? shared[settingKey] : null)}
        scope={scope}
        settingKey={settingKey}
        value={hasShared ? shared[settingKey] : undefined}
        onSave={(value) => set(null, value, `Shared ${settingKey} = ${valueText(value)}`)}
      />
      {map.machines.map((machine) => {
        const own = map.settings.overrides[machine.id]?.[scope];
        const hasOwn = own !== undefined && Object.hasOwn(own, settingKey);
        const reported = snapshot.reportedSettings[machine.id]?.[scope];
        const reportedValue =
          reported && Object.hasOwn(reported, settingKey) ? reported[settingKey] : undefined;
        const changedHere = changedOn(portal.history, machine.id, scope, settingKey);
        return (
          <div key={machine.id} className="stack" style={{ marginTop: 12 }}>
            <div className="row">
              <div>
                <div className="t">{machine.name}</div>
                <div className="v">
                  {hasOwn ? `own value ${valueText(own?.[settingKey])}` : "follows shared"} ·
                  reports {valueText(reportedValue)}
                </div>
                {hasOwn && changedHere && <div className="v">changed on {machine.name}</div>}
              </div>
              {hasOwn && (
                <div className="actions">
                  <button
                    type="button"
                    className="btn small"
                    onClick={() =>
                      portal.submit(`Made ${machine.name}'s ${settingKey} shared`, [
                        {
                          _tag: "setSetting",
                          machineId: null,
                          scope,
                          key: settingKey,
                          present: true,
                          value: own?.[settingKey],
                        },
                        ...map.machines
                          .filter((m) =>
                            Object.hasOwn(map.settings.overrides[m.id]?.[scope] ?? {}, settingKey),
                          )
                          .map((m) => ({
                            _tag: "setSetting" as const,
                            machineId: m.id,
                            scope,
                            key: settingKey,
                            present: false,
                            value: null,
                          })),
                      ])
                    }
                  >
                    Make shared
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() =>
                      clear(machine.id, `${machine.name} follows shared ${settingKey}`)
                    }
                  >
                    Follow shared
                  </button>
                </div>
              )}
            </div>
            <SettingEditor
              key={JSON.stringify(hasOwn ? own?.[settingKey] : null)}
              scope={scope}
              settingKey={settingKey}
              value={hasOwn ? own?.[settingKey] : undefined}
              onSave={(value) =>
                set(machine.id, value, `${machine.name} ${settingKey} = ${valueText(value)}`)
              }
            />
          </div>
        );
      })}
      <div className="actions" style={{ marginTop: 14 }}>
        <button
          type="button"
          className="btn small danger"
          onClick={() => {
            portal.submit(`Stop managing ${scope}.${settingKey}`, [
              { _tag: "manageSetting", scope, key: settingKey, managed: false },
            ]);
            portal.select(NO_SELECTION);
          }}
        >
          Stop managing
        </button>
      </div>
    </>
  );
}

/** MM-404: true when the newest change of this override came from the machine itself. */
function changedOn(
  history: ReturnType<typeof usePortalContext>["history"],
  machineId: MachineId,
  scope: SettingScope,
  key: string,
): boolean {
  for (const revision of history) {
    const touches = revision.changes.some(
      (c) =>
        c._tag === "setSetting" && c.machineId === machineId && c.scope === scope && c.key === key,
    );
    if (touches)
      return (
        revision.actor._tag === "agent" &&
        revision.actor.machineId === machineId &&
        revision.actor.threadId === null
      );
  }
  return false;
}

/** MM-407: a switch, a choice, a number, text, or JSON for objects. */
function SettingEditor(props: {
  scope: SettingScope;
  settingKey: string;
  value: unknown;
  onSave: (value: unknown) => void;
}) {
  const control = settingControl(props.scope, props.settingKey);
  const initial =
    props.value === undefined
      ? ""
      : typeof props.value === "string"
        ? props.value
        : JSON.stringify(props.value, null, 2);
  const [text, setText] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const save = (value: unknown) => {
    const reason = settingProblem(props.scope, props.settingKey, value);
    setProblem(reason);
    if (reason === null) props.onSave(value);
  };
  switch (control._tag) {
    case "switch":
      return (
        <input
          type="checkbox"
          className="switch"
          checked={props.value === true}
          onChange={(e) => save(e.target.checked)}
        />
      );
    case "choice":
      return (
        <select
          value={props.value === undefined ? "" : String(props.value)}
          onChange={(e) => {
            const option = control.options.find((o) => String(o) === e.target.value);
            if (option !== undefined) save(option);
          }}
        >
          <option value="" disabled>
            Not set
          </option>
          {control.options.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      );
    case "number":
    case "text":
    case "json":
      return (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (control._tag === "text") return save(text);
            try {
              save(JSON.parse(text));
            } catch {
              setProblem("This is not valid JSON.");
            }
          }}
        >
          {control._tag === "json" ? (
            <textarea value={text} onChange={(e) => setText(e.target.value)} />
          ) : (
            <input
              type={control._tag === "number" ? "number" : "text"}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          )}
          {problem && (
            <div className="small" style={{ color: "var(--error-fg)" }}>
              {problem}
            </div>
          )}
          <div>
            <button type="submit" className="btn small">
              Save
            </button>
          </div>
        </form>
      );
  }
}

/** MM-503, MM-606. */
function CommandPanel({ id }: { id: string }) {
  const portal = usePortalContext();
  const command = portal.snapshot.commands.find((c) => c.id === id);
  if (!command) return <Missing what="command" />;
  return (
    <>
      <h2>
        {COMMAND_LABEL[command.input._tag]} on {machineName(portal.map, command.machineId)}
      </h2>
      <div className="desc">
        {actorText(command.actor, portal.map)} · {shortTime(command.createdAt)}
      </div>
      <div className="actions" style={{ marginTop: 8 }}>
        <span
          className={`sticker ${command.status === "succeeded" ? "ok" : command.status === "queued" || command.status === "delivered" ? "wait" : ""}`}
        >
          {command.status}
        </span>
        <span className="small muted">
          {command.delivery === "idle" ? "when online and idle" : "when online"} · expires{" "}
          {shortTime(command.expiresAt)}
        </span>
      </div>
      {command.error && (
        <div className="small" style={{ color: "var(--error-fg)", marginTop: 8 }}>
          {command.error}
        </div>
      )}
      {command.result != null && <pre>{JSON.stringify(command.result, null, 2)}</pre>}
      {command.status === "queued" && (
        <div className="actions" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="btn danger"
            onClick={() =>
              portal.call(
                () => callApi("POST", `/api/commands/${encodeURIComponent(command.id)}/cancel`),
                "Cancelled.",
              )
            }
          >
            Cancel
          </button>
        </div>
      )}
    </>
  );
}

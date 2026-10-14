import { useState, type ReactNode } from "react";
import {
  MACHINE_LEVEL_SCOPES,
  type CommandDelivery,
  type MachineCommandInput,
  type MachineId,
  type MachineKind,
  type MachineLevel,
  type MachineMapRole,
  type MachineRecord,
  isMachineLocalSetting,
  type MapChange,
  type SettingScope,
} from "@t3tools/contracts/machineMap";

import type { WriteResult } from "../api.ts";
import { arrowChange, usesText } from "../rules/access.ts";
import {
  effectiveSettings,
  findArrow,
  findMachine,
  LEVELS,
  levelRank,
  MAP_ROLES,
  pairOffset,
  roleRank,
} from "../rules/map.ts";
import { DEFAULT_COMMAND_MINUTES } from "../rules/queue.ts";
import { callApi } from "./apiClient.ts";
import { usePortalContext, type CommandOptions } from "./context.ts";
import { buildStandings } from "./build.ts";
import { BuildLabel, BuildSticker } from "./BuildLabel.tsx";
import {
  arrowEndWait,
  arrowEnds,
  connectMachines,
  cutLevel,
  describeChange,
  machineQueue,
  pairCut,
  pairShows,
  type ArrowEnd,
} from "./derive.ts";
import {
  actorText,
  COMMAND_LABEL,
  COMMAND_STICKER,
  DANGEROUS_COMMANDS,
  LEVEL_LABEL,
  LEVEL_TEXT,
  machineName,
  PRESENCE_STICKER,
  presenceState,
  presenceText,
  ROLE_TEXT,
  shortTime,
  timeAgo,
  timeUntil,
  valueText,
} from "./format.ts";
import { CloseIcon, KindIcon, UndoIcon } from "./icons.tsx";
import { MachineStickers } from "./MachineStickers.tsx";
import { ResourcesSection } from "./resources.tsx";
import { formatRoute, NO_SELECTION, type Selection } from "./route.ts";
import { settingControl, settingProblem } from "./settingControls.ts";

const PANEL_LABEL: Record<Exclude<Selection["_tag"], "none">, string> = {
  arrow: "Arrow",
  machine: "Machine",
  revision: "Revision",
  proposal: "Proposal",
  setting: "Setting",
  command: "Command",
};

/** MM-1102: the selected item, in a side panel or a bottom sheet on a phone. */
export function Panel({ selection }: { selection: Selection }) {
  const portal = usePortalContext();
  if (selection._tag === "none") return null;
  const body = (() => {
    switch (selection._tag) {
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
  return (
    <aside className="card panel" aria-label={PANEL_LABEL[selection._tag]}>
      <div className="head">
        <span className="section">{PANEL_LABEL[selection._tag]}</span>
        <button
          type="button"
          className="btn small"
          aria-keyshortcuts="Escape"
          onClick={() => portal.select(NO_SELECTION)}
        >
          <CloseIcon />
          Close
        </button>
      </div>
      {body}
    </aside>
  );
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const Missing = ({ what }: { what: string }) => (
  <div className="empty compact-empty">
    <h3>This {what} is gone</h3>
    <p>Another page or an agent removed it. Close the panel to go on.</p>
  </div>
);

const Section = ({ children }: { children: ReactNode }) => <h3 className="section">{children}</h3>;

/** MM-711: while paused, access only goes down, so raising controls are off. */
const PausedNote = () => (
  <div className="paused-note">
    <span className="sticker">paused</span> Access only goes down until you resume.
  </div>
);

type Duration = "permanent" | "hour" | "day" | "until";

const DURATION_LABEL: Record<Duration, string> = {
  permanent: "Always",
  hour: "1 hour",
  day: "1 day",
  until: "Until…",
};

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
  const reverse = findArrow(map, target.id, source.id);
  const f = source.name;
  const t = target.name;
  const permanent = arrow.revertLevel ?? arrow.level;
  const was = arrow.level === "none" ? cutLevel(portal.pause, source.id, target.id) : null;

  const setLevel = (level: MachineLevel) => {
    // oxlint-disable-next-line react/purity -- This runs in a click handler, not during render.
    const expiry = durationExpiry(duration, until, Date.now());
    if (expiry === undefined) {
      portal.call(() => Promise.reject(new Error("Pick a time in the future.")));
      return;
    }
    const suffix = expiry === null ? "" : ` until ${shortTime(expiry)}`;
    portal.submit(`${usesText(f, t)}: ${LEVEL_LABEL[level]}${suffix}`, [
      arrowChange(map, { from: source.id, to: target.id, level, expiresAt: expiry }),
    ]);
  };

  const ends = arrowEnds(snapshot, source.id, target.id);
  const endText = (end: ArrowEnd, machine: MachineRecord) => {
    const wait = arrowEndWait(end, machine);
    if (wait === null) return `applied on ${machine.name}`;
    return end === "queued" && !snapshot.presence[machine.id]?.online ? `${wait} (offline)` : wait;
  };
  const applied = ends.from === "applied" && ends.to === "applied";
  const appliedText = [endText(ends.to, target), endText(ends.from, source)].join(", ");
  const lastTest = snapshot.commands.find(
    (c) => c.machineId === source.id && c.input._tag === "testArrow" && c.input.to === target.id,
  );
  const scopes = arrow.level === "none" ? [] : MACHINE_LEVEL_SCOPES[arrow.level];

  return (
    <>
      <h2>
        {f} <span className="verb">uses</span> {t}
      </h2>
      <p className="desc">
        What {f} can do on {t}.
      </p>
      <button
        type="button"
        className="link reverse"
        onClick={() => portal.select({ _tag: "arrow", from: target.id, to: source.id })}
      >
        Other way: {usesText(t, f)}: {LEVEL_LABEL[reverse.level]}
      </button>
      {portal.pause && <PausedNote />}
      {was && (
        <p className="hint">The pause cut this arrow. Resume returns it to {LEVEL_LABEL[was]}.</p>
      )}

      <Section>How long</Section>
      <div className="seg wide" role="group" aria-label="How long">
        {(["permanent", "hour", "day", "until"] as const).map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={duration === d}
            onClick={() => setDuration(d)}
          >
            {DURATION_LABEL[d]}
          </button>
        ))}
      </div>
      {duration === "until" && (
        <input
          type="datetime-local"
          aria-label="Until"
          className="full"
          value={until}
          onChange={(e) => setUntil(e.target.value)}
        />
      )}
      <p className="hint">
        {duration === "permanent"
          ? "The level you pick stays until you change it."
          : `Pick a level below. It returns to ${LEVEL_LABEL[permanent]} ${duration === "until" ? "at that time" : `after ${DURATION_LABEL[duration]}`}.`}
      </p>

      <Section>Level</Section>
      <div className="seg wide" role="group" aria-label="Level">
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
      <p className="desc">{LEVEL_TEXT[arrow.level]}</p>
      {scopes.length > 0 && (
        <details className="more">
          <summary>{scopes.length} T3 scopes</summary>
          <p className="small mono scopes">{scopes.join(", ")}</p>
        </details>
      )}
      {arrow.expiresAt && arrow.revertLevel && (
        <div className="row callout">
          <div className="v">
            <span className="sticker warn flat">temp</span> Returns to{" "}
            {LEVEL_LABEL[arrow.revertLevel]} {timeUntil(arrow.expiresAt, now)}.
          </div>
          <button
            type="button"
            className="btn small"
            onClick={() =>
              portal.submit(`${usesText(f, t)}: made permanent`, [
                arrowChange(map, {
                  from: source.id,
                  to: target.id,
                  level: arrow.level,
                  expiresAt: null,
                }),
              ])
            }
          >
            Make permanent
          </button>
        </div>
      )}

      <Section>Agents</Section>
      <label className="row toggle-row">
        <span>
          <span className="t">
            Agents on {f} use {t}'s T3 tools
          </span>
          <span className="v">Within the scopes of the level.</span>
        </span>
        <input
          type="checkbox"
          className="switch"
          checked={arrow.agentTools}
          disabled={portal.pause !== null && !arrow.agentTools}
          onChange={(e) =>
            portal.submit(`${usesText(f, t)}: agent tools ${e.target.checked ? "on" : "off"}`, [
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
      </label>

      <Section>Delivery</Section>
      <p className="small">
        {applied ? (
          <span className="sticker ok flat">applied</span>
        ) : (
          <span className="sticker wait flat">pending</span>
        )}{" "}
        {appliedText.charAt(0).toUpperCase() + appliedText.slice(1)}.
      </p>
      <div className="actions spaced">
        <button
          type="button"
          className="btn small"
          onClick={() => portal.command(source.id, { _tag: "testArrow", to: target.id })}
        >
          Test the connection
        </button>
        {lastTest && (
          <span className="small muted">
            Last test{" "}
            <span className={`sticker flat ${COMMAND_STICKER[lastTest.status]}`}>
              {lastTest.status}
            </span>{" "}
            {timeAgo(lastTest.updatedAt, now)}
          </span>
        )}
      </div>
      {lastTest?.result != null && <pre>{JSON.stringify(lastTest.result, null, 2)}</pre>}
      {lastTest?.error && <p className="error-text">{lastTest.error}</p>}

      <Section>Card on the map</Section>
      {!pairShows(map, source.id, target.id) && !pairCut(portal.pause, source.id, target.id) ? (
        <p className="hint">
          The map hides this pair: neither machine uses the other. A level above None shows it
          again.
        </p>
      ) : pairOffset(map, source.id, target.id) ? (
        <div className="row callout">
          <div className="v">You placed this card. It follows its line when the machines move.</div>
          <button
            type="button"
            className="btn small"
            onClick={() =>
              portal.submit(`Card of ${f} and ${t} back to its own place`, [
                { _tag: "placePair", a: source.id, b: target.id, offset: null },
              ])
            }
          >
            Reset position
          </button>
        </div>
      ) : (
        <p className="hint">The map places this card. Drag it to put it somewhere else.</p>
      )}
      <p className="desc footnote">
        {f} proves who it is with its own Cloudflare service token,{" "}
        <code>{source.tokenClientId}</code>. {t} applies a change in under a second and ends open
        sessions from {f} when access drops.
      </p>
    </>
  );
}

/** Commands without input, in the order of the panel. Resources has "Collect diagnostics" with its result. */
const SIMPLE_COMMANDS: ReadonlyArray<
  Extract<
    MachineCommandInput,
    {
      _tag:
        | "reloadWindows"
        | "pauseScheduledTasks"
        | "resumeScheduledTasks"
        | "stopAllAgents"
        | "restartServer";
    }
  >
> = [
  { _tag: "reloadWindows" },
  { _tag: "pauseScheduledTasks" },
  { _tag: "resumeScheduledTasks" },
  { _tag: "stopAllAgents" },
  { _tag: "restartServer" },
];

const MACHINE_KINDS: ReadonlyArray<MachineKind> = ["laptop", "desktop", "server"];

const KIND_LABEL: Record<MachineKind, string> = {
  laptop: "Laptop",
  desktop: "Desktop",
  server: "Server",
};

const EXPIRY_LABEL: Record<number, string> = {
  60: "1 hour",
  [DEFAULT_COMMAND_MINUTES]: "24 hours",
  [7 * 24 * 60]: "7 days",
};

/** MM-206: rename in place. Enter saves, Escape keeps the old name. */
function RenameForm({ machine, done }: { machine: MachineRecord; done: () => void }) {
  const portal = usePortalContext();
  const [name, setName] = useState(machine.name);
  return (
    <form
      className="rename"
      onSubmit={(e) => {
        e.preventDefault();
        const next = name.trim();
        if (next && next !== machine.name)
          portal.submit(`Renamed ${machine.name} to ${next}`, [
            { _tag: "putMachine", machine: { ...machine, name: next } },
          ]);
        done();
      }}
    >
      <input
        aria-label="Name"
        value={name}
        autoFocus
        required
        autoComplete="off"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            done();
          }
        }}
      />
      <button type="submit" className="btn small primary">
        Save
      </button>
      <button type="button" className="btn small" onClick={done}>
        Cancel
      </button>
    </form>
  );
}

/** MM-1104: the keyboard path to the map handles. */
function ConnectForm({ machine }: { machine: MachineRecord }) {
  const portal = usePortalContext();
  const others = portal.map.machines.filter((m) => m.id !== machine.id);
  const [targetId, setTargetId] = useState("");
  if (others.length === 0) return <p className="hint">Add another machine to connect it.</p>;
  const target = others.find((m) => m.id === targetId) ?? others[0];
  return (
    <form
      className="actions"
      onSubmit={(e) => {
        e.preventDefault();
        if (target) connectMachines(portal, machine, target);
      }}
    >
      <label className="field inline">
        Connect to
        <select value={target?.id} onChange={(e) => setTargetId(e.target.value)}>
          {others.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="btn small">
        Connect
      </button>
    </form>
  );
}

type MachineTab = "overview" | "access" | "settings" | "manage";

const MACHINE_TAB_LABEL: Record<MachineTab, string> = {
  overview: "Overview",
  access: "Access",
  settings: "Settings",
  manage: "Manage",
};

/** MM-206, MM-207, MM-208, MM-5xx, MM-1003, MM-1004, MM-1112. */
function MachinePanel({ id }: { id: string }) {
  const portal = usePortalContext();
  const { map, snapshot, now } = portal;
  // The tab stays when the owner opens another machine, to compare the same part.
  const [tab, setTab] = useState<MachineTab>("overview");
  const machine = map.machines.find((m) => m.id === id);
  if (!machine) return <Missing what="machine" />;
  const presence = snapshot.presence[machine.id];
  const state = presenceState(presence);

  return (
    <>
      <h2 className="with-icon">
        <span className="icon">
          <KindIcon kind={machine.kind} />
        </span>
        {machine.name}
      </h2>
      <p className="desc">
        {presenceText(presence, now)} · applied rev {presence?.appliedRevision ?? "none"} of{" "}
        {map.revision}
      </p>
      <div className="stickers-row">
        <span className={`sticker ${PRESENCE_STICKER[state]}`}>{state}</span>
        <MachineStickers machine={machine} />
      </div>
      <div className="actions spaced">
        {machine.hostname ? (
          <a
            className="btn primary"
            href={`https://${machine.hostname}`}
            target="_blank"
            rel="noreferrer"
          >
            Open T3
          </a>
        ) : (
          // The machine reports its hostname when it joins. The Overview tab says so.
          <button type="button" className="btn" disabled>
            Open T3
          </button>
        )}
      </div>
      <div className="seg wide machine-tabs" role="tablist" aria-label="Machine">
        {(Object.keys(MACHINE_TAB_LABEL) as MachineTab[]).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
          >
            {MACHINE_TAB_LABEL[key]}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={MACHINE_TAB_LABEL[tab]}>
        {tab === "overview" && <MachineOverview machine={machine} />}
        {tab === "access" && <MachineAccess machine={machine} />}
        {tab === "settings" && <MachineSettings machine={machine} />}
        {tab === "manage" && <MachineManage machine={machine} />}
      </div>
    </>
  );
}

/** MM-1002, MM-5xx, MM-1506: what the machine does now, its commands and its resources. */
function MachineOverview({ machine }: { machine: MachineRecord }) {
  const portal = usePortalContext();
  const { snapshot } = portal;
  const [delivery, setDelivery] = useState<CommandDelivery>("online");
  const [expiresInMinutes, setExpiry] = useState(DEFAULT_COMMAND_MINUTES);
  const [thread, setThread] = useState({ projectId: "", title: "", message: "" });
  const presence = snapshot.presence[machine.id];
  const status = presence?.status ?? null;
  const supported = new Set(status?.commands ?? []);
  const options: CommandOptions = { delivery, expiresInMinutes };

  return (
    <>
      <Section>Status</Section>
      {status ? (
        <dl className="facts small">
          <dt>Build</dt>
          <dd>
            <BuildLabel status={status} />{" "}
            <BuildSticker standing={buildStandings(snapshot.presence).get(machine.id)} />
          </dd>
          {status.updateWaiting && (
            <>
              <dt>Update</dt>
              <dd>{status.updateWaiting} waits to install</dd>
            </>
          )}
          <dt>Up</dt>
          <dd>{Math.round(status.uptimeSeconds / 3600)} h</dd>
          <dt>Load</dt>
          <dd>
            {status.cpuPercent === null ? "CPU —" : `CPU ${Math.round(status.cpuPercent)}%`} ·{" "}
            {status.memoryPercent === null
              ? "memory —"
              : `memory ${Math.round(status.memoryPercent)}%`}
          </dd>
          <dt>Tasks</dt>
          <dd>
            <a
              href={formatRoute({ view: "tasks", selection: { _tag: "machine", id: machine.id } })}
            >
              {status.scheduledTasks} scheduled
            </a>
          </dd>
          <dt>Host</dt>
          <dd className="mono">{machine.hostname ?? "not reported yet"}</dd>
        </dl>
      ) : (
        <p className="small muted">No status yet. It shows here after the first connection.</p>
      )}

      <Section>Commands</Section>
      {presenceState(presence) !== "online" && status !== null && (
        <p className="hint">
          {machine.name} is offline. Commands wait in its queue and run when it connects.
        </p>
      )}
      {status === null ? (
        <p className="small muted">Commands show after the machine reports them.</p>
      ) : (
        <div className="actions">
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
      )}
      {status !== null && (
        <details className="more">
          <summary>
            Delivery: {delivery === "idle" ? "when online and idle" : "when online"}, expires after{" "}
            {EXPIRY_LABEL[expiresInMinutes] ?? `${expiresInMinutes} min`}
          </summary>
          <div className="actions">
            <label className="field inline">
              Deliver
              <select
                value={delivery}
                onChange={(e) => setDelivery(e.target.value === "idle" ? "idle" : "online")}
              >
                <option value="online">When online</option>
                <option value="idle">When online and idle</option>
              </select>
            </label>
            <label className="field inline">
              Expires after
              <select value={expiresInMinutes} onChange={(e) => setExpiry(Number(e.target.value))}>
                {Object.entries(EXPIRY_LABEL).map(([minutes, label]) => (
                  <option key={minutes} value={minutes}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </details>
      )}
      {supported.has("startThread") && (
        <details className="more">
          <summary>Start a thread</summary>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              const projectId = thread.projectId.trim();
              const title = thread.title.trim();
              const message = thread.message.trim();
              if (!projectId || !title || !message) return;
              portal.command(
                machine.id,
                { _tag: "startThread", projectId, title, message },
                options,
              );
              setThread({ ...thread, title: "", message: "" });
            }}
          >
            <label className="field">
              Project id
              <input
                value={thread.projectId}
                required
                spellCheck={false}
                onChange={(e) => setThread({ ...thread, projectId: e.target.value })}
              />
            </label>
            <label className="field">
              Thread title
              <input
                value={thread.title}
                required
                onChange={(e) => setThread({ ...thread, title: e.target.value })}
              />
            </label>
            <label className="field">
              Message
              <textarea
                className="prose"
                value={thread.message}
                required
                onChange={(e) => setThread({ ...thread, message: e.target.value })}
              />
            </label>
            <div>
              <button type="submit" className="btn small primary">
                Start thread
              </button>
            </div>
          </form>
        </details>
      )}

      <Section>Resources</Section>
      <ResourcesSection machine={machine} />
    </>
  );
}

/** MM-1103, MM-1104, MM-5xx: the arrows of the machine, a new arrow and its map role. */
function MachineAccess({ machine }: { machine: MachineRecord }) {
  const portal = usePortalContext();
  const { map } = portal;
  const put = (summary: string, next: MachineRecord) =>
    portal.submit(summary, [{ _tag: "putMachine", machine: next }]);
  const rows = map.machines.flatMap((other) =>
    other.id !== machine.id &&
    (pairShows(map, machine.id, other.id) || pairCut(portal.pause, machine.id, other.id))
      ? [
          { from: machine, to: other },
          { from: other, to: machine },
        ]
      : [],
  );

  return (
    <>
      <Section>Arrows</Section>
      {rows.length === 0 ? (
        <p className="hint">
          {machine.name} has no access to other machines, and none has access to it.
        </p>
      ) : (
        rows.map(({ from, to }) => {
          const arrow = findArrow(map, from.id, to.id);
          const was = arrow.level === "none" ? cutLevel(portal.pause, from.id, to.id) : null;
          return (
            <div className="row" key={`${from.id}>${to.id}`}>
              <button
                type="button"
                className="link grow left"
                onClick={() => portal.select({ _tag: "arrow", from: from.id, to: to.id })}
              >
                <span className="t">{usesText(from.name, to.name)}</span>
                {arrow.expiresAt && <span className="v">Until {shortTime(arrow.expiresAt)}</span>}
              </button>
              {arrow.agentTools && <span className="sticker accent flat">tools</span>}
              {was ? (
                <>
                  <span className={`sticker lvl-${was} was`}>{LEVEL_LABEL[was]}</span>
                  <span className="sticker cut-sticker">cut</span>
                </>
              ) : (
                <span className={`sticker lvl-${arrow.level}`}>{LEVEL_LABEL[arrow.level]}</span>
              )}
            </div>
          );
        })
      )}

      <Section>Connect</Section>
      <p className="hint">
        {machine.name} gets Standard access to the machine you pick. The arrow opens, so you can
        pick another level.
      </p>
      <ConnectForm machine={machine} />

      <Section>Map role</Section>
      {portal.pause && <PausedNote />}
      <div className="seg wide" role="group" aria-label="Map role">
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
      <p className="desc">{ROLE_TEXT[machine.mapRole]}</p>
    </>
  );
}

/** MM-1112: each synced setting follows the shared value or keeps its own value. */
function MachineSettings({ machine }: { machine: MachineRecord }) {
  const portal = usePortalContext();
  const { map } = portal;
  const [query, setQuery] = useState("");
  const settings = effectiveSettings(map, machine.id);
  const own = map.settings.overrides[machine.id];
  const isOwn = (scope: SettingScope, key: string) =>
    own !== undefined && Object.hasOwn(own[scope], key);
  // The settings that the map syncs to this machine: a shared value or an own value.
  const synced = (["server", "client"] as const).flatMap((scope) =>
    Object.keys(settings[scope]).map((key) => ({ scope, key })),
  );
  const ownCount = synced.filter(({ scope, key }) => isOwn(scope, key)).length;
  const needle = query.trim().toLowerCase();
  // Own values first: they are the ones that make this machine different.
  const shown = synced
    .filter(({ key }) => key.toLowerCase().includes(needle))
    .toSorted((a, b) => Number(isOwn(b.scope, b.key)) - Number(isOwn(a.scope, a.key)));

  if (synced.length === 0) {
    return (
      <p className="hint">
        No setting has a shared value yet. Set one in the Settings view, or change a setting in T3
        Settings for all environments.
      </p>
    );
  }
  return (
    <>
      <p className="desc">
        {ownCount === 0
          ? `${machine.name} follows all ${synced.length} shared settings.`
          : `${machine.name} keeps its own value for ${ownCount} of ${synced.length} settings.`}
      </p>
      <input
        type="search"
        className="full"
        aria-label="Find a setting"
        placeholder="Find a setting"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {shown.length === 0 && <p className="small muted">No setting matches.</p>}
      {shown.map(({ scope, key }) => {
        const mine = isOwn(scope, key);
        const follow = (keepOwn: boolean) => {
          if (keepOwn === mine) return;
          portal.submit(
            keepOwn
              ? `${machine.name} keeps its own ${key}`
              : `${machine.name} follows shared ${key}`,
            [
              {
                _tag: "setSetting",
                machineId: machine.id,
                scope,
                key,
                present: keepOwn,
                value: keepOwn ? (settings[scope][key] ?? null) : null,
              },
            ],
          );
        };
        return (
          <div className="row" key={`${scope}.${key}`}>
            <button
              type="button"
              className="link grow left"
              onClick={() => portal.select({ _tag: "setting", scope, key }, "settings")}
            >
              <span className="t">{key}</span>
              <span className="v">{valueText(settings[scope][key])}</span>
            </button>
            <div className="seg tiny" role="group" aria-label={`${key} value`}>
              <button type="button" aria-pressed={!mine} onClick={() => follow(false)}>
                Shared
              </button>
              <button type="button" aria-pressed={mine} onClick={() => follow(true)}>
                Own
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}

/** MM-206, MM-207, MM-208: name, kind, token and removal. */
function MachineManage({ machine }: { machine: MachineRecord }) {
  const portal = usePortalContext();
  const { snapshot, now } = portal;
  const [renaming, setRenaming] = useState(false);
  const queue = machineQueue(snapshot, portal.rotations, machine);
  const put = (summary: string, next: MachineRecord) =>
    portal.submit(summary, [{ _tag: "putMachine", machine: next }]);

  return (
    <>
      <Section>Name</Section>
      {renaming ? (
        <RenameForm machine={machine} done={() => setRenaming(false)} />
      ) : (
        <div className="row">
          <span className="t grow">{machine.name}</span>
          <button type="button" className="btn small" onClick={() => setRenaming(true)}>
            Rename
          </button>
        </div>
      )}

      <Section>Kind</Section>
      <div className="seg kinds" role="group" aria-label="Kind">
        {MACHINE_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            aria-pressed={machine.kind === kind}
            onClick={() =>
              kind !== machine.kind && put(`${machine.name} is a ${kind}`, { ...machine, kind })
            }
          >
            <KindIcon kind={kind} />
            {KIND_LABEL[kind]}
          </button>
        ))}
      </div>

      <Section>Token</Section>
      <p className="small">
        <code>{machine.tokenClientId}</code>
      </p>
      {queue.rotation && (
        <p className="hint">
          A new secret waits for {machine.name}. It expires{" "}
          {timeUntil(queue.rotation.expiresAt, now)}.
        </p>
      )}
      <div className="actions spaced">
        <button
          type="button"
          className="btn small"
          onClick={() =>
            portal.call(async () => {
              await callApi<{ delivered: boolean }>(
                "POST",
                `/api/machines/${encodeURIComponent(machine.id)}/rotate`,
              );
            }, `A new secret waits for ${machine.name}.`)
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
      </div>

      <Section>Remove</Section>
      <p className="hint">
        Deletes its machine token, its arrows, its settings overrides and its queue.
      </p>
      <div className="actions spaced">
        <button
          type="button"
          className="btn small danger"
          onClick={() =>
            portal.open({
              _tag: "confirm",
              title: `Remove ${machine.name}?`,
              body: "This deletes its machine token, its arrows, its settings overrides and its queue. It cannot connect again with its old secret.",
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
      <h2>{entry.summary}</h2>
      <p className="desc">
        <span className="mono">rev {entry.revision}</span> · {shortTime(entry.at)} ·{" "}
        {actorText(actor, portal.map)}
      </p>
      {agentMachine?.hostname && actor._tag === "agent" && actor.threadId && (
        <p className="small">
          Thread <span className="mono">{actor.threadId}</span> on{" "}
          <a href={`https://${agentMachine.hostname}`} target="_blank" rel="noreferrer">
            {agentMachine.name}
          </a>
        </p>
      )}
      <Section>Changes</Section>
      <ul className="changes small">
        {entry.changes.map((change) => (
          <li key={JSON.stringify(change)}>{describeChange(change, portal.map)}</li>
        ))}
      </ul>
      <div className="actions spaced">
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
          <UndoIcon />
          Undo
        </button>
        <button
          type="button"
          className="btn"
          onClick={() =>
            portal.open({
              _tag: "confirm",
              title: `Restore the map to rev ${entry.revision}?`,
              body: "Every arrow, setting, machine fact, card place and note returns to how it was then, as one new revision. Undo reverses it.",
              confirmLabel: "Restore",
              tone: "primary",
              action: () =>
                portal.call(
                  () => callApi<WriteResult>("POST", "/api/restore", { revision: entry.revision }),
                  `Restored the map to rev ${entry.revision}.`,
                ),
            })
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
  const own = proposal.reason === "self-escalation";
  return (
    <>
      <h2>{proposal.summary}</h2>
      <p className="desc">
        {actorText(proposal.actor, portal.map)} · {timeAgo(proposal.at, portal.now)}
      </p>
      <div className="stickers-row">
        <span className={`sticker ${own ? "" : "wait"}`}>{own ? "own access" : "proposal"}</span>
      </div>
      <p className="desc">
        {own
          ? "The agent asks for more access for its own machine. That always needs you."
          : "The machine has the map role propose, so its changes wait for you."}
      </p>
      <Section>Changes</Section>
      <ul className="changes small">
        {proposal.changes.map((change) => (
          <li key={JSON.stringify(change)}>{describeChange(change, portal.map)}</li>
        ))}
      </ul>
      <p className="hint">
        It expires {timeUntil(proposal.expiresAt, portal.now)} if you do nothing.
      </p>
      <div className="actions spaced">
        <button
          type="button"
          className="btn primary"
          onClick={() =>
            portal.call(async () => {
              const result = await callApi<WriteResult>(
                "POST",
                `/api/proposals/${encodeURIComponent(proposal.id)}/approve`,
              );
              portal.select(NO_SELECTION);
              return result;
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
  if (isMachineLocalSetting(scope, settingKey)) return <Missing what="setting" />;
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
  const clearOverrides: Array<MapChange> = map.machines
    .filter((m) => Object.hasOwn(map.settings.overrides[m.id]?.[scope] ?? {}, settingKey))
    .map((m) => ({
      _tag: "setSetting",
      machineId: m.id,
      scope,
      key: settingKey,
      present: false,
      value: null,
    }));

  return (
    <>
      <h2 className="mono-title">{settingKey}</h2>
      <p className="desc">
        {scope === "server" ? "Server setting" : "Client setting"}.{" "}
        {hasShared
          ? "Machines follow the shared value unless they keep their own."
          : "No shared value: each machine keeps its own. Set a shared value to sync it."}
      </p>
      <Section>Shared value</Section>
      <SettingEditor
        key={JSON.stringify(hasShared ? shared[settingKey] : null)}
        label="Shared value"
        scope={scope}
        settingKey={settingKey}
        value={hasShared ? shared[settingKey] : undefined}
        onSave={(value) => set(null, value, `Shared ${settingKey} = ${valueText(value)}`)}
      />
      <Section>Machines</Section>
      {map.machines.map((machine) => {
        const own = map.settings.overrides[machine.id]?.[scope];
        const hasOwn = own !== undefined && Object.hasOwn(own, settingKey);
        const reported = snapshot.reportedSettings[machine.id]?.[scope];
        const reportedValue =
          reported && Object.hasOwn(reported, settingKey) ? reported[settingKey] : undefined;
        const changedHere = changedOn(portal.history, machine.id, scope, settingKey);
        // MM-404, MM-412: the own value, or else the reported value, can become the shared value.
        const candidate = hasOwn ? own?.[settingKey] : reportedValue;
        const canShare =
          candidate !== undefined && !(hasShared && sameValue(candidate, shared[settingKey]));
        return (
          <div key={machine.id} className="machine-setting">
            <div className="row">
              <div>
                <div className="t">
                  {machine.name} {hasOwn && <span className="sticker warn flat">own</span>}
                </div>
                <div className="v">
                  {hasOwn
                    ? `Own value ${valueText(own?.[settingKey])}`
                    : hasShared
                      ? "Follows shared"
                      : "Keeps its own"}{" "}
                  · reports {valueText(reportedValue)}
                  {hasOwn && changedHere && ` · changed on ${machine.name}`}
                </div>
              </div>
              {(canShare || hasOwn) && (
                <div className="actions">
                  {canShare && (
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
                            value: candidate,
                          },
                          ...clearOverrides,
                        ])
                      }
                    >
                      Make shared
                    </button>
                  )}
                  {hasOwn && (
                    <button
                      type="button"
                      className="btn small"
                      onClick={() =>
                        clear(machine.id, `${machine.name} follows shared ${settingKey}`)
                      }
                    >
                      Follow shared
                    </button>
                  )}
                </div>
              )}
            </div>
            <SettingEditor
              key={JSON.stringify(hasOwn ? own?.[settingKey] : null)}
              label={`Own value on ${machine.name}`}
              scope={scope}
              settingKey={settingKey}
              value={hasOwn ? own?.[settingKey] : undefined}
              onSave={(value) =>
                set(machine.id, value, `${machine.name} ${settingKey} = ${valueText(value)}`)
              }
              shared={{
                value: hasShared ? shared[settingKey] : undefined,
                follow: () => clear(machine.id, `${machine.name} follows shared ${settingKey}`),
              }}
            />
          </div>
        );
      })}
      {(hasShared || clearOverrides.length > 0) && (
        <>
          <Section>Stop syncing</Section>
          <p className="hint">
            Machines keep their current value. The shared value and the own values go.
          </p>
          <div className="actions spaced">
            <button
              type="button"
              className="btn small danger"
              onClick={() =>
                portal.submit(`Stop syncing ${scope}.${settingKey}`, [
                  ...(hasShared
                    ? [
                        {
                          _tag: "setSetting" as const,
                          machineId: null,
                          scope,
                          key: settingKey,
                          present: false,
                          value: null,
                        },
                      ]
                    : []),
                  ...clearOverrides,
                ])
              }
            >
              Stop syncing
            </button>
          </div>
        </>
      )}
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
  label: string;
  scope: SettingScope;
  settingKey: string;
  value: unknown;
  onSave: (value: unknown) => void;
  /** A machine without its own value shows the shared value, and can go back to it. */
  shared?: { readonly value: unknown; readonly follow: () => void };
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
          aria-label={props.label}
          checked={(props.value === undefined ? props.shared?.value : props.value) === true}
          onChange={(e) => save(e.target.checked)}
        />
      );
    case "choice":
      return (
        <select
          aria-label={props.label}
          value={props.value === undefined ? "" : String(props.value)}
          onChange={(e) => {
            if (e.target.value === "") return props.shared?.follow();
            const option = control.options.find((o) => String(o) === e.target.value);
            if (option !== undefined) save(option);
          }}
        >
          <option value="" disabled={!props.shared}>
            {props.shared ? `Shared (${valueText(props.shared.value)})` : "Not set"}
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
          className="editor"
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
            <textarea
              aria-label={props.label}
              placeholder={props.shared ? `Shared: ${valueText(props.shared.value)}` : undefined}
              value={text}
              spellCheck={false}
              onChange={(e) => setText(e.target.value)}
            />
          ) : (
            <input
              aria-label={props.label}
              type={control._tag === "number" ? "number" : "text"}
              placeholder={props.shared ? `Shared: ${valueText(props.shared.value)}` : undefined}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          )}
          <button type="submit" className="btn small" disabled={text === initial}>
            Save
          </button>
          {problem && <p className="error-text">{problem}</p>}
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
      <p className="desc">
        {actorText(command.actor, portal.map)} · {shortTime(command.createdAt)}
      </p>
      <p className="small">
        <span className={`sticker ${COMMAND_STICKER[command.status]}`}>{command.status}</span>{" "}
        <span className="muted">
          {command.delivery === "idle" ? "When online and idle" : "When online"} · expires{" "}
          {shortTime(command.expiresAt)}
        </span>
      </p>
      {command.error && <p className="error-text">{command.error}</p>}
      {command.result != null && <pre>{JSON.stringify(command.result, null, 2)}</pre>}
      {command.status === "queued" && (
        <div className="actions spaced">
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
            Cancel command
          </button>
        </div>
      )}
    </>
  );
}

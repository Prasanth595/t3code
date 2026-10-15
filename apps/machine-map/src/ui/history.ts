/**
 * The History view model (MM-714 to MM-716): what each entry means, groups of moves and of
 * commands sent together, filters, and the before and after of each change.
 */
import type {
  ArrowRecord,
  MachineCommand,
  MachineId,
  MachineMapDocument,
  MapActor,
  MapChange,
  MapPosition,
  MapRevision,
} from "@t3tools/contracts/machineMap";
import type { HealthAlert } from "@t3tools/contracts/machineMapResources";

import { arrowRaises, usesText } from "../rules/access.ts";
import { defaultArrow, roleRank } from "../rules/map.ts";
import { LOCKDOWN_SUMMARY, PAUSE_SUMMARY, RESUME_SUMMARY } from "../rules/presets.ts";
import { noteQuote } from "./derive.ts";
import {
  actorText,
  COMMAND_LABEL,
  LEVEL_LABEL,
  machineName,
  shortTime,
  valueText,
} from "./format.ts";

export type HistoryKind =
  | "raise"
  | "lower"
  | "pause"
  | "resume"
  | "lockdown"
  | "machines"
  | "join"
  | "settings"
  | "expiry"
  | "move"
  | "note"
  | "preset"
  | "other"
  | "command"
  | "alert";

/** Each kind: the filter label, the sticker (one or two words) and whether it is important. */
export const HISTORY_KIND: Record<
  HistoryKind,
  { readonly label: string; readonly sticker: string; readonly important: boolean }
> = {
  raise: { label: "Access raised", sticker: "up", important: true },
  lower: { label: "Access lowered", sticker: "down", important: true },
  pause: { label: "Emergency pause", sticker: "pause", important: true },
  resume: { label: "Resume", sticker: "resume", important: true },
  lockdown: { label: "Lockdown", sticker: "lockdown", important: true },
  machines: { label: "Machines added or removed", sticker: "machine", important: true },
  join: { label: "Joins and hostnames", sticker: "joined", important: false },
  settings: { label: "Settings", sticker: "settings", important: false },
  expiry: { label: "Expiries", sticker: "expired", important: true },
  move: { label: "Moves", sticker: "moved", important: false },
  note: { label: "Notes", sticker: "note", important: false },
  preset: { label: "Presets", sticker: "preset", important: false },
  other: { label: "Other changes", sticker: "change", important: false },
  command: { label: "Commands", sticker: "command", important: false },
  alert: { label: "Health alerts", sticker: "alert", important: false },
};

export const HISTORY_KINDS = Object.keys(HISTORY_KIND).filter(
  (kind): kind is HistoryKind => kind in HISTORY_KIND,
);

type RevisionChanges = Pick<MapRevision, "changes" | "inverse">;
type Tagged<T extends MapChange["_tag"]> = Extract<MapChange, { _tag: T }>;

/** The state before the revision of what `matches` picks. The last match in the inverse is the oldest. */
const before = <T extends MapChange["_tag"]>(
  revision: RevisionChanges,
  tag: T,
  matches: (change: Tagged<T>) => boolean,
): Tagged<T> | undefined =>
  revision.inverse.findLast(
    (change): change is Tagged<T> => change._tag === tag && matches(change as Tagged<T>),
  );

const samePosition = (a: MapPosition, b: MapPosition) => a.x === b.x && a.y === b.y;

function previousArrow(revision: RevisionChanges, arrow: ArrowRecord): ArrowRecord {
  return (
    before(revision, "setArrow", (c) => c.arrow.from === arrow.from && c.arrow.to === arrow.to)
      ?.arrow ?? defaultArrow(arrow.from, arrow.to)
  );
}

/** What one change did, from the most to the least telling. */
const CHANGE_ORDER = [
  "machines",
  "join",
  "raise",
  "lower",
  "settings",
  "note",
  "preset",
  "other",
  "move",
] as const satisfies ReadonlyArray<HistoryKind>;
type ChangeKind = (typeof CHANGE_ORDER)[number];

function changeKind(revision: RevisionChanges, change: MapChange): ChangeKind {
  switch (change._tag) {
    case "setArrow": {
      const previous = previousArrow(revision, change.arrow);
      if (arrowRaises(previous, change.arrow)) return "raise";
      if (arrowRaises(change.arrow, previous)) return "lower";
      return "other";
    }
    case "putMachine": {
      const next = change.machine;
      const previous = before(revision, "putMachine", (c) => c.machine.id === next.id)?.machine;
      if (!previous) return "machines";
      if (previous.hostname !== next.hostname) return "join";
      if (roleRank(next.mapRole) > roleRank(previous.mapRole)) return "raise";
      if (roleRank(next.mapRole) < roleRank(previous.mapRole)) return "lower";
      if (previous.name !== next.name || previous.kind !== next.kind) return "other";
      return "move";
    }
    case "removeMachine":
      return "machines";
    case "setSetting":
      return "settings";
    case "putPreset":
    case "removePreset":
      return "preset";
    case "placePair":
      return "move";
    case "putNote": {
      const previous = before(revision, "putNote", (c) => c.note.id === change.note.id)?.note;
      const moved =
        previous !== undefined &&
        previous.text === change.note.text &&
        previous.color === change.note.color &&
        !samePosition(previous.position, change.note.position);
      return moved ? "move" : "note";
    }
    case "removeNote":
      return "note";
  }
}

/** MM-715: the meaning of a revision, for its colour and sticker. */
export function classifyRevision(
  revision: Pick<MapRevision, "summary" | "actor" | "changes" | "inverse">,
): HistoryKind {
  if (revision.summary === PAUSE_SUMMARY) return "pause";
  if (revision.summary === RESUME_SUMMARY) return "resume";
  if (revision.summary === LOCKDOWN_SUMMARY) return "lockdown";
  if (revision.actor._tag === "portal" && revision.actor.reason === "expiry") return "expiry";
  const kinds = new Set(revision.changes.map((change) => changeKind(revision, change)));
  return CHANGE_ORDER.find((kind) => kinds.has(kind)) ?? "other";
}

export type HistoryEntry =
  | {
      readonly _tag: "revision";
      readonly at: string;
      readonly kind: HistoryKind;
      readonly revision: MapRevision;
    }
  | {
      readonly _tag: "command";
      readonly at: string;
      readonly kind: "command";
      readonly command: MachineCommand;
    }
  | {
      /** MM-1505: the start or the end of a health alert, a portal event and not a revision. */
      readonly _tag: "alert";
      readonly at: string;
      readonly kind: "alert";
      readonly alert: HealthAlert;
      readonly ended: boolean;
    };

/** Revisions, commands, and alert starts and ends, newest first. */
export function historyEntries(
  revisions: ReadonlyArray<MapRevision>,
  commands: ReadonlyArray<MachineCommand>,
  alerts: ReadonlyArray<HealthAlert>,
): Array<HistoryEntry> {
  return [
    ...revisions.map((revision): HistoryEntry => ({
      _tag: "revision",
      at: revision.at,
      kind: classifyRevision(revision),
      revision,
    })),
    ...commands.map((command): HistoryEntry => ({
      _tag: "command",
      at: command.createdAt,
      kind: "command",
      command,
    })),
    ...alerts.flatMap((alert): Array<HistoryEntry> => [
      { _tag: "alert", at: alert.startedAt, kind: "alert", alert, ended: false },
      ...(alert.endedAt === null
        ? []
        : [{ _tag: "alert", at: alert.endedAt, kind: "alert", alert, ended: true } as const]),
    ]),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** A stable key of one entry. */
export function entryKey(entry: HistoryEntry): string {
  switch (entry._tag) {
    case "revision":
      return `rev${entry.revision.revision}`;
    case "command":
      return entry.command.id;
    case "alert":
      return `${entry.alert.id}:${entry.ended ? "end" : "start"}`;
  }
}

const HEALTH_ACTOR: MapActor = { _tag: "portal", reason: "health" };

export function entryActor(entry: HistoryEntry): MapActor {
  switch (entry._tag) {
    case "revision":
      return entry.revision.actor;
    case "command":
      return entry.command.actor;
    case "alert":
      return HEALTH_ACTOR;
  }
}

/** One actor for the filter: an owner device, the agents of one machine, or the portal. */
export function actorKey(actor: MapActor): string {
  switch (actor._tag) {
    case "owner":
      return `owner:${actor.email}:${actor.device}`;
    case "agent":
      return `agent:${actor.machineId}`;
    case "portal":
      return "portal";
  }
}

export function actorLabel(actor: MapActor, map: MachineMapDocument): string {
  switch (actor._tag) {
    case "owner":
      return actorText(actor, map);
    case "agent":
      return `Agents on ${machineName(map, actor.machineId)}`;
    case "portal":
      return "Portal";
  }
}

/** The machines that an entry names. A shared setting names none. */
export function entryMachines(entry: HistoryEntry): ReadonlySet<string> {
  if (entry._tag === "alert") return new Set([entry.alert.machineId]);
  if (entry._tag === "command") {
    const { input, machineId } = entry.command;
    return new Set(input._tag === "testArrow" ? [machineId, input.to] : [machineId]);
  }
  const ids = new Set<MachineId>();
  for (const change of entry.revision.changes) {
    switch (change._tag) {
      case "setArrow":
        ids.add(change.arrow.from).add(change.arrow.to);
        break;
      case "setSetting":
        if (change.machineId !== null) ids.add(change.machineId);
        break;
      case "putMachine":
        ids.add(change.machine.id);
        break;
      case "removeMachine":
        ids.add(change.machineId);
        break;
      case "placePair":
        ids.add(change.a).add(change.b);
        break;
      case "putPreset":
      case "removePreset":
      case "putNote":
      case "removeNote":
        break;
    }
  }
  return ids;
}

/** MM-716. Null fields match everything. */
export interface HistoryFilter {
  readonly machineId: string | null;
  readonly kind: HistoryKind | null;
  readonly actor: string | null;
  readonly importantOnly: boolean;
}

export const NO_FILTER: HistoryFilter = {
  machineId: null,
  kind: null,
  actor: null,
  importantOnly: false,
};

export function matchesFilter(entry: HistoryEntry, filter: HistoryFilter): boolean {
  if (filter.kind !== null && entry.kind !== filter.kind) return false;
  if (filter.importantOnly && !HISTORY_KIND[entry.kind].important) return false;
  if (filter.actor !== null && actorKey(entryActor(entry)) !== filter.actor) return false;
  return filter.machineId === null || entryMachines(entry).has(filter.machineId);
}

/** One row of the list: one entry, or several in a row that read as one. */
export type HistoryItem =
  | { readonly _tag: "single"; readonly entry: HistoryEntry }
  | {
      readonly _tag: "group";
      readonly kind: "move" | "command";
      readonly entries: ReadonlyArray<HistoryEntry>;
    };

export interface HistoryDay {
  /** The local date, `YYYY-MM-DD`. */
  readonly day: string;
  readonly items: ReadonlyArray<HistoryItem>;
}

/** Moves of one actor in a row join while each is at most this long after the one before. */
const MOVE_GAP_MS = 30 * 60_000;
/** Commands of one kind from one actor join when they were sent within this time, like a pause. */
const COMMAND_GAP_MS = 60_000;

export const localDay = (iso: string): string => {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

function joins(newer: HistoryEntry, older: HistoryEntry): boolean {
  if (actorKey(entryActor(newer)) !== actorKey(entryActor(older))) return false;
  const gap = Date.parse(newer.at) - Date.parse(older.at);
  if (newer._tag === "revision" && older._tag === "revision") {
    return newer.kind === "move" && older.kind === "move" && gap <= MOVE_GAP_MS;
  }
  if (newer._tag === "command" && older._tag === "command") {
    return newer.command.input._tag === older.command.input._tag && gap <= COMMAND_GAP_MS;
  }
  return false;
}

/**
 * MM-714: splits entries (newest first) into days, and joins moves of one actor in a row, and
 * commands of one kind sent together, into one group.
 */
export function groupHistory(entries: ReadonlyArray<HistoryEntry>): Array<HistoryDay> {
  const days: Array<{ day: string; runs: Array<Array<HistoryEntry>> }> = [];
  for (const entry of entries) {
    const day = localDay(entry.at);
    let current = days.at(-1);
    if (current?.day !== day) {
      current = { day, runs: [] };
      days.push(current);
    }
    const run = current.runs.at(-1);
    const last = run?.at(-1);
    if (run && last && joins(last, entry)) run.push(entry);
    else current.runs.push([entry]);
  }
  return days.map(({ day, runs }) => ({
    day,
    items: runs.map((run): HistoryItem => {
      const [first] = run;
      if (run.length === 1 && first) return { _tag: "single", entry: first };
      return { _tag: "group", kind: first?._tag === "command" ? "command" : "move", entries: run };
    }),
  }));
}

/** "Mac", "Mac and VPS", "Mac, VPS and 2 cards". */
function listText(parts: ReadonlyArray<string>): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** MM-714: "Moved Mac, VPS and 2 cards · 6 moves", or "Stop all agents on Mac and VPS". */
export function groupSummary(
  group: Extract<HistoryItem, { _tag: "group" }>,
  map: MachineMapDocument,
): string {
  if (group.kind === "command") {
    const first = group.entries[0];
    const label = first?._tag === "command" ? COMMAND_LABEL[first.command.input._tag] : "Commands";
    const names = new Set(
      group.entries.flatMap((e) =>
        e._tag === "command" ? [machineName(map, e.command.machineId)] : [],
      ),
    );
    return `${label} on ${listText([...names])}`;
  }
  const machines = new Set<string>();
  const cards = new Set<string>();
  const notes = new Set<string>();
  for (const entry of group.entries) {
    if (entry._tag !== "revision") continue;
    for (const change of entry.revision.changes) {
      if (change._tag === "putMachine") machines.add(change.machine.name);
      if (change._tag === "placePair") cards.add([change.a, change.b].toSorted().join(">"));
      if (change._tag === "putNote") notes.add(change.note.id);
    }
  }
  const parts = [...machines];
  if (cards.size > 0) parts.push(count(cards.size, "card", "cards"));
  if (notes.size > 0) parts.push(count(notes.size, "note", "notes"));
  return `Moved ${listText(parts)} · ${count(group.entries.length, "move", "moves")}`;
}

/** One line of the before and after of a revision. */
export interface DiffRow {
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

const NOTHING = "—";

function arrowText(arrow: ArrowRecord): string {
  const parts = [LEVEL_LABEL[arrow.level]];
  if (arrow.agentTools) parts.push("agent tools");
  if (arrow.expiresAt) parts.push(`until ${shortTime(arrow.expiresAt)}`);
  return parts.join(", ");
}

/** MM-1114: a place in map pixels. It reads the same on every screen. */
const placeText = (p: MapPosition) => `${Math.round(p.x)}, ${Math.round(p.y)}`;

/** MM-715: the before and after of each change of a revision. */
export function revisionDiff(revision: RevisionChanges, map: MachineMapDocument): Array<DiffRow> {
  const name = (id: string) => machineName(map, id);
  return revision.changes.flatMap((change): Array<DiffRow> => {
    switch (change._tag) {
      case "setArrow": {
        const previous = previousArrow(revision, change.arrow);
        return [
          {
            label: usesText(name(change.arrow.from), name(change.arrow.to)),
            before: arrowText(previous),
            after: arrowText(change.arrow),
          },
        ];
      }
      case "setSetting": {
        const previous = before(
          revision,
          "setSetting",
          (c) =>
            c.machineId === change.machineId && c.scope === change.scope && c.key === change.key,
        );
        const text = (c: Tagged<"setSetting"> | undefined) =>
          c?.present ? valueText(c.value) : "not set";
        const target = change.machineId === null ? "shared" : name(change.machineId);
        return [
          {
            label: `${change.scope}.${change.key} · ${target}`,
            before: text(previous),
            after: text(change),
          },
        ];
      }
      case "putMachine": {
        const next = change.machine;
        const previous = before(revision, "putMachine", (c) => c.machine.id === next.id)?.machine;
        if (!previous) return [{ label: next.name, before: NOTHING, after: `added, ${next.kind}` }];
        const rows: Array<DiffRow> = [];
        const field = (label: string, a: string, b: string) => {
          if (a !== b) rows.push({ label: `${next.name} ${label}`, before: a, after: b });
        };
        field("name", previous.name, next.name);
        field("kind", previous.kind, next.kind);
        field("map role", previous.mapRole, next.mapRole);
        field("hostname", previous.hostname ?? NOTHING, next.hostname ?? NOTHING);
        field("place", placeText(previous.position), placeText(next.position));
        return rows;
      }
      case "removeMachine": {
        const previous = before(revision, "putMachine", (c) => c.machine.id === change.machineId);
        return [
          {
            label: previous?.machine.name ?? name(change.machineId),
            before: "on the map",
            after: "removed",
          },
        ];
      }
      case "putPreset": {
        const previous = before(revision, "putPreset", (c) => c.preset.name === change.preset.name);
        const arrows = (n: number) => count(n, "arrow", "arrows");
        return [
          {
            label: `Preset ${change.preset.name}`,
            before: previous ? arrows(previous.preset.arrows.length) : NOTHING,
            after: arrows(change.preset.arrows.length),
          },
        ];
      }
      case "removePreset":
        return [{ label: `Preset ${change.name}`, before: "saved", after: "deleted" }];
      case "placePair": {
        const previous = before(revision, "placePair", (c) => c.a === change.a && c.b === change.b);
        const text = (moved: boolean) => (moved ? "moved by hand" : "automatic place");
        return [
          {
            label: `Card of ${name(change.a)} and ${name(change.b)}`,
            before: text(previous?.offset != null),
            after: text(change.offset !== null),
          },
        ];
      }
      case "putNote": {
        const next = change.note;
        const previous = before(revision, "putNote", (c) => c.note.id === next.id)?.note;
        if (!previous) return [{ label: "Note", before: NOTHING, after: noteQuote(next.text) }];
        const rows: Array<DiffRow> = [];
        if (previous.text !== next.text)
          rows.push({
            label: "Note text",
            before: noteQuote(previous.text),
            after: noteQuote(next.text),
          });
        if (previous.color !== next.color)
          rows.push({ label: "Note colour", before: previous.color, after: next.color });
        if (!samePosition(previous.position, next.position))
          rows.push({
            label: `Note ${noteQuote(next.text)}`,
            before: placeText(previous.position),
            after: placeText(next.position),
          });
        return rows;
      }
      case "removeNote": {
        const previous = before(revision, "putNote", (c) => c.note.id === change.id)?.note;
        return [
          {
            label: "Note",
            before: previous ? noteQuote(previous.text) : "a note",
            after: "deleted",
          },
        ];
      }
    }
  });
}

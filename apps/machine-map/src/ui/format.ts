import type {
  CommandStatus,
  MachineCommandInput,
  MachineLevel,
  MachineMapDocument,
  MachineMapRole,
  MachinePresence,
  MapActor,
  MapPosition,
} from "@t3tools/contracts/machineMap";
import type { HealthAlertKind } from "@t3tools/contracts/machineMapResources";

import { hasJoined } from "../rules/map.ts";

export const LEVEL_LABEL: Record<MachineLevel, string> = {
  none: "None",
  read: "Read only",
  standard: "Standard",
  admin: "Admin",
};

export const LEVEL_TEXT: Record<MachineLevel, string> = {
  none: "Cannot connect. Open sessions close at once.",
  read: "Sees threads, files, diffs and terminals. Cannot start or change anything.",
  standard: "Starts threads and agents, uses terminals, pushes and merges pull requests.",
  admin: "Standard, plus who can connect and pairing links.",
};

export const ROLE_TEXT: Record<MachineMapRole, string> = {
  none: "Agents on this machine cannot use the map.",
  read: "Agents read the map.",
  propose: "Agents propose changes. You approve them in the Inbox.",
  edit: "Agents change the map at once, except their own access.",
};

export const COMMAND_LABEL: Record<MachineCommandInput["_tag"], string> = {
  restartServer: "Restart server",
  installUpdate: "Install update",
  stopAllAgents: "Stop all agents",
  pauseScheduledTasks: "Pause scheduled tasks",
  resumeScheduledTasks: "Resume scheduled tasks",
  setScheduledTaskEnabled: "Pause or resume a task",
  runScheduledTask: "Run a task now",
  reloadWindows: "Reload windows",
  startThread: "Start thread",
  revokeClient: "Revoke client",
  collectDiagnostics: "Collect diagnostics",
  testArrow: "Test arrow",
};

/** MM-504: these ask for confirmation. */
export const DANGEROUS_COMMANDS: ReadonlySet<MachineCommandInput["_tag"]> = new Set([
  "restartServer",
  "stopAllAgents",
]);

export const machineName = (map: MachineMapDocument, id: string): string =>
  map.machines.find((m) => m.id === id)?.name ?? id;

export function timeAgo(iso: string | null, now: number): string {
  if (iso === null) return "never";
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function timeUntil(iso: string, now: number): string {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `in ${hours} h` : `in ${Math.round(hours / 24)} d`;
}

export const shortTime = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** MM-702, MM-806. Parts that the portal could not tell, like "Unknown browser", stay out. */
export function actorText(actor: MapActor, map: MachineMapDocument): string {
  switch (actor._tag) {
    case "owner": {
      const known = actor.device
        .split(" · ")
        .filter((part) => part.length > 0 && !part.startsWith("Unknown"));
      return [actor.email, ...known].join(" · ");
    }
    case "agent":
      return actor.threadTitle
        ? `Agent on ${machineName(map, actor.machineId)} · ${actor.threadTitle}`
        : `Agent on ${machineName(map, actor.machineId)}`;
    case "portal":
      return `Portal · ${actor.reason}`;
  }
}

/** MM-205, MM-601: the one word of the presence sticker. */
export type PresenceState = "online" | "offline" | "waiting";

export function presenceState(presence: MachinePresence | undefined): PresenceState {
  if (!presence || !hasJoined(presence)) return "waiting";
  return presence.online ? "online" : "offline";
}

/** The sticker look of each presence state and command status. */
export const PRESENCE_STICKER: Record<PresenceState, string> = {
  online: "ok",
  offline: "",
  waiting: "wait",
};
export const COMMAND_STICKER: Record<CommandStatus, string> = {
  queued: "wait",
  delivered: "wait",
  succeeded: "ok",
  failed: "",
  expired: "none",
  cancelled: "none",
};

/** MM-205, MM-601: presence as plain text, with the time since the last connection. */
export function presenceText(presence: MachinePresence | undefined, now: number): string {
  switch (presenceState(presence)) {
    case "waiting":
      return "Waiting to join";
    case "online":
      return "Online";
    case "offline":
      return `Offline, seen ${timeAgo(presence?.lastSeenAt ?? null, now)}`;
  }
}

export type Toward = "→" | "←" | "↓" | "↑";

export const TOWARD_TEXT: Record<Toward, string> = {
  "→": "to the right",
  "←": "to the left",
  "↓": "below",
  "↑": "above",
};

/**
 * MM-1103: where `to` sits on the map, seen from `from`, rounded to the nearest of the four
 * directions. The text of a row always reads "from uses to"; this glyph only hints at the map.
 */
export function towardGlyph(from: MapPosition, to: MapPosition): Toward {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "→" : "←";
  return dy >= 0 ? "↓" : "↑";
}

/** A short text of any setting value for tables. */
export function valueText(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "string") return value.length > 0 ? value : '""';
  const text = JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/** MM-1505: one word per alert, as a sticker on the machine card. */
export const ALERT_STICKER: Record<HealthAlertKind, string> = {
  cpu: "hot",
  memory: "full",
  disk: "disk",
  swap: "swap",
  offline: "down",
};

export const ALERT_TEXT: Record<HealthAlertKind, string> = {
  cpu: "CPU starved",
  memory: "Memory is almost full",
  disk: "Disk is almost full",
  swap: "Swap thrashing",
  offline: "Offline",
};

/** The value of an alert with its unit, for example `97% (over 90%)`. */
export function alertValue(kind: HealthAlertKind, value: number, threshold: number): string {
  if (kind === "offline") return `${value} min (over ${threshold} min)`;
  if (kind === "swap") return `${value} MB/s (over ${threshold} MB/s)`;
  return `${Math.round(value)}% (over ${threshold}%)`;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Bytes in binary units with up to 3 digits, for example `1.5 GB` or `640 MB`. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

export const formatPercent = (value: number | null): string =>
  value === null ? "—" : `${Math.round(value)}%`;

/** A span of time between two moments, for example `12 min` or `3 h 5 min`. */
export function duration(fromIso: string, toMs: number): string {
  const minutes = Math.max(0, Math.round((toMs - Date.parse(fromIso)) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  return `${Math.round(hours / 24)} days`;
}

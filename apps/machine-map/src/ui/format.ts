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

/** MM-602: false for a machine that never connected. Its changes wait for it to join, not in a queue. */
export function hasJoined(presence: MachinePresence | undefined): boolean {
  return presence !== undefined && (presence.online || presence.lastSeenAt !== null);
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

/**
 * MM-1103: "from can use to", drawn the way the map shows it: the left or top machine first,
 * and an arrow toward `to`, rounded to the nearest of the four directions.
 */
export function spatialArrow(
  from: MapPosition,
  to: MapPosition,
): { readonly first: "from" | "to"; readonly glyph: "→" | "←" | "↓" | "↑" } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy))
    return dx >= 0 ? { first: "from", glyph: "→" } : { first: "to", glyph: "←" };
  return dy >= 0 ? { first: "from", glyph: "↓" } : { first: "to", glyph: "↑" };
}

/** A short text of any setting value for tables. */
export function valueText(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "string") return value.length > 0 ? value : '""';
  const text = JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/**
 * Pure rules of the map document: apply changes with their inverse (MM-703), the desired state of
 * one machine (MM-603, MM-1202), and which machines a revision touches (MM-602).
 * The Durable Object and the page share this module.
 */
import {
  isMachineLocalSetting,
  type ArrowRecord,
  type ClientArrowRecord,
  type ClientId,
  type ClientRecord,
  type MachineDesiredState,
  type MachineId,
  type MachineLevel,
  type MachineMapDocument,
  type MachineMapRole,
  type MachinePresence,
  type MachineRecord,
  type MapChange,
  type MapNote,
  type MapPosition,
  type MapPreset,
  type PairOffset,
  type ScopedSettingValues,
  type SettingScope,
  type SettingValues,
} from "@t3tools/contracts/machineMap";

/** A change that breaks a map rule. The portal answers it with HTTP 409. */
export class MapRuleError extends Error {
  override readonly name = "MapRuleError";
}

/** MM-602, MM-709: false for a machine that never connected. Its changes and stops wait for it to join, not in a queue. */
export function hasJoined(presence: MachinePresence | undefined): boolean {
  return presence !== undefined && (presence.online || presence.lastSeenAt !== null);
}

export const LEVELS: ReadonlyArray<MachineLevel> = ["none", "read", "standard", "admin"];
export const MAP_ROLES: ReadonlyArray<MachineMapRole> = ["none", "read", "propose", "edit"];

export const levelRank = (level: MachineLevel): number => LEVELS.indexOf(level);
export const roleRank = (role: MachineMapRole): number => MAP_ROLES.indexOf(role);

export const emptyMap = (): MachineMapDocument => ({
  revision: 0,
  machines: [],
  arrows: [],
  settings: { shared: { server: {}, client: {} }, overrides: {} },
  presets: [],
  pairPlacements: [],
  notes: [],
  clients: [],
  clientArrows: [],
});

/** MM-301: a pair without a stored arrow is at level `none`. */
export const defaultArrow = (from: MachineId, to: MachineId): ArrowRecord => ({
  from,
  to,
  level: "none",
  agentTools: false,
  expiresAt: null,
  revertLevel: null,
});

/** MM-309: a client without a stored arrow to a machine is at level `none`. */
export const defaultClientArrow = (client: ClientId, to: MachineId): ClientArrowRecord => ({
  client,
  to,
  level: "none",
  expiresAt: null,
  revertLevel: null,
});

/** Spots for new machines: a grid inside the edges of the map. */
const SPOTS: ReadonlyArray<MapPosition> = [0.15, 0.38, 0.62, 0.85].flatMap((y) =>
  [0.12, 0.31, 0.5, 0.69, 0.88].map((x) => ({ x, y })),
);
/** The map is wider than tall on a desktop, so a step across counts more than a step down. */
const ACROSS = 1.6;

/**
 * MM-206: the place of a new machine. The first one goes to the middle. Each next one takes the
 * spot farthest from every machine, so new cards do not land on old ones. The owner moves them
 * later.
 */
export function freePosition(taken: ReadonlyArray<MapPosition>): MapPosition {
  if (taken.length === 0) return { x: 0.5, y: 0.5 };
  const room = (spot: MapPosition) =>
    Math.min(...taken.map((p) => Math.hypot((spot.x - p.x) * ACROSS, spot.y - p.y)));
  let best = SPOTS[0] ?? { x: 0.5, y: 0.5 };
  for (const spot of SPOTS) if (room(spot) > room(best)) best = spot;
  return best;
}

export const findMachine = (map: MachineMapDocument, id: MachineId): MachineRecord | undefined =>
  map.machines.find((machine) => machine.id === id);

export const findArrow = (map: MachineMapDocument, from: MachineId, to: MachineId): ArrowRecord =>
  map.arrows.find((arrow) => arrow.from === from && arrow.to === to) ?? defaultArrow(from, to);

/** The same offset seen from the other end: it runs the other way and lies on the other side. */
const flipOffset = (offset: PairOffset): PairOffset => ({
  along: 1 - offset.along,
  aside: -offset.aside,
});

/** A pair in stored order: `a` sorts before `b`. */
function storedPair(
  a: MachineId,
  b: MachineId,
  offset: PairOffset | null,
): { a: MachineId; b: MachineId; offset: PairOffset | null } {
  return a < b ? { a, b, offset } : { a: b, b: a, offset: offset && flipOffset(offset) };
}

/** MM-1108: where the owner put the card of a pair, seen from `a`. Null for the automatic place. */
export function pairOffset(map: MachineMapDocument, a: MachineId, b: MachineId): PairOffset | null {
  const key = storedPair(a, b, null);
  const found = map.pairPlacements.find((p) => p.a === key.a && p.b === key.b);
  if (!found) return null;
  const offset = { along: found.along, aside: found.aside };
  return a === key.a ? offset : flipOffset(offset);
}

export const findClient = (map: MachineMapDocument, id: ClientId): ClientRecord | undefined =>
  map.clients.find((client) => client.id === id);

export const findClientArrow = (
  map: MachineMapDocument,
  client: ClientId,
  to: MachineId,
): ClientArrowRecord =>
  map.clientArrows.find((arrow) => arrow.client === client && arrow.to === to) ??
  defaultClientArrow(client, to);

/** MM-905: the client that holds a browser key, if any. */
export const clientWithKey = (
  map: MachineMapDocument,
  thumbprint: string,
): ClientRecord | undefined =>
  map.clients.find((client) => client.keys.some((key) => key.thumbprint === thumbprint));

export const sameClientArrow = (a: ClientArrowRecord, b: ClientArrowRecord): boolean =>
  a.level === b.level && a.expiresAt === b.expiresAt && a.revertLevel === b.revertLevel;

export const findNote = (map: MachineMapDocument, id: string): MapNote | undefined =>
  map.notes.find((note) => note.id === id);

export const sameArrow = (a: ArrowRecord, b: ArrowRecord): boolean =>
  a.level === b.level &&
  a.agentTools === b.agentTools &&
  a.expiresAt === b.expiresAt &&
  a.revertLevel === b.revertLevel;

const isDefaultArrow = (arrow: ArrowRecord): boolean =>
  sameArrow(arrow, defaultArrow(arrow.from, arrow.to));

/** MM-406: the keys of one scope that have a shared value or an override. */
export function settingKeys(map: MachineMapDocument, scope: SettingScope): ReadonlySet<string> {
  const keys = new Set(Object.keys(map.settings.shared[scope]));
  for (const own of Object.values(map.settings.overrides)) {
    for (const key of Object.keys(own[scope])) keys.add(key);
  }
  return keys;
}

const hasKey = (values: SettingValues, key: string): boolean => Object.hasOwn(values, key);

const withoutKey = (values: SettingValues, key: string): SettingValues => {
  const next = { ...values };
  delete next[key];
  return next;
};

const emptyScoped = (): ScopedSettingValues => ({ server: {}, client: {} });

interface Step {
  readonly map: MachineMapDocument;
  /** Changes that undo this step, in apply order. */
  readonly inverse: ReadonlyArray<MapChange>;
}

export interface Applied {
  readonly map: MachineMapDocument;
  /** Changes that undo every applied change, in apply order (MM-703). */
  readonly inverse: ReadonlyArray<MapChange>;
}

/** Applies changes in order. The map keeps its revision number: the caller sets it. */
export function applyChanges(map: MachineMapDocument, changes: ReadonlyArray<MapChange>): Applied {
  let current = map;
  const inverses: Array<ReadonlyArray<MapChange>> = [];
  for (const change of changes) {
    const step = applyChange(current, change);
    current = step.map;
    inverses.push(step.inverse);
  }
  // The last change is undone first.
  return { map: current, inverse: inverses.toReversed().flat() };
}

function applyChange(map: MachineMapDocument, change: MapChange): Step {
  switch (change._tag) {
    case "setArrow":
      return setArrow(map, change.arrow);
    case "setSetting":
      return setSetting(map, change);
    case "putMachine":
      return putMachine(map, change.machine);
    case "removeMachine":
      return removeMachine(map, change.machineId);
    case "putPreset":
      return putPreset(map, change.preset);
    case "removePreset":
      return removePreset(map, change.name);
    case "placePair":
      return placePair(map, change.a, change.b, change.offset);
    case "putNote":
      return putNote(map, change.note);
    case "removeNote":
      return removeNote(map, change.id);
    case "putClient":
      return putClient(map, change.client);
    case "removeClient":
      return removeClient(map, change.clientId);
    case "addClientKey":
      return addClientKey(map, change.clientId, change.key);
    case "removeClientKey":
      return removeClientKey(map, change.clientId, change.thumbprint);
    case "setClientArrow":
      return setClientArrow(map, change.arrow);
  }
}

function setArrow(map: MachineMapDocument, arrow: ArrowRecord): Step {
  if (arrow.from === arrow.to) throw new MapRuleError("A machine has no arrow to itself.");
  for (const id of [arrow.from, arrow.to]) {
    if (!findMachine(map, id)) throw new MapRuleError(`Unknown machine ${id}.`);
  }
  if ((arrow.expiresAt === null) !== (arrow.revertLevel === null)) {
    throw new MapRuleError("An arrow expiry needs both a time and a level to return to.");
  }
  const previous = findArrow(map, arrow.from, arrow.to);
  const others = map.arrows.filter((a) => !(a.from === arrow.from && a.to === arrow.to));
  // A default arrow is not stored, so the document lists only arrows that grant something.
  const arrows = isDefaultArrow(arrow) ? others : [...others, arrow];
  return { map: { ...map, arrows }, inverse: [{ _tag: "setArrow", arrow: previous }] };
}

function setSetting(
  map: MachineMapDocument,
  change: Extract<MapChange, { _tag: "setSetting" }>,
): Step {
  const { machineId, scope, key, present, value } = change;
  // A clear still works, so an older map can drop a value that became machine-local.
  if (present && isMachineLocalSetting(scope, key)) {
    throw new MapRuleError(
      `The setting ${scope}.${key} belongs to each machine. The map cannot set it.`,
    );
  }
  if (present && value === undefined) throw new MapRuleError(`The setting ${key} needs a value.`);
  const settings = map.settings;
  if (machineId === null) {
    const values = settings.shared[scope];
    const inverse: MapChange = {
      ...change,
      present: hasKey(values, key),
      value: values[key] ?? null,
    };
    const nextValues = present ? { ...values, [key]: value } : withoutKey(values, key);
    return {
      map: {
        ...map,
        settings: { ...settings, shared: { ...settings.shared, [scope]: nextValues } },
      },
      inverse: [inverse],
    };
  }
  if (!findMachine(map, machineId)) throw new MapRuleError(`Unknown machine ${machineId}.`);
  const own = settings.overrides[machineId] ?? emptyScoped();
  const values = own[scope];
  const inverse: MapChange = {
    ...change,
    present: hasKey(values, key),
    value: values[key] ?? null,
  };
  const nextOwn = {
    ...own,
    [scope]: present ? { ...values, [key]: value } : withoutKey(values, key),
  };
  const overrides = { ...settings.overrides };
  if (Object.keys(nextOwn.server).length === 0 && Object.keys(nextOwn.client).length === 0) {
    delete overrides[machineId];
  } else {
    overrides[machineId] = nextOwn;
  }
  return { map: { ...map, settings: { ...settings, overrides } }, inverse: [inverse] };
}

function putMachine(map: MachineMapDocument, machine: MachineRecord): Step {
  const clash = map.machines.find(
    (other) => other.id !== machine.id && other.tokenClientId === machine.tokenClientId,
  );
  if (clash) throw new MapRuleError(`${clash.name} already uses this machine token.`);
  const previous = findMachine(map, machine.id);
  const machines = previous
    ? map.machines.map((m) => (m.id === machine.id ? machine : m))
    : [...map.machines, machine];
  return {
    map: { ...map, machines },
    inverse: [
      previous
        ? { _tag: "putMachine", machine: previous }
        : { _tag: "removeMachine", machineId: machine.id },
    ],
  };
}

/** MM-208: removes the machine, its arrows and its overrides. */
function removeMachine(map: MachineMapDocument, machineId: MachineId): Step {
  const previous = findMachine(map, machineId);
  if (!previous) throw new MapRuleError(`Unknown machine ${machineId}.`);
  const removedArrows = map.arrows.filter((a) => a.from === machineId || a.to === machineId);
  const removedClientArrows = map.clientArrows.filter((a) => a.to === machineId);
  const own = map.settings.overrides[machineId];
  const inverse: Array<MapChange> = [{ _tag: "putMachine", machine: previous }];
  for (const arrow of removedArrows) inverse.push({ _tag: "setArrow", arrow });
  for (const arrow of removedClientArrows) inverse.push({ _tag: "setClientArrow", arrow });
  const touchesMachine = (p: { a: MachineId; b: MachineId }) =>
    p.a === machineId || p.b === machineId;
  for (const { a, b, along, aside } of map.pairPlacements.filter(touchesMachine)) {
    inverse.push({ _tag: "placePair", a, b, offset: { along, aside } });
  }
  if (own) {
    for (const scope of ["server", "client"] as const) {
      for (const [key, value] of Object.entries(own[scope])) {
        inverse.push({ _tag: "setSetting", machineId, scope, key, present: true, value });
      }
    }
  }
  const overrides = { ...map.settings.overrides };
  delete overrides[machineId];
  return {
    map: {
      ...map,
      machines: map.machines.filter((m) => m.id !== machineId),
      arrows: map.arrows.filter((a) => a.from !== machineId && a.to !== machineId),
      clientArrows: map.clientArrows.filter((a) => a.to !== machineId),
      settings: { ...map.settings, overrides },
      pairPlacements: map.pairPlacements.filter((p) => !touchesMachine(p)),
    },
    inverse,
  };
}

function putPreset(map: MachineMapDocument, preset: MapPreset): Step {
  const previous = map.presets.find((p) => p.name === preset.name);
  return {
    map: { ...map, presets: [...map.presets.filter((p) => p.name !== preset.name), preset] },
    inverse: [
      previous
        ? { _tag: "putPreset", preset: previous }
        : { _tag: "removePreset", name: preset.name },
    ],
  };
}

function removePreset(map: MachineMapDocument, name: string): Step {
  const previous = map.presets.find((p) => p.name === name);
  if (!previous) throw new MapRuleError(`Unknown preset ${name}.`);
  return {
    map: { ...map, presets: map.presets.filter((p) => p.name !== name) },
    inverse: [{ _tag: "putPreset", preset: previous }],
  };
}

function placePair(
  map: MachineMapDocument,
  a: MachineId,
  b: MachineId,
  offset: PairOffset | null,
): Step {
  if (a === b) throw new MapRuleError("A machine has no pair with itself.");
  for (const id of [a, b]) {
    if (!findMachine(map, id)) throw new MapRuleError(`Unknown machine ${id}.`);
  }
  const previous = pairOffset(map, a, b);
  const key = storedPair(a, b, offset);
  const others = map.pairPlacements.filter((p) => !(p.a === key.a && p.b === key.b));
  const pairPlacements = key.offset ? [...others, { a: key.a, b: key.b, ...key.offset }] : others;
  return {
    map: { ...map, pairPlacements },
    inverse: [{ _tag: "placePair", a, b, offset: previous }],
  };
}

function putNote(map: MachineMapDocument, note: MapNote): Step {
  const previous = findNote(map, note.id);
  const notes = previous
    ? map.notes.map((n) => (n.id === note.id ? note : n))
    : [...map.notes, note];
  return {
    map: { ...map, notes },
    inverse: [previous ? { _tag: "putNote", note: previous } : { _tag: "removeNote", id: note.id }],
  };
}

function removeNote(map: MachineMapDocument, id: string): Step {
  const previous = findNote(map, id);
  if (!previous) throw new MapRuleError("This note is gone.");
  return {
    map: { ...map, notes: map.notes.filter((n) => n.id !== id) },
    inverse: [{ _tag: "putNote", note: previous }],
  };
}

/** MM-904, MM-905: a browser key belongs to one client only. */
function putClient(map: MachineMapDocument, client: ClientRecord): Step {
  const thumbprints = client.keys.map((key) => key.thumbprint);
  if (new Set(thumbprints).size !== thumbprints.length)
    throw new MapRuleError(`${client.name} lists a browser key twice.`);
  const clash = map.clients.find(
    (other) =>
      other.id !== client.id && other.keys.some((key) => thumbprints.includes(key.thumbprint)),
  );
  if (clash) throw new MapRuleError(`${clash.name} already holds this browser key.`);
  const previous = findClient(map, client.id);
  // MM-907, MM-909: keys of an existing client change only with addClientKey and removeClientKey.
  if (previous && !sameJson(previous.keys, client.keys))
    throw new MapRuleError(`The keys of ${previous.name} change only by approval or removal.`);
  const clients = previous
    ? map.clients.map((c) => (c.id === client.id ? client : c))
    : [...map.clients, client];
  return {
    map: { ...map, clients },
    inverse: [
      previous
        ? { _tag: "putClient", client: previous }
        : { _tag: "removeClient", clientId: client.id },
    ],
  };
}

/** MM-910: removes the client with its keys and arrows. */
function removeClient(map: MachineMapDocument, clientId: ClientId): Step {
  const previous = findClient(map, clientId);
  if (!previous) throw new MapRuleError(`Unknown client ${clientId}.`);
  const removedArrows = map.clientArrows.filter((a) => a.client === clientId);
  return {
    map: {
      ...map,
      clients: map.clients.filter((c) => c.id !== clientId),
      clientArrows: map.clientArrows.filter((a) => a.client !== clientId),
    },
    inverse: [
      { _tag: "putClient", client: previous },
      ...removedArrows.map((arrow): MapChange => ({ _tag: "setClientArrow", arrow })),
    ],
  };
}

type ClientKey = ClientRecord["keys"][number];

/** MM-907: an approved key joins an existing client. A key belongs to one client only. */
function addClientKey(map: MachineMapDocument, clientId: ClientId, key: ClientKey): Step {
  const client = findClient(map, clientId);
  if (!client) throw new MapRuleError(`Unknown client ${clientId}.`);
  const holder = clientWithKey(map, key.thumbprint);
  if (holder) throw new MapRuleError(`${holder.name} already holds this browser key.`);
  return {
    map: {
      ...map,
      clients: map.clients.map((c) => (c.id === clientId ? { ...c, keys: [...c.keys, key] } : c)),
    },
    inverse: [{ _tag: "removeClientKey", clientId, thumbprint: key.thumbprint }],
  };
}

/** MM-909: removes one browser key. The removed browser can sign in again and wait. */
function removeClientKey(map: MachineMapDocument, clientId: ClientId, thumbprint: string): Step {
  const client = findClient(map, clientId);
  const key = client?.keys.find((k) => k.thumbprint === thumbprint);
  if (!client || !key) throw new MapRuleError("This browser key is gone.");
  return {
    map: {
      ...map,
      clients: map.clients.map((c) =>
        c.id === clientId ? { ...c, keys: c.keys.filter((k) => k.thumbprint !== thumbprint) } : c,
      ),
    },
    inverse: [{ _tag: "addClientKey", clientId, key }],
  };
}

function setClientArrow(map: MachineMapDocument, arrow: ClientArrowRecord): Step {
  if (!findClient(map, arrow.client)) throw new MapRuleError(`Unknown client ${arrow.client}.`);
  if (!findMachine(map, arrow.to)) throw new MapRuleError(`Unknown machine ${arrow.to}.`);
  if ((arrow.expiresAt === null) !== (arrow.revertLevel === null)) {
    throw new MapRuleError("An arrow expiry needs both a time and a level to return to.");
  }
  const previous = findClientArrow(map, arrow.client, arrow.to);
  const others = map.clientArrows.filter((a) => !(a.client === arrow.client && a.to === arrow.to));
  const isDefault = sameClientArrow(arrow, defaultClientArrow(arrow.client, arrow.to));
  return {
    map: { ...map, clientArrows: isDefault ? others : [...others, arrow] },
    inverse: [{ _tag: "setClientArrow", arrow: previous }],
  };
}

const samePublicFacts = (a: MachineRecord, b: MachineRecord): boolean =>
  a.name === b.name &&
  a.kind === b.kind &&
  a.hostname === b.hostname &&
  a.tokenClientId === b.tokenClientId;

/**
 * Checks changes that the owner or an agent sends. Only the portal itself adds a machine, removes
 * a machine or records a hostname, because those steps also create or delete a machine token.
 * This also makes the revisions that add or remove a machine impossible to undo.
 */
export function checkEditableChanges(
  map: MachineMapDocument,
  changes: ReadonlyArray<MapChange>,
): void {
  let current = map;
  for (const change of changes) {
    if (change._tag === "putClient") {
      const previous = findClient(current, change.client.id);
      if (!previous) throw new MapRuleError("Approve a waiting sign-in to add a client.");
      const next = change.client;
      if (next.email !== previous.email || next.createdAt !== previous.createdAt) {
        throw new MapRuleError(`The email of ${previous.name} comes from its approval.`);
      }
    }
    // MM-907: a browser key enters the map only through an approval, which needs a fresh MFA.
    if (change._tag === "addClientKey") {
      throw new MapRuleError("A browser key joins a client only through an approval.");
    }
    if (change._tag === "removeMachine") {
      throw new MapRuleError('Use "Remove machine" to remove a machine.');
    }
    if (change._tag === "putMachine") {
      const previous = findMachine(current, change.machine.id);
      if (!previous) throw new MapRuleError('Use "Add machine" to add a machine.');
      const next = change.machine;
      if (
        next.tokenClientId !== previous.tokenClientId ||
        next.hostname !== previous.hostname ||
        next.createdAt !== previous.createdAt
      ) {
        throw new MapRuleError(
          `The token and the hostname of ${previous.name} come from the machine.`,
        );
      }
    }
    current = applyChange(current, change).map;
  }
}

/**
 * MM-909: an owner record of a client keeps the keys that the client has now. A held draft, an open
 * panel or a drag can hold an older record, and that record must not drop a key approved since.
 */
export function keepClientKeys(
  map: MachineMapDocument,
  changes: ReadonlyArray<MapChange>,
): ReadonlyArray<MapChange> {
  return changes.map((change): MapChange => {
    if (change._tag !== "putClient") return change;
    const current = findClient(map, change.client.id);
    return current ? { ...change, client: { ...change.client, keys: current.keys } } : change;
  });
}

/**
 * MM-720: the changes of an undo. A client keeps its current keys, and the arrows of a client that
 * left the map since are skipped, for example in the undo of an old machine removal.
 */
export const undoChanges = (
  map: MachineMapDocument,
  inverse: ReadonlyArray<MapChange>,
): ReadonlyArray<MapChange> =>
  keepClientKeys(
    map,
    inverse.filter((c) => c._tag !== "setClientArrow" || findClient(map, c.arrow.client)),
  );

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

type RevisionChanges = {
  readonly changes: ReadonlyArray<MapChange>;
  readonly inverse: ReadonlyArray<MapChange>;
};

/** The record of a machine before the revision. The inverse lists it; the last match is the oldest. */
const previousMachine = (revision: RevisionChanges, id: MachineId): MachineRecord | undefined =>
  revision.inverse.findLast(
    (c): c is Extract<MapChange, { _tag: "putMachine" }> =>
      c._tag === "putMachine" && c.machine.id === id,
  )?.machine;

/**
 * Whether the revision adds the machine or changes the facts of it that other machines apply:
 * name, kind, hostname and token. A move or a map role change returns false.
 */
export const changesPublicFacts = (revision: RevisionChanges, machine: MachineRecord): boolean => {
  const previous = previousMachine(revision, machine.id);
  return !previous || !samePublicFacts(previous, machine);
};

/** The machines whose desired state a revision can change. `all` means every machine. */
export function machinesTouched(revision: RevisionChanges): ReadonlySet<MachineId> | "all" {
  const touched = new Set<MachineId>();
  for (const change of revision.changes) {
    switch (change._tag) {
      case "setArrow":
        touched.add(change.arrow.from);
        touched.add(change.arrow.to);
        break;
      case "setSetting":
        if (change.machineId === null) return "all";
        touched.add(change.machineId);
        break;
      case "removeMachine":
        return "all";
      case "putMachine": {
        const previous = previousMachine(revision, change.machine.id);
        if (!previous || !samePublicFacts(previous, change.machine)) return "all";
        // A move changes only the place on the map, which no machine applies.
        if (previous.mapRole !== change.machine.mapRole) touched.add(change.machine.id);
        break;
      }
      case "putPreset":
      case "removePreset":
      // No machine applies client records yet. Clients reach machines through Cloudflare Access.
      case "putClient":
      case "removeClient":
      case "setClientArrow":
      case "addClientKey":
      case "removeClientKey":
      // MM-1108, MM-1109: display data. No machine applies it.
      case "placePair":
      case "putNote":
      case "removeNote":
        break;
    }
  }
  return touched;
}

export const touches = (
  revision: Parameters<typeof machinesTouched>[0],
  machineId: MachineId,
): boolean => {
  const touched = machinesTouched(revision);
  return touched === "all" || touched.has(machineId);
};

/** The settings that one machine applies: shared values with its overrides on top. */
export function effectiveSettings(
  map: MachineMapDocument,
  machineId: MachineId,
): ScopedSettingValues {
  const result: Record<SettingScope, Record<string, unknown>> = { server: {}, client: {} };
  const own = map.settings.overrides[machineId];
  for (const scope of ["server", "client"] as const) {
    // Older maps can hold a value for a key that became machine-local: no machine applies it.
    for (const key of settingKeys(map, scope)) {
      if (isMachineLocalSetting(scope, key)) continue;
      if (own && hasKey(own[scope], key)) {
        result[scope][key] = own[scope][key];
      } else if (hasKey(map.settings.shared[scope], key)) {
        result[scope][key] = map.settings.shared[scope][key];
      }
    }
  }
  return result;
}

/**
 * MM-603, MM-1202: what one machine applies. It holds the machine itself, the public facts of the
 * other machines and every arrow that touches it, with level `none` for pairs without an arrow.
 * MM-718: `paused` is true while the emergency pause is on.
 */
export function desiredState(
  map: MachineMapDocument,
  machineId: MachineId,
  paused: boolean,
): MachineDesiredState | undefined {
  const self = findMachine(map, machineId);
  if (!self) return undefined;
  const others = map.machines.filter((m) => m.id !== machineId);
  return {
    revision: map.revision,
    self,
    peers: others.map(({ id, name, kind, hostname, tokenClientId }) => ({
      id,
      name,
      kind,
      hostname,
      tokenClientId,
    })),
    arrowsIn: others.map((other) => findArrow(map, other.id, machineId)),
    arrowsOut: others.map((other) => findArrow(map, machineId, other.id)),
    settings: effectiveSettings(map, machineId),
    paused,
  };
}

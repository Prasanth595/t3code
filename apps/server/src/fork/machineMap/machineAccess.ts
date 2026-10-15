/**
 * Fork: machine map. What another machine may do on this one, from the desired state. Pure
 * functions, so the auth hooks and their tests share one rule set.
 */
import {
  type ArrowRecord,
  type AuthEnvironmentScope,
  clientSessionSubject,
  type DesiredClient,
  type AuthMcpClientAccess,
  MACHINE_LEVEL_SCOPES,
  type MachineDesiredState,
  type MachineId,
  type MachineLevel,
  type PeerMachine,
  machineSessionSubject,
} from "@t3tools/contracts";

/** What a pairing credential for a machine holds (MM-1305). */
export interface MachineGrant {
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly label: string;
}

/**
 * The level of an arrow at `nowMs`. An arrow past its expiry has its revert level, so a machine
 * that missed the expiry revision of the portal (MM-304) still enforces it.
 */
export const effectiveLevel = (
  arrow: Pick<ArrowRecord, "level" | "expiresAt" | "revertLevel">,
  nowMs: number,
): MachineLevel =>
  arrow.expiresAt !== null && Date.parse(arrow.expiresAt) <= nowMs
    ? (arrow.revertLevel ?? "none")
    : arrow.level;

const arrowFrom = (desired: MachineDesiredState, from: MachineId) =>
  desired.arrowsIn.find((arrow) => arrow.from === from && arrow.to === desired.self.id);

/** MM-1305: the grant for the machine whose token signed the request. Undefined for `none`. */
export const machineGrantFor = (
  desired: MachineDesiredState,
  tokenClientId: string,
  nowMs: number,
): MachineGrant | undefined => {
  const peer = desired.peers.find((candidate) => candidate.tokenClientId === tokenClientId);
  if (peer === undefined || peer.id === desired.self.id) return undefined;
  const arrow = arrowFrom(desired, peer.id);
  if (arrow === undefined) return undefined;
  const level = effectiveLevel(arrow, nowMs);
  if (level === "none") return undefined;
  return {
    subject: machineSessionSubject(peer.id),
    scopes: MACHINE_LEVEL_SCOPES[level],
    label: `machine ${peer.name}`,
  };
};

/**
 * MM-912: the grant for the native client whose app token signed the request. A client token is
 * never an owner subject, so without this grant it gets nothing. Undefined for `none`.
 */
export const clientGrantFor = (
  desired: MachineDesiredState,
  tokenClientId: string,
  nowMs: number,
): MachineGrant | undefined => {
  const client = desired.clients?.find((candidate) => candidate.tokenClientId === tokenClientId);
  if (client === undefined) return undefined;
  const level = effectiveLevel(client, nowMs);
  if (level === "none") return undefined;
  return {
    subject: clientSessionSubject(client.id),
    scopes: MACHINE_LEVEL_SCOPES[level],
    label: `client ${client.name}`,
  };
};

/**
 * MM-912: the clients whose level on this machine changed between two desired states, read like
 * `sourcesWithChangedLevel`. A client that left the desired state counts as a change to `none`.
 */
export const clientsWithChangedLevel = (
  previous: MachineDesiredState | null,
  previousAtMs: number | null,
  next: MachineDesiredState | null,
  nowMs: number,
): ReadonlyArray<DesiredClient["id"]> => {
  const clients = (desired: MachineDesiredState | null) =>
    (desired?.clients ?? []).map((client) => [client.id, client] as const);
  return sourcesWithChangedLevel(clients(previous), previousAtMs, clients(next), nowMs);
};

const MACHINE_SUBJECT_PREFIX = "machine:";
const CLIENT_SUBJECT_PREFIX = "client:";

/** The peer of a session subject `machine:<id>`, or undefined for any other subject. */
const peerOfSubject = (desired: MachineDesiredState, subject: string): PeerMachine | undefined =>
  subject.startsWith(MACHINE_SUBJECT_PREFIX)
    ? desired.peers.find(
        (peer) => machineSessionSubject(peer.id) === subject && peer.id !== desired.self.id,
      )
    : undefined;

export const isMachineSubject = (subject: string) => subject.startsWith(MACHINE_SUBJECT_PREFIX);

/** A session that exists only through the map: a machine (MM-1305) or a client (MM-912). */
export const isMapSubject = (subject: string) =>
  isMachineSubject(subject) || subject.startsWith(CLIENT_SUBJECT_PREFIX);

/**
 * MM-1307: the MCP access of a machine session, or undefined when its arrow has no agent tools.
 * `read` only reads. `standard` and `admin` hold every scope that a full-access MCP client holds.
 */
export const machineMcpAccessFor = (
  desired: MachineDesiredState,
  subject: string,
  nowMs: number,
): { readonly peer: PeerMachine; readonly access: AuthMcpClientAccess } | undefined => {
  const peer = peerOfSubject(desired, subject);
  if (peer === undefined) return undefined;
  const arrow = arrowFrom(desired, peer.id);
  if (arrow === undefined || !arrow.agentTools) return undefined;
  const level = effectiveLevel(arrow, nowMs);
  if (level === "none") return undefined;
  return { peer, access: level === "read" ? "read-only" : "full-access" };
};

/**
 * The session subject of the desktop app that runs this server. Its bootstrap credential comes
 * over the desktop IPC channel, and with tunnel pairing on, the server refuses it through the
 * tunnel. So only the local desktop app gets the machine token (MM-306, MM-1401).
 */
export const isLocalDesktopSubject = (subject: string) => subject === "desktop-bootstrap";

const MACHINE_REQUEST_NAMESPACE_PREFIX = "machine-session:";

/**
 * The MCP request namespace of a machine session. The machine map tools refuse such callers, so
 * an agent on another machine cannot borrow the map role or the arrows of this machine.
 */
export const machineRequestNamespace = (client: { readonly sessionId: string }) =>
  `${MACHINE_REQUEST_NAMESPACE_PREFIX}${client.sessionId}`;

export const isMachineRequestNamespace = (requestNamespace: string) =>
  requestNamespace.startsWith(MACHINE_REQUEST_NAMESPACE_PREFIX);

type Leveled = Pick<ArrowRecord, "level" | "expiresAt" | "revertLevel">;

/**
 * MM-1306: the sources whose sessions must end. A session got the level of its arrow at the time
 * the old desired state arrived (`previousAtMs`), so the old side reads that level and the new
 * side the level now. An arrow that expired between the two states then counts as a change, and
 * an arrow that had expired before the old state arrived does not. A state saved before the time
 * was kept (`null`) reads its raw level.
 */
const sourcesWithChangedLevel = <K>(
  previous: ReadonlyArray<readonly [K, Leveled]>,
  previousAtMs: number | null,
  next: ReadonlyArray<readonly [K, Leveled]>,
  nowMs: number,
): ReadonlyArray<K> => {
  const before = new Map(
    previous.map(
      ([source, arrow]) =>
        [
          source,
          previousAtMs === null ? arrow.level : effectiveLevel(arrow, previousAtMs),
        ] as const,
    ),
  );
  const after = new Map(
    next.map(([source, arrow]) => [source, effectiveLevel(arrow, nowMs)] as const),
  );
  return [...new Set([...before.keys(), ...after.keys()])].filter(
    (source) => (before.get(source) ?? "none") !== (after.get(source) ?? "none"),
  );
};

/**
 * MM-1306: the peers whose level into this machine changed between two desired states. A peer
 * that left the map counts as a change to `none`.
 */
export const peersWithChangedLevel = (
  previous: MachineDesiredState | null,
  previousAtMs: number | null,
  next: MachineDesiredState | null,
  nowMs: number,
): ReadonlyArray<MachineId> => {
  const arrowsIn = (desired: MachineDesiredState | null) =>
    (desired?.arrowsIn ?? [])
      .filter((arrow) => arrow.to === desired?.self.id)
      .map((arrow) => [arrow.from, arrow] as const);
  return sourcesWithChangedLevel(arrowsIn(previous), previousAtMs, arrowsIn(next), nowMs);
};

/**
 * MM-304, MM-912: the next arrow into this machine that expires after `afterMs`, with the session
 * subjects whose level drops at that time. Undefined when no arrow expires later.
 */
export const nextExpiry = (
  desired: MachineDesiredState,
  afterMs: number,
): { readonly atMs: number; readonly subjects: ReadonlyArray<string> } | undefined => {
  const expiring = [
    ...desired.arrowsIn
      .filter((arrow) => arrow.to === desired.self.id)
      .map((arrow) => [machineSessionSubject(arrow.from), arrow] as const),
    ...(desired.clients ?? []).map((client) => [clientSessionSubject(client.id), client] as const),
  ].flatMap(([subject, arrow]) => {
    if (arrow.expiresAt === null || (arrow.revertLevel ?? "none") === arrow.level) return [];
    const atMs = Date.parse(arrow.expiresAt);
    // A time that does not parse never fires, and the portal revision still ends the sessions.
    return atMs > afterMs ? [{ subject, atMs }] : [];
  });
  if (expiring.length === 0) return undefined;
  const atMs = Math.min(...expiring.map((e) => e.atMs));
  return { atMs, subjects: expiring.filter((e) => e.atMs === atMs).map((e) => e.subject) };
};

/** MM-306: the peers this machine can use, with the origin of their T3 server. */
export const reachablePeers = (desired: MachineDesiredState | null, nowMs: number) =>
  (desired?.arrowsOut ?? []).flatMap((arrow) => {
    if (arrow.from !== desired?.self.id) return [];
    const level = effectiveLevel(arrow, nowMs);
    const machine = desired.peers.find((peer) => peer.id === arrow.to);
    if (level === "none" || machine === undefined || machine.hostname === null) return [];
    return [
      { machine, level, agentTools: arrow.agentTools, origin: `https://${machine.hostname}` },
    ];
  });

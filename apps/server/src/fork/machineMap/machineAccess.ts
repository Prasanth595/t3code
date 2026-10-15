/**
 * Fork: machine map. What another machine may do on this one, from the desired state. Pure
 * functions, so the auth hooks and their tests share one rule set.
 */
import {
  type ArrowRecord,
  type AuthEnvironmentScope,
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

const MACHINE_SUBJECT_PREFIX = "machine:";

/** The peer of a session subject `machine:<id>`, or undefined for any other subject. */
const peerOfSubject = (desired: MachineDesiredState, subject: string): PeerMachine | undefined =>
  subject.startsWith(MACHINE_SUBJECT_PREFIX)
    ? desired.peers.find(
        (peer) => machineSessionSubject(peer.id) === subject && peer.id !== desired.self.id,
      )
    : undefined;

export const isMachineSubject = (subject: string) => subject.startsWith(MACHINE_SUBJECT_PREFIX);

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
 * MM-1306: the sources whose sessions must end. A session got the level that its arrow had when the
 * desired state arrived, so the old side reads the raw level and the new side the level now. An
 * arrow that expired between the two states then counts as a change, and its sessions end.
 */
const sourcesWithChangedLevel = <K>(
  previous: ReadonlyArray<readonly [K, Leveled]>,
  next: ReadonlyArray<readonly [K, Leveled]>,
  nowMs: number,
): ReadonlyArray<K> => {
  const before = new Map(previous.map(([source, arrow]) => [source, arrow.level] as const));
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
  next: MachineDesiredState | null,
  nowMs: number,
): ReadonlyArray<MachineId> => {
  const arrowsIn = (desired: MachineDesiredState | null) =>
    (desired?.arrowsIn ?? [])
      .filter((arrow) => arrow.to === desired?.self.id)
      .map((arrow) => [arrow.from, arrow] as const);
  return sourcesWithChangedLevel(arrowsIn(previous), arrowsIn(next), nowMs);
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

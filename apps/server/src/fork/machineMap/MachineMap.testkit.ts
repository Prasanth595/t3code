/** Fork: machine map test data. */
import {
  type ArrowRecord,
  type MachineDesiredState,
  MachineId,
  type MachineLevel,
  type PeerMachine,
} from "@t3tools/contracts";

export const SELF = MachineId.make("mac");
export const PEER = MachineId.make("vps");
export const PEER_TOKEN = "vps-token.access";

const peer = (id: MachineId, overrides: Partial<PeerMachine> = {}): PeerMachine => ({
  id,
  name: id.toUpperCase(),
  kind: "server",
  hostname: `t3-${id}.example.com`,
  tokenClientId: `${id}-token.access`,
  ...overrides,
});

export const arrow = (
  from: MachineId,
  to: MachineId,
  level: MachineLevel,
  overrides: Partial<ArrowRecord> = {},
): ArrowRecord => ({
  from,
  to,
  level,
  agentTools: false,
  expiresAt: null,
  revertLevel: null,
  ...overrides,
});

/** The desired state of `SELF` with one peer, `PEER`, and the given arrows. */
export const desiredState = (input: {
  readonly revision?: number;
  readonly arrowsIn?: ReadonlyArray<ArrowRecord>;
  readonly arrowsOut?: ReadonlyArray<ArrowRecord>;
  readonly server?: Readonly<Record<string, unknown>>;
  readonly client?: Readonly<Record<string, unknown>>;
  readonly paused?: boolean;
}): MachineDesiredState => ({
  revision: input.revision ?? 1,
  self: {
    id: SELF,
    name: "Mac",
    kind: "laptop",
    tokenClientId: "mac-token.access",
    hostname: "t3-mac.example.com",
    position: { x: 0.2, y: 0.5 },
    mapRole: "read",
    createdAt: "2026-10-13T08:00:00.000Z",
  },
  peers: [peer(PEER, { tokenClientId: PEER_TOKEN })],
  arrowsIn: input.arrowsIn ?? [],
  arrowsOut: input.arrowsOut ?? [],
  settings: { server: input.server ?? {}, client: input.client ?? {} },
  ...(input.paused === undefined ? {} : { paused: input.paused }),
});

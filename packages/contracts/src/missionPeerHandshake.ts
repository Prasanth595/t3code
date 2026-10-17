import * as Schema from "effect/Schema";

import { HostProtocolId } from "./missionHostProtocol.ts";
import { Sha256Hex } from "./missionRetro.ts";

/** Attests only the handler implemented by this slice, never generic descriptor flags. */
export const PeerCapabilityAttestation = Schema.Struct({
  protocol: Schema.Literal("mission-peer-handshake/v1"),
  handlers: Schema.Tuple([Schema.Literal("POST /api/mission-peer/handshake")]),
  fencing: Schema.Literal("unsupported"),
  durableAck: Schema.Literal("volatile"),
});
export type PeerCapabilityAttestation = typeof PeerCapabilityAttestation.Type;

export const PeerRuntimeAttestation = Schema.Struct({
  receiverEnvironmentId: HostProtocolId,
  receiverBootId: HostProtocolId,
  runtimeBuildId: HostProtocolId,
  buildSha256: Sha256Hex,
  buildReceiptId: HostProtocolId,
  capabilities: PeerCapabilityAttestation,
});
export type PeerRuntimeAttestation = typeof PeerRuntimeAttestation.Type;

// JWTs are credentials: bounded on input, never returned in an error or logged.
export const PeerProofEnvelope = Schema.Struct({
  proof: Schema.String.check(
    Schema.makeFilter((value) => value.length > 0 && value.length <= 16_384, {
      expected: "a bounded signed peer proof",
    }),
  ),
});
export type PeerProofEnvelope = typeof PeerProofEnvelope.Type;

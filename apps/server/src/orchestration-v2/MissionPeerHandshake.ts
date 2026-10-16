// @effect-diagnostics nodeBuiltinImport:off -- source computes hashes over authenticated attestations.
import { createHash, createPublicKey } from "node:crypto";
import { verifyRelayJwt } from "@t3tools/shared/relayJwt";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { NonNegativeInt } from "../../../../packages/contracts/src/baseSchemas.ts";
import {
  HostProtocolId,
  HostTransportBinding,
} from "../../../../packages/contracts/src/missionHostProtocol.ts";
import { Sha256Hex } from "../../../../packages/contracts/src/missionRetro.ts";
import * as Store from "./MissionPeerHandshakeStore.ts";
import * as Facts from "./MissionPeerRuntimeFacts.ts";

export const MISSION_PEER_HANDSHAKE_PATH = "/api/mission-peer/handshake";
const REQUEST_TYP = "t3-mission-peer-request+jwt";
const RESPONSE_TYP = "t3-mission-peer-response+jwt";
const LIFETIME_MS = 30_000;

/**
 * Private bootstrap input, sourced from reviewed approved-peer configuration.
 * Never decode this from a request, session metadata, descriptor, or persona.
 * Both endpoint environments and the canonical mission authority are explicit.
 */
export const PeerTrustConfig = Schema.Struct({
  approvalRef: HostProtocolId,
  company: Schema.Literal("No Fun"),
  teamId: HostProtocolId,
  authorityEnvironmentId: HostProtocolId,
  sourceEnvironmentId: HostProtocolId,
  receiverEnvironmentId: HostProtocolId,
  sourceHostId: HostProtocolId,
  receiverHostId: HostProtocolId,
  sourcePublicKey: Schema.String,
  receiverPublicKey: Schema.String,
  receiverBuildSha256: Sha256Hex,
  /** HTTPS origin only; path is fixed by the implemented handler. */
  receiverOrigin: Schema.String,
});
export type PeerTrustConfig = typeof PeerTrustConfig.Type;

/** The owner supplies a callback over its EXISTING environment key. No key store is created. */
export type PeerSigner = (input: {
  readonly typ: string;
  readonly payload: Readonly<Record<string, unknown>>;
}) => Effect.Effect<string, unknown>;

export class MissionPeerHandshakeError extends Schema.TaggedError<MissionPeerHandshakeError>()(
  "MissionPeerHandshakeError",
  {
    category: Schema.Literals([
      "unconfigured", "invalid_config", "invalid_proof", "expired", "replay",
      "runtime_unavailable", "persistence", "signing", "transport",
    ]),
  },
) {
  override get message() { return `Mission peer handshake refused (${this.category}).`; }
}

const JwtFields = {
  iss: HostProtocolId,
  aud: HostProtocolId,
  sub: HostProtocolId,
  jti: HostProtocolId,
  iat: NonNegativeInt,
  exp: NonNegativeInt,
  version: Schema.Literal(1),
  scopeDigest: Sha256Hex,
  nonce: HostProtocolId,
};
const RequestProof = Schema.Struct(JwtFields);
const ResponseProof = Schema.Struct({ ...JwtFields, attestation: Facts.PeerRuntimeAttestation });

// JWTs are credentials: bounded on input, never returned in an error or logged.
export const PeerProofEnvelope = Schema.Struct({
  proof: Schema.String.check(Schema.makeFilter(
    (value) => value.length > 0 && value.length <= 16_384,
    { expected: "a bounded signed peer proof" },
  )),
});
export type PeerProofEnvelope = typeof PeerProofEnvelope.Type;

export class MissionPeerHandshake extends Context.Service<MissionPeerHandshake, {
  readonly begin: Effect.Effect<{
    readonly nonce: string;
    readonly origin: string;
    readonly request: PeerProofEnvelope;
  }, MissionPeerHandshakeError>;
  readonly answer: (request: PeerProofEnvelope) => Effect.Effect<PeerProofEnvelope, MissionPeerHandshakeError>;
  readonly complete: (nonce: string, response: PeerProofEnvelope) => Effect.Effect<HostTransportBinding, MissionPeerHandshakeError>;
}>()("t3/orchestration-v2/MissionPeerHandshake") {}

const digest = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex");
const issuer = (environmentId: string) => `t3-env:${environmentId}`;
const refused = (category: MissionPeerHandshakeError["category"]) =>
  new MissionPeerHandshakeError({ category });

/** No route, remote call, admission, or schema mutation happens during construction. */
export const layer = (config: PeerTrustConfig | null, signer: PeerSigner | null) => Layer.effect(
  MissionPeerHandshake,
  Effect.gen(function* () {
    const store = yield* Store.MissionPeerHandshakeStore;
    const runtime = yield* Facts.MissionPeerRuntimeFacts;
    const crypto = yield* Crypto.Crypto;
    const pin = config === null ? null : yield* Schema.decodeUnknownEffect(PeerTrustConfig)(
      { ...config }, { onExcessProperty: "error" },
    ).pipe(Effect.mapError(() => refused("invalid_config")));
    if (pin !== null) {
      yield* Effect.try({
        try: () => {
          const url = new URL(pin.receiverOrigin);
          if (url.protocol !== "https:" || url.origin !== pin.receiverOrigin ||
            url.username || url.password || pin.sourceHostId === pin.receiverHostId ||
            pin.sourceEnvironmentId === pin.receiverEnvironmentId ||
            createPublicKey(pin.sourcePublicKey).asymmetricKeyType !== "ed25519" ||
            createPublicKey(pin.receiverPublicKey).asymmetricKeyType !== "ed25519") {
            throw new Error("Invalid peer pins");
          }
        },
        catch: () => refused("invalid_config"),
      });
    }
    const scopeDigest = pin === null ? "" : digest(pin);
    const configured = () => pin === null || signer === null
      ? Effect.fail(refused("unconfigured"))
      : Effect.succeed({ pin, sign: signer });
    const verify = (proof: string, direction: "request" | "response", nowMs: number) => Effect.gen(function* () {
      const { pin } = yield* configured();
      const source = direction === "request";
      return yield* verifyRelayJwt({
        publicKey: source ? pin.sourcePublicKey : pin.receiverPublicKey,
        token: proof,
        typ: source ? REQUEST_TYP : RESPONSE_TYP,
        issuer: issuer(source ? pin.sourceEnvironmentId : pin.receiverEnvironmentId),
        audience: issuer(source ? pin.receiverEnvironmentId : pin.sourceEnvironmentId),
        nowEpochSeconds: Math.floor(nowMs / 1_000),
        maxTokenAge: 30,
      }).pipe(Effect.mapError(() => refused("invalid_proof")));
    });
    const fresh = (proof: typeof RequestProof.Type, nowMs: number) => {
      const issuedMs = proof.iat * 1_000;
      const expiresMs = proof.exp * 1_000;
      // Stricter than relay JWT's generic clock tolerance: no future or stale evidence.
      return Number.isSafeInteger(nowMs) && issuedMs <= nowMs && nowMs < expiresMs &&
        expiresMs > issuedMs && expiresMs - issuedMs <= LIFETIME_MS &&
        proof.scopeDigest === scopeDigest && proof.jti === proof.nonce;
    };
    const begin = Effect.gen(function* () {
      const { pin, sign } = yield* configured();
      const nowMs = yield* Clock.currentTimeMillis;
      const nonce = yield* crypto.randomUUIDv4;
      const iat = Math.floor(nowMs / 1_000);
      const payload = {
        iss: issuer(pin.sourceEnvironmentId), aud: issuer(pin.receiverEnvironmentId),
        sub: pin.sourceHostId, jti: nonce, iat, exp: iat + 30,
        version: 1, scopeDigest, nonce,
      };
      const proof = yield* sign({ typ: REQUEST_TYP, payload }).pipe(
        Effect.mapError(() => refused("signing")),
      );
      // A miswired key callback must fail before any remote request.
      yield* verify(proof, "request", nowMs);
      const inserted = yield* store.reserve({ scopeDigest, nonce, direction: "sender", nowMs, expiresAtMs: payload.exp * 1_000 }).pipe(
        Effect.mapError(() => refused("persistence")),
      );
      if (!inserted) return yield* refused("replay");
      return { nonce, origin: pin.receiverOrigin, request: { proof } };
    });
    const answer = Effect.fn("MissionPeerHandshake.answer")(function* (input: PeerProofEnvelope) {
      const { pin, sign } = yield* configured();
      const request = yield* Schema.decodeUnknownEffect(PeerProofEnvelope)(input, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() => refused("invalid_proof")),
      );
      const nowMs = yield* Clock.currentTimeMillis;
      const proof = yield* verify(request.proof, "request", nowMs).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(RequestProof)),
        Effect.mapError(() => refused("invalid_proof")),
      );
      if (!fresh(proof, nowMs) || proof.sub !== pin.sourceHostId) return yield* refused("expired");
      const attestation = yield* runtime.attest.pipe(Effect.mapError(() => refused("runtime_unavailable")));
      if (attestation.receiverEnvironmentId !== pin.receiverEnvironmentId ||
        attestation.buildSha256 !== pin.receiverBuildSha256) return yield* refused("runtime_unavailable");
      const inserted = yield* store.reserve({ scopeDigest, nonce: proof.nonce, direction: "receiver", nowMs, expiresAtMs: proof.exp * 1_000 }).pipe(
        Effect.mapError(() => refused("persistence")),
      );
      if (!inserted) return yield* refused("replay");
      const issuedMs = yield* Clock.currentTimeMillis;
      if (!fresh(proof, issuedMs)) return yield* refused("expired");
      const response = yield* sign({ typ: RESPONSE_TYP, payload: {
        iss: issuer(pin.receiverEnvironmentId), aud: issuer(pin.sourceEnvironmentId),
        sub: pin.receiverHostId, jti: proof.nonce, nonce: proof.nonce,
        iat: Math.floor(issuedMs / 1_000), exp: proof.exp,
        version: 1, scopeDigest, attestation,
      } }).pipe(Effect.mapError(() => refused("signing")));
      return { proof: response };
    });
    const complete = Effect.fn("MissionPeerHandshake.complete")(function* (nonce: string, input: PeerProofEnvelope) {
      const { pin } = yield* configured();
      const response = yield* Schema.decodeUnknownEffect(PeerProofEnvelope)(input, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() => refused("invalid_proof")),
      );
      const nowMs = yield* Clock.currentTimeMillis;
      const proof = yield* verify(response.proof, "response", nowMs).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ResponseProof)),
        Effect.mapError(() => refused("invalid_proof")),
      );
      if (!fresh(proof, nowMs) || proof.sub !== pin.receiverHostId || proof.nonce !== nonce ||
        proof.attestation.receiverEnvironmentId !== pin.receiverEnvironmentId ||
        proof.attestation.buildSha256 !== pin.receiverBuildSha256 ||
        proof.attestation.runtimeBuildId !== `sha256:${pin.receiverBuildSha256}`) {
        return yield* refused("invalid_proof");
      }
      // Use the source clock AFTER verification; consume before exposing a binding.
      const consumeAtMs = yield* Clock.currentTimeMillis;
      if (!fresh(proof, consumeAtMs)) return yield* refused("expired");
      const consumed = yield* store.consume({ scopeDigest, nonce, nowMs: consumeAtMs }).pipe(
        Effect.mapError(() => refused("persistence")),
      );
      if (!consumed) return yield* refused("replay");
      const observedAtMs = yield* Clock.currentTimeMillis;
      if (observedAtMs < consumeAtMs || !fresh(proof, observedAtMs)) return yield* refused("expired");
      return yield* Schema.decodeUnknownEffect(HostTransportBinding)({
        version: 1, kind: "host_transport_binding", authentication: "authenticated",
        teamId: pin.teamId, environmentId: pin.authorityEnvironmentId, company: pin.company,
        sourceHostId: pin.sourceHostId, receiverHostId: pin.receiverHostId,
        receiverBootId: proof.attestation.receiverBootId,
        runtimeBuildId: proof.attestation.runtimeBuildId,
        capabilityHash: digest(proof.attestation.capabilities),
        fencing: proof.attestation.capabilities.fencing,
        durableAck: proof.attestation.capabilities.durableAck,
        observedAtMs,
      }).pipe(Effect.mapError(() => refused("invalid_proof")));
    });
    return MissionPeerHandshake.of({ begin, answer, complete });
  }),
);

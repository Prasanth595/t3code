import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** Root installs this through the existing migrator; construction never runs DDL. */
export const MISSION_PEER_HANDSHAKE_DDL = `
CREATE TABLE mission_peer_handshake_nonces (
  scope_digest TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('sender', 'receiver')),
  nonce TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER,
  PRIMARY KEY (scope_digest, direction, nonce)
);`;

export class MissionPeerHandshakeStoreError extends Schema.TaggedError<MissionPeerHandshakeStoreError>()(
  "MissionPeerHandshakeStoreError", { cause: Schema.Defect() },
) {
  override get message() { return "Mission peer replay ledger unavailable."; }
}

interface NonceKey {
  readonly scopeDigest: string;
  readonly nonce: string;
}

/** Replay state only: never another mission, manager, claim, or artifact authority. */
export class MissionPeerHandshakeStore extends Context.Service<MissionPeerHandshakeStore, {
  readonly reserve: (input: NonceKey & {
    readonly direction: "sender" | "receiver";
    readonly nowMs: number;
    readonly expiresAtMs: number;
  }) => Effect.Effect<boolean, MissionPeerHandshakeStoreError>;
  readonly consume: (input: NonceKey & {
    readonly nowMs: number;
  }) => Effect.Effect<boolean, MissionPeerHandshakeStoreError>;
}>()("t3/orchestration-v2/MissionPeerHandshakeStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const reserve: MissionPeerHandshakeStore["Service"]["reserve"] = (input) => sql`
    INSERT INTO mission_peer_handshake_nonces
      (scope_digest, direction, nonce, created_at_ms, expires_at_ms, consumed_at_ms)
    VALUES (${input.scopeDigest}, ${input.direction}, ${input.nonce},
      ${input.nowMs}, ${input.expiresAtMs}, NULL)
    ON CONFLICT (scope_digest, direction, nonce) DO NOTHING
    RETURNING nonce
  `.pipe(
    Effect.map((rows) => rows.length === 1),
    Effect.mapError((cause) => new MissionPeerHandshakeStoreError({ cause })),
  );
  const consume: MissionPeerHandshakeStore["Service"]["consume"] = (input) => sql`
    UPDATE mission_peer_handshake_nonces SET consumed_at_ms = ${input.nowMs}
    WHERE scope_digest = ${input.scopeDigest} AND direction = 'sender'
      AND nonce = ${input.nonce} AND consumed_at_ms IS NULL
      AND created_at_ms <= ${input.nowMs} AND expires_at_ms > ${input.nowMs}
    RETURNING nonce
  `.pipe(
    Effect.map((rows) => rows.length === 1),
    Effect.mapError((cause) => new MissionPeerHandshakeStoreError({ cause })),
  );
  return MissionPeerHandshakeStore.of({ reserve, consume });
});

export const layer = Layer.effect(MissionPeerHandshakeStore, make);

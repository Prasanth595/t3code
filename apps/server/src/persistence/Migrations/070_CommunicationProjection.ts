import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE orchestration_v2_projection_communications (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      port TEXT NOT NULL,
      delivery_state TEXT NOT NULL,
      envelope_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_communications_inbox_idx
    ON orchestration_v2_projection_communications(thread_id, port, delivery_state, message_id)
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_projection_communications_immutable
    BEFORE UPDATE ON orchestration_v2_projection_communications
    WHEN old.thread_id IS NOT new.thread_id
      OR old.port IS NOT new.port
      OR json_remove(old.envelope_json, '$.delivery', '$.content', '$.providerEvidence')
        IS NOT json_remove(new.envelope_json, '$.delivery', '$.content', '$.providerEvidence')
    BEGIN
      SELECT RAISE(ABORT, 'communication provenance and route are immutable');
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_projection_communications_message_delete
    AFTER DELETE ON orchestration_v2_projection_messages
    BEGIN
      DELETE FROM orchestration_v2_projection_communications
      WHERE message_id = old.message_id;
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_projection_messages_communication_immutable
    BEFORE UPDATE OF payload_json ON orchestration_v2_projection_messages
    WHEN json_type(old.payload_json, '$.communication') = 'object'
      AND (
        json_type(new.payload_json, '$.communication') IS NOT 'object'
        OR json_remove(json_extract(old.payload_json, '$.communication'),
             '$.delivery', '$.content', '$.providerEvidence')
          IS NOT json_remove(json_extract(new.payload_json, '$.communication'),
             '$.delivery', '$.content', '$.providerEvidence')
      )
    BEGIN
      SELECT RAISE(ABORT, 'communication provenance and route are immutable');
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_projection_turn_items_communication_immutable
    BEFORE UPDATE OF payload_json ON orchestration_v2_projection_turn_items
    WHEN json_type(old.payload_json, '$.communication') = 'object'
      AND (
        json_type(new.payload_json, '$.communication') IS NOT 'object'
        OR json_remove(json_extract(old.payload_json, '$.communication'),
             '$.delivery', '$.content', '$.providerEvidence')
          IS NOT json_remove(json_extract(new.payload_json, '$.communication'),
             '$.delivery', '$.content', '$.providerEvidence')
      )
    BEGIN
      SELECT RAISE(ABORT, 'communication provenance and route are immutable');
    END
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_communications
      (message_id, thread_id, port, delivery_state, envelope_json)
    SELECT message_id,
           thread_id,
           json_extract(payload_json, '$.communication.route.port'),
           json_extract(payload_json, '$.communication.delivery.state'),
           json_extract(payload_json, '$.communication')
    FROM orchestration_v2_projection_messages
    WHERE json_type(payload_json, '$.communication') = 'object'
  `;
});

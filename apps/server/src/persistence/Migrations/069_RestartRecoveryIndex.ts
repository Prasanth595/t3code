import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_runs_recovery_active_idx
    ON orchestration_v2_projection_runs(status)
    WHERE status IN ('starting', 'running', 'waiting')
      AND json_extract(payload_json, '$.restartContinuationOfRunId') IS NOT NULL
  `;
});

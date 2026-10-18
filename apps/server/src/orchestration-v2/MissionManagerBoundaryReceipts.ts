import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Mission } from "@t3tools/contracts";
import * as Config from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Manager from "./MissionManagerRuntimeAdapter.ts";

// Short-lived, owner-produced observations of external integration/GUI/shell
// ownership. This file supplies evidence, never mission intent or authority.
// Absence, stale revision/epoch, or unknown ownership always holds rotation.
const Receipt = Schema.Struct({
  missionId: Schema.String,
  teamId: Schema.String,
  environmentId: Schema.String,
  role: Schema.Literals(["delivery", "retro"]),
  threadId: Schema.String,
  epoch: Schema.Number,
  revision: Schema.Number,
  observedAt: Schema.String,
  expiresAt: Schema.String,
  evidenceRef: Schema.String.check(Schema.isMinLength(1)),
  integrationRunning: Schema.NullOr(Schema.Boolean),
  guiOwned: Schema.NullOr(Schema.Boolean),
  unmanagedShellWrites: Schema.Literals(["none", "present", "unknown"]),
  sharedWrites: Schema.Literals(["none", "present", "unknown"]),
});
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Receipt)), {
  onExcessProperty: "error",
});
const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* Config.ServerConfig;
  const environmentId = yield* (yield* Environment.ServerEnvironment).getEnvironmentId;
  const sql = yield* SqlClient.SqlClient;
  const filename = path.join(config.stateDir, "nofun", "manager-boundaries.json");
  return Manager.MissionManagerBoundaryFacts.of({
    completionRoutingReady: () => Effect.succeed(true), // current-role wake consumer is registered alongside this producer
    quiesceBoundary: (request) =>
      Effect.gen(function* () {
        const info = yield* fs.stat(filename);
        const uid = process.getuid?.();
        if (
          info.type !== "File" ||
          (info.mode & 0o077) !== 0 ||
          Number(info.size) > 65536 ||
          (uid !== undefined && Option.isSome(info.uid) && info.uid.value !== uid)
        )
          return null;
        const receipts = yield* decode(yield* fs.readFileString(filename));
        const rows = yield* sql<{
          snapshot_json: string;
        }>`SELECT snapshot_json FROM projection_missions WHERE mission_id = ${request.missionId} AND authority_environment_id = ${environmentId}`;
        if (!rows[0]) return null;
        const mission = yield* decodeMission(rows[0].snapshot_json);
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const matches = receipts.filter(
          (r) =>
            r.missionId === mission.id &&
            r.teamId === mission.teamId &&
            r.environmentId === environmentId &&
            r.role === request.role &&
            r.threadId === request.incumbentThreadId &&
            r.epoch === request.incumbentEpoch &&
            r.revision === mission.revision &&
            Date.parse(r.observedAt) <= now &&
            now < Date.parse(r.expiresAt) &&
            Date.parse(r.expiresAt) - Date.parse(r.observedAt) <= 60000,
        );
        if (matches.length !== 1) return null;
        const receipt = matches[0]!;
        return {
          integrationRunning: receipt.integrationRunning,
          guiOwned: receipt.guiOwned,
          unmanagedShellWrites: receipt.unmanagedShellWrites,
          sharedWrites: receipt.sharedWrites,
          fence: null,
        };
      }).pipe(Effect.orElseSucceed(() => null)),
  });
});
export const layer = Layer.effect(Manager.MissionManagerBoundaryFacts, make);

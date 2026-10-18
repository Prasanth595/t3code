import { Mission, ProviderInstanceId } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import {
  ProPlanningApproval,
  ProPlanningCompletionReceipt,
  ProPlanningCount,
  ProPlanningId,
  ProPlanningLabel,
  ProPlanningScopeChangeApproval,
  ProPlanningSubmitVerification,
  ProPlanningUsageState,
} from "../../../../packages/contracts/src/missionProPlanning.ts";
import * as Config from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import { usageHeadroom } from "../mcp/usageHeadroom.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Planning from "./MissionPlanningStore.ts";
import { PRO_PLANNING_MAX_EVIDENCE_AGE_MS } from "./MissionProPlanning.ts";

/**
 * Written atomically by the local GUI owner after inspecting the actual account,
 * workspace, selected mode, allowance and response. MCP callers cannot supply
 * these observations. One event receipt is bound to the exact canonical revision
 * and delivery epoch; a previous GUI visit cannot authorize a later submit.
 * No prompt, answer, credential, or email is stored here, only verified pointers.
 * The operator pool is read independently from its actual Codex provider snapshot.
 */
const GuiObservation = Schema.Struct({
  version: Schema.Literal(1),
  missionId: ProPlanningId,
  teamId: ProPlanningId,
  environmentId: ProPlanningId,
  missionRevision: ProPlanningCount,
  managerThreadId: ProPlanningId,
  managerEpoch: ProPlanningCount,
  planningId: ProPlanningId,
  idempotencyKey: ProPlanningId,
  eventType: Schema.Literals([
    "prepare",
    "submit",
    "await_response",
    "wake",
    "retrieve",
    "reconcile",
    "block",
    "cancel",
  ]),
  operator: Schema.Struct({ instanceId: ProviderInstanceId, model: ProPlanningLabel }),
  observedAtMs: ProPlanningCount,
  responseAllowance: ProPlanningUsageState,
  planningApproval: Schema.optional(ProPlanningApproval),
  scopeChangeApproval: Schema.optional(ProPlanningScopeChangeApproval),
  verification: Schema.optional(ProPlanningSubmitVerification),
  completion: Schema.optional(ProPlanningCompletionReceipt),
});
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(GuiObservation)), {
  onExcessProperty: "error",
});
const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));
const MAX_BYTES = 64 * 1024;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* Config.ServerConfig;
  const environmentId = yield* (yield* Environment.ServerEnvironment).getEnvironmentId;
  const sql = yield* SqlClient.SqlClient;
  const providers = yield* Providers.ProviderRegistry;
  const filename = path.join(config.stateDir, "nofun", "planning-observations.json");
  const unavailable = () =>
    new Planning.MissionPlanningStoreError({ operation: "commit", category: "scope_denied" });

  return Planning.MissionPlanningFactsPort.of({
    readFacts: (request) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ snapshot_json: string }>`
          SELECT snapshot_json FROM projection_missions
          WHERE mission_id = ${request.missionId} AND authority_environment_id = ${environmentId}
        `;
        if (rows.length !== 1) return yield* unavailable();
        const mission = yield* decodeMission(rows[0]!.snapshot_json);
        const owner = mission.managers.delivery;
        if (owner?.threadId === undefined || owner.epoch === undefined) return yield* unavailable();
        const binding = {
          missionRevision: mission.revision,
          teamId: mission.teamId,
          environmentId,
          managerThreadId: owner.threadId,
          managerEpoch: owner.epoch,
        };
        // Cancelling requires only the canonical actor, not access to a browser
        // or its receipt file. It must still work when quota/GUI evidence is gone.
        if (request.eventType === "cancel")
          return {
            binding,
            observedAtMs: yield* Clock.currentTimeMillis,
            usage: { operatorBudget: "unknown", responseAllowance: "unknown" },
          };
        const info = yield* fs.stat(filename);
        const uid = process.getuid?.();
        const size = ByteSize.toBigInt(info.size);
        if (
          info.type !== "File" ||
          (info.mode & 0o077) !== 0 ||
          size <= 0n ||
          size > BigInt(MAX_BYTES) ||
          (uid !== undefined && Option.isSome(info.uid) && info.uid.value !== uid)
        )
          return yield* unavailable();
        // Bound the actual read as well as stat, including a growing/replaced file.
        const bytes = yield* fs.stream(filename, { bytesToRead: MAX_BYTES + 1 }).pipe(
          Stream.runFoldEffect(
            () => new Uint8Array(),
            (previous, chunk) => {
              if (previous.byteLength + chunk.byteLength > MAX_BYTES)
                return Effect.fail(unavailable());
              const next = new Uint8Array(previous.byteLength + chunk.byteLength);
              next.set(previous);
              next.set(chunk, previous.byteLength);
              return Effect.succeed(next);
            },
          ),
        );
        if (BigInt(bytes.byteLength) !== size) return yield* unavailable();
        const text = yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          catch: unavailable,
        });
        const observations = yield* decode(text);
        const matches = observations.filter(
          (r) =>
            r.missionId === mission.id &&
            r.teamId === mission.teamId &&
            r.environmentId === environmentId &&
            r.missionRevision === mission.revision &&
            r.managerThreadId === owner?.threadId &&
            r.managerEpoch === owner?.epoch &&
            r.planningId === request.planningId &&
            r.idempotencyKey === request.idempotencyKey &&
            r.eventType === request.eventType,
        );
        if (matches.length !== 1) return yield* unavailable();
        const receipt = matches[0]!;
        const now = yield* Clock.currentTimeMillis;
        const provider = (yield* providers.getProviders).find(
          (p) => p.instanceId === receipt.operator.instanceId && p.driver === "codex",
        );
        const headroom = usageHeadroom(provider?.usageLimits, now, {
          model: receipt.operator.model,
          maxObservationAgeMs: PRO_PLANNING_MAX_EVIDENCE_AGE_MS,
        }).headroom;
        return {
          binding: {
            missionRevision: receipt.missionRevision,
            teamId: receipt.teamId,
            environmentId: receipt.environmentId,
            managerThreadId: receipt.managerThreadId,
            managerEpoch: receipt.managerEpoch,
          },
          // Reading a receipt never renews the GUI evidence timestamp.
          observedAtMs: receipt.observedAtMs,
          usage: {
            operatorBudget:
              headroom === "ok" ? "available" : headroom === "exhausted" ? "exhausted" : "unknown",
            responseAllowance: receipt.responseAllowance,
          },
          ...(receipt.planningApproval === undefined
            ? {}
            : { planningApproval: receipt.planningApproval }),
          ...(receipt.scopeChangeApproval === undefined
            ? {}
            : { scopeChangeApproval: receipt.scopeChangeApproval }),
          ...(receipt.verification === undefined ? {} : { verification: receipt.verification }),
          ...(receipt.completion === undefined ? {} : { completion: receipt.completion }),
        };
      }).pipe(Effect.mapError(unavailable)),
  });
});

export const layer = Layer.effect(Planning.MissionPlanningFactsPort, make);

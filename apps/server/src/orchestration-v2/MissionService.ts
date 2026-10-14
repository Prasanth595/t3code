// @effect-diagnostics nodeBuiltinImport:off -- SHA-256 binds canonical command bytes to durable receipts.
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import {
  Mission,
  MissionCommand,
  MissionId,
  EventId,
  type TeamId,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as MissionCommands from "./MissionCommands.ts";

/** The authenticated runtime supplies this scope; request payloads cannot replace it. */
export class MissionAuthority extends Context.Service<
  MissionAuthority,
  {
    readonly teamId: TeamId;
    readonly environmentId: EnvironmentId;
    readonly controllerThreadId: ThreadId;
  }
>()("t3/orchestration-v2/MissionService/MissionAuthority") {}

export class MissionServiceError extends Schema.TaggedError<MissionServiceError>()(
  "MissionServiceError",
  {
    operation: Schema.Literals(["read", "commit"]),
    category: Schema.Literals(["scope_denied", "request_conflict", "persistence"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Mission ${this.operation} failed (${this.category}).`;
  }
}

export class MissionService extends Context.Service<
  MissionService,
  {
    readonly get: (id: MissionId) => Effect.Effect<Option.Option<Mission>, MissionServiceError>;
    readonly execute: (command: MissionCommand) => Effect.Effect<
      {
        readonly receipt: Receipts.OrchestrationCommandReceipt;
        readonly committed: boolean;
      },
      MissionServiceError | MissionCommands.MissionPlanError
    >;
  }
>()("t3/orchestration-v2/MissionService") {}

const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));
const encodeMission = Schema.encodeEffect(Schema.fromJsonString(Mission));
const encodeCommand = Schema.encodeEffect(MissionCommand);
const decodeRejection = Schema.decodeUnknownEffect(
  Schema.fromJsonString(MissionCommands.MissionPlanError),
);
const encodeRejection = Schema.encodeEffect(
  Schema.fromJsonString(MissionCommands.MissionPlanError),
);
const isServiceError = Schema.is(MissionServiceError);
const isPlanError = Schema.is(MissionCommands.MissionPlanError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authority = yield* MissionAuthority;
  const events = yield* EventStore.OrchestrationEventStore;
  const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;

  const read = Effect.fn("MissionService.get")(function* (id: MissionId) {
    // Check scope in SQL before decoding or returning any retained content.
    const rows = yield* sql<{ snapshot_json: string }>`
      SELECT snapshot_json FROM projection_missions
      WHERE mission_id = ${id} AND team_id = ${authority.teamId}
        AND authority_environment_id = ${authority.environmentId}
    `;
    return rows[0] === undefined
      ? Option.none()
      : Option.some(yield* decodeMission(rows[0].snapshot_json));
  });

  const execute = Effect.fn("MissionService.execute")(function* (command: MissionCommand) {
    if (
      command.mission.teamId !== authority.teamId ||
      command.mission.authorityEnvironmentId !== authority.environmentId
    ) {
      return yield* new MissionServiceError({ operation: "commit", category: "scope_denied" });
    }
    const encoded = yield* encodeCommand(command);
    const requestHash = NodeCrypto.createHash("sha256")
      .update(stableStringify(encoded))
      .digest("hex");
    const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    const outcome = yield* sql.withTransaction(
      Effect.gen(function* () {
        // Scope checks precede receipt lookups, including replay of completed work.
        const owner = yield* sql<{ team_id: string; authority_environment_id: string }>`
        SELECT team_id, authority_environment_id FROM projection_missions
        WHERE mission_id = ${command.mission.id}
      `;
        if (
          owner[0] !== undefined &&
          (owner[0].team_id !== authority.teamId ||
            owner[0].authority_environment_id !== authority.environmentId)
        ) {
          return yield* new MissionServiceError({ operation: "commit", category: "scope_denied" });
        }
        const current = yield* read(command.mission.id);
        const manager = Option.isSome(current)
          ? current.value.managers.delivery
          : command.mission.managers.delivery;
        if (manager?.threadId !== authority.controllerThreadId || manager.epoch === undefined) {
          return yield* new MissionServiceError({ operation: "commit", category: "scope_denied" });
        }
        const prior = yield* receipts.getByCommandId({ commandId: command.commandId });
        if (Option.isSome(prior)) {
          if (
            prior.value.aggregateKind !== "mission" ||
            prior.value.aggregateId !== command.mission.id ||
            prior.value.requestHash !== requestHash
          ) {
            return yield* new MissionServiceError({
              operation: "commit",
              category: "request_conflict",
            });
          }
          return prior.value.status === "rejected"
            ? Result.fail(yield* decodeRejection(prior.value.error))
            : Result.succeed({ receipt: prior.value, committed: false });
        }
        const planned = MissionCommands.planMissionCommand(command, Option.getOrNull(current), {
          sequence: 0,
          eventId: EventId.make(`mission:${command.commandId}`),
          occurredAt: now,
        });
        if (Result.isFailure(planned)) {
          const reserved = yield* receipts.insertIfAbsent({
            commandId: command.commandId,
            aggregateKind: "mission",
            aggregateId: command.mission.id,
            commandType: command.type,
            acceptedAt: now,
            resultSequence: 0,
            status: "rejected",
            error: yield* encodeRejection(planned.failure),
            requestHash,
          });
          if (!reserved)
            return yield* new MissionServiceError({
              operation: "commit",
              category: "request_conflict",
            });
          return Result.fail(planned.failure);
        }
        const event = yield* events.appendMissionEvent(planned.success.event);
        const snapshot = yield* encodeMission(planned.success.mission);
        yield* sql`
        INSERT INTO projection_missions (
          mission_id, team_id, authority_environment_id, revision, snapshot_json, updated_at
        ) VALUES (
          ${command.mission.id}, ${authority.teamId}, ${authority.environmentId},
          ${planned.success.mission.revision}, ${snapshot}, ${now}
        )
        ON CONFLICT(mission_id) DO UPDATE SET
          revision = excluded.revision, snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at
      `;
        const receipt: Receipts.OrchestrationCommandReceipt = {
          commandId: command.commandId,
          aggregateKind: "mission",
          aggregateId: command.mission.id,
          commandType: command.type,
          acceptedAt: now,
          resultSequence: event.sequence,
          status: "accepted",
          error: null,
          requestHash,
        };
        if (!(yield* receipts.insertIfAbsent(receipt))) {
          return yield* new MissionServiceError({
            operation: "commit",
            category: "request_conflict",
          });
        }
        return Result.succeed({ receipt, committed: true });
      }),
    );
    return yield* Result.isFailure(outcome)
      ? Effect.fail(outcome.failure)
      : Effect.succeed(outcome.success);
  });
  return MissionService.of({
    get: (id) =>
      read(id).pipe(
        Effect.mapError(
          (cause) => new MissionServiceError({ operation: "read", category: "persistence", cause }),
        ),
      ),
    execute: (command) =>
      execute(command).pipe(
        Effect.mapError((cause) =>
          isServiceError(cause) || isPlanError(cause)
            ? cause
            : new MissionServiceError({ operation: "commit", category: "persistence", cause }),
        ),
      ),
  });
});

export const layer = Layer.effect(MissionService, make);

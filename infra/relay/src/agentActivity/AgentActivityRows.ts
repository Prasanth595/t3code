import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { RelayAgentActivityState as RelayAgentActivityStateSchema } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Function from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { and, desc, eq, gte, inArray, isNull, lt, not, or, sql } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import { relayAgentActivityRows, relayEnvironmentLinks } from "../persistence/schema.ts";
import { TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS } from "./agentActivityAggregate.ts";
import {
  RUNNING_AGENT_ACTIVITY_ROW_TTL_MS,
  WAITING_AGENT_ACTIVITY_ROW_TTL_MS,
} from "./agentActivityPayloads.ts";

export class AgentActivityRowUpsertPersistenceError extends Schema.TaggedError<AgentActivityRowUpsertPersistenceError>()(
  "AgentActivityRowUpsertPersistenceError",
  {
    environmentId: Schema.String,
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist agent activity state for environment ${this.environmentId}, thread ${this.threadId}.`;
  }
}

export class AgentActivityRowDeletePersistenceError extends Schema.TaggedError<AgentActivityRowDeletePersistenceError>()(
  "AgentActivityRowDeletePersistenceError",
  {
    environmentId: Schema.String,
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to delete agent activity state for environment ${this.environmentId}, thread ${this.threadId}.`;
  }
}

export class AgentActivityRowPruneTerminalPersistenceError extends Schema.TaggedError<AgentActivityRowPruneTerminalPersistenceError>()(
  "AgentActivityRowPruneTerminalPersistenceError",
  {
    updatedBefore: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to prune terminal agent activity rows updated before ${this.updatedBefore}.`;
  }
}

export class AgentActivityRowListPersistenceError extends Schema.TaggedError<AgentActivityRowListPersistenceError>()(
  "AgentActivityRowListPersistenceError",
  {
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list agent activity state for user ${this.userId}.`;
  }
}

export class AgentActivityRows extends Context.Service<
  AgentActivityRows,
  {
    readonly upsert: (input: {
      readonly environmentPublicKey: string;
      readonly state: RelayAgentActivityState;
    }) => Effect.Effect<void, AgentActivityRowUpsertPersistenceError>;
    readonly pruneTerminal: (input: {
      readonly updatedBefore: string;
    }) => Effect.Effect<void, AgentActivityRowPruneTerminalPersistenceError>;
    readonly remove: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
      readonly threadId: string;
    }) => Effect.Effect<void, AgentActivityRowDeletePersistenceError>;
    readonly listForUser: (input: {
      readonly userId: string;
      /** Aggregate reads omit expired rows; identity rechecks leave this unset. */
      readonly visibleAt?: number;
    }) => Effect.Effect<
      ReadonlyArray<RelayAgentActivityState>,
      AgentActivityRowListPersistenceError
    >;
    readonly getForUserThread: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly threadId: string;
    }) => Effect.Effect<RelayAgentActivityState | null, AgentActivityRowListPersistenceError>;
  }
>()("t3code-relay/agentActivity/AgentActivityRows") {}

const decodeJsonString = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const encodeRelayAgentActivityStateJson = Schema.encodeEffect(
  Schema.fromJsonString(RelayAgentActivityStateSchema),
);

const decodeRelayAgentActivityState = Schema.decodeUnknownOption(RelayAgentActivityStateSchema);

// DateTime accepts rolled-over dates (e.g. September 31) as well as ISO strings.
// Filter only real UTC calendar dates, so lexical ordering cannot hide such rows.
const canonicalUtcTimestamp =
  "^([0-9]{4}-((0[13578]|1[02])-(0[1-9]|[12][0-9]|3[01])|" +
  "(0[469]|11)-(0[1-9]|[12][0-9]|30)|02-(0[1-9]|1[0-9]|2[0-8]))|" +
  "([0-9]{2}(0[48]|[2468][048]|[13579][26])|([02468][048]|[13579][26])00)-02-29)" +
  "T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$";

function visibleActivityRowsAt(visibleAt: number) {
  const cutoff = (ttlMs: number) => DateTime.formatIso(DateTime.makeUnsafe(visibleAt - ttlMs));
  const phase = sql`${relayAgentActivityRows.stateJson} ->> 'phase'`;
  // Canonical timestamps compare chronologically as strings. Leave legacy/offset
  // spellings to the aggregate's DateTime parser rather than hiding valid work.
  return or(
    not(sql`${relayAgentActivityRows.updatedAt} ~ ${canonicalUtcTimestamp}`),
    and(
      inArray(phase, ["running", "starting"]),
      gte(relayAgentActivityRows.updatedAt, cutoff(RUNNING_AGENT_ACTIVITY_ROW_TTL_MS)),
    ),
    and(
      inArray(phase, ["waiting_for_approval", "waiting_for_input", "stale"]),
      gte(relayAgentActivityRows.updatedAt, cutoff(WAITING_AGENT_ACTIVITY_ROW_TTL_MS)),
    ),
    and(
      inArray(phase, ["completed", "failed"]),
      gte(relayAgentActivityRows.updatedAt, cutoff(TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS)),
    ),
  );
}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return AgentActivityRows.of({
    upsert: Effect.fn("relay.agent_activity_rows.upsert")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.state.environmentId,
        "relay.thread_id": input.state.threadId,
      });
      const now = yield* DateTime.now;
      const stateJson = yield* encodeRelayAgentActivityStateJson(input.state).pipe(
        Effect.flatMap(decodeJsonString),
        Effect.map(Function.cast<unknown, RelayAgentActivityState>),
        Effect.mapError(
          (cause) =>
            new AgentActivityRowUpsertPersistenceError({
              environmentId: input.state.environmentId,
              threadId: input.state.threadId,
              cause,
            }),
        ),
      );
      yield* db
        .insert(relayAgentActivityRows)
        .values({
          environmentId: input.state.environmentId,
          environmentPublicKey: input.environmentPublicKey,
          threadId: input.state.threadId,
          stateJson,
          updatedAt: input.state.updatedAt,
          createdAt: DateTime.formatIso(now),
        })
        .onConflictDoUpdate({
          target: [
            relayAgentActivityRows.environmentId,
            relayAgentActivityRows.environmentPublicKey,
            relayAgentActivityRows.threadId,
          ],
          set: {
            stateJson,
            updatedAt: input.state.updatedAt,
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new AgentActivityRowUpsertPersistenceError({
                environmentId: input.state.environmentId,
                threadId: input.state.threadId,
                cause,
              }),
          ),
        );
    }),

    remove: Effect.fn("relay.agent_activity_rows.remove")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
        "relay.thread_id": input.threadId,
      });
      yield* db
        .delete(relayAgentActivityRows)
        .where(
          and(
            eq(relayAgentActivityRows.environmentId, input.environmentId),
            eq(relayAgentActivityRows.environmentPublicKey, input.environmentPublicKey),
            eq(relayAgentActivityRows.threadId, input.threadId),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new AgentActivityRowDeletePersistenceError({
                environmentId: input.environmentId,
                threadId: input.threadId,
                cause,
              }),
          ),
        );
    }),

    pruneTerminal: Effect.fn("relay.agent_activity_rows.prune_terminal")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.agent_activity_prune.before": input.updatedBefore,
      });
      yield* db
        .delete(relayAgentActivityRows)
        .where(
          and(
            sql`${relayAgentActivityRows.stateJson} ->> 'phase' IN ('completed', 'failed')`,
            lt(relayAgentActivityRows.updatedAt, input.updatedBefore),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new AgentActivityRowPruneTerminalPersistenceError({
                updatedBefore: input.updatedBefore,
                cause,
              }),
          ),
        );
    }),

    listForUser: Effect.fn("relay.agent_activity_rows.list_for_user")(function* (input) {
      return yield* db
        .select({ stateJson: relayAgentActivityRows.stateJson })
        .from(relayAgentActivityRows)
        .innerJoin(
          relayEnvironmentLinks,
          and(
            eq(relayEnvironmentLinks.environmentId, relayAgentActivityRows.environmentId),
            eq(
              relayEnvironmentLinks.environmentPublicKey,
              relayAgentActivityRows.environmentPublicKey,
            ),
          ),
        )
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            isNull(relayEnvironmentLinks.revokedAt),
            eq(relayEnvironmentLinks.liveActivitiesEnabled, true),
            input.visibleAt === undefined ? undefined : visibleActivityRowsAt(input.visibleAt),
          ),
        )
        .orderBy(desc(relayAgentActivityRows.updatedAt))
        .pipe(
          Effect.map((rows) =>
            rows.flatMap((row) => Option.toArray(decodeRelayAgentActivityState(row.stateJson))),
          ),
          Effect.mapError(
            (cause) =>
              new AgentActivityRowListPersistenceError({
                userId: input.userId,
                cause,
              }),
          ),
        );
    }),

    getForUserThread: Effect.fn("relay.agent_activity_rows.get_for_user_thread")(function* (input) {
      return yield* db
        .select({ stateJson: relayAgentActivityRows.stateJson })
        .from(relayAgentActivityRows)
        .innerJoin(
          relayEnvironmentLinks,
          and(
            eq(relayEnvironmentLinks.environmentId, relayAgentActivityRows.environmentId),
            eq(
              relayEnvironmentLinks.environmentPublicKey,
              relayAgentActivityRows.environmentPublicKey,
            ),
          ),
        )
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            isNull(relayEnvironmentLinks.revokedAt),
            eq(relayAgentActivityRows.environmentId, input.environmentId),
            eq(relayAgentActivityRows.threadId, input.threadId),
          ),
        )
        .orderBy(desc(relayAgentActivityRows.updatedAt))
        .pipe(
          Effect.map((rows) => {
            for (const row of rows) {
              const decoded = decodeRelayAgentActivityState(row.stateJson);
              if (Option.isSome(decoded)) {
                return decoded.value;
              }
            }
            return null;
          }),
          Effect.mapError(
            (cause) =>
              new AgentActivityRowListPersistenceError({
                userId: input.userId,
                cause,
              }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(AgentActivityRows, make);

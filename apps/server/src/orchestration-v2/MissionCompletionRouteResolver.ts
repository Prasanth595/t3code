// Private SQL-backed canonical completion reference producer (source-only).
//
// Derives the full bounded CompletionReference from the ACTUAL persisted
// canonical row instead of trusting caller-crafted proof fields, then invokes
// the accepted pure `resolveCompletionRoute`. Returns ONLY a candidate or a
// finite hold. This port is ROOT-INTERNAL current-role proof, not public
// caller claims: no wake, admission activation, event/CAS/receipt/outbox
// writes, or schema changes. A future MCP/runtime policy producer remains
// unimplemented; this module documents source-only reads and grants nothing.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { Mission } from "../../../../packages/contracts/src/mission.ts";
import { MissionResultRecord } from "../../../../packages/contracts/src/missionResult.ts";
import { MissionRetroReportReceipt } from "../../../../packages/contracts/src/missionRetroReportReceipt.ts";
import {
  isCompletionCandidateCurrent,
  resolveCompletionRoute,
  type CompletionReference,
  type CompletionRouteDecision,
  type CompletionScope,
} from "./MissionCompletionRouting.ts";
import { isHandoffSafeId } from "./MissionManagerHandoff.ts";
import { MissionManagerReservationAuthority } from "./MissionManagerTransferStore.ts";

export class MissionCompletionRouteResolverError extends Schema.TaggedError<MissionCompletionRouteResolverError>()(
  "MissionCompletionRouteResolverError",
  {
    operation: Schema.Literals(["resolve"]),
    category: Schema.Literals(["scope_denied", "request_conflict", "persistence"]),
  },
) {
  override get message() {
    return "Mission completion reference failed.";
  }
}

/** Strict detached bounded metadata selector: key only, never proof. */
export type CompletionSelector =
  | {
      readonly kind: "task-result";
      readonly missionId: string;
      readonly taskId: string;
      readonly attemptNumber: number;
      readonly resultRevision: number;
    }
  | {
      readonly kind: "retro-report";
      readonly missionId: string;
      readonly checkpointId: string;
      readonly reportRevision: number;
    };

export class MissionCompletionRouteResolver extends Context.Service<
  MissionCompletionRouteResolver,
  {
    readonly resolve: (
      selector: unknown,
    ) => Effect.Effect<CompletionRouteDecision, MissionCompletionRouteResolverError>;
  }
>()("t3/orchestration-v2/MissionCompletionRouteResolver") {}

const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));
const isResultRecord = Schema.is(MissionResultRecord);
const isReceipt = Schema.is(MissionRetroReportReceipt);
const isResolverError = Schema.is(MissionCompletionRouteResolverError);

const TASK_SELECTOR_KEYS = ["kind", "missionId", "taskId", "attemptNumber", "resultRevision"] as const;
const RETRO_SELECTOR_KEYS = ["kind", "missionId", "checkpointId", "reportRevision"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
};
const isCounter = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const freezeDecision = (decision: CompletionRouteDecision): CompletionRouteDecision => {
  if (decision.kind === "candidate") {
    Object.freeze(decision.candidate.source);
    Object.freeze(decision.candidate.scope);
    Object.freeze(decision.candidate);
  }
  return Object.freeze(decision);
};
const localHold = (
  missionId: string,
  reason: "unknown_completion" | "ambiguous_completion" | "source_mismatch",
  detail: string,
): CompletionRouteDecision =>
  freezeDecision({ kind: "hold", missionId, reason, detail });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Required private port with no default producer: a missing port denies
  // every resolution instead of manufacturing scope.
  const authorityOption = yield* Effect.serviceOption(MissionManagerReservationAuthority);

  // Capture the private authority tuple ONCE at the layer boundary. Only
  // detached strings are kept, so later mutation of the producer object can
  // never retarget the actual scope. The synchronous currency check stays a
  // live pure callback reference (no I/O inside).
  const captured = Option.isSome(authorityOption)
    ? Object.freeze({
        teamId: authorityOption.value.teamId,
        environmentId: authorityOption.value.environmentId,
        controllerThreadId: authorityOption.value.controllerThreadId,
        role: authorityOption.value.role,
      })
    : null;
  const currentIssuer = Option.isSome(authorityOption) ? authorityOption.value.isCurrent : undefined;
  const authorityIsCurrent = (): boolean => {
    try {
      return typeof currentIssuer === "function" && currentIssuer() === true;
    } catch {
      return false;
    }
  };

  const scopeDenied = (): MissionCompletionRouteResolverError =>
    new MissionCompletionRouteResolverError({ operation: "resolve", category: "scope_denied" });
  const requestConflict = (): MissionCompletionRouteResolverError =>
    new MissionCompletionRouteResolverError({ operation: "resolve", category: "request_conflict" });
  const toResolverError = (cause: unknown): MissionCompletionRouteResolverError =>
    isResolverError(cause)
      ? cause
      : new MissionCompletionRouteResolverError({ operation: "resolve", category: "persistence" });

  const resolve = Effect.fn("MissionCompletionRouteResolver.resolve")(function* (
    rawSelector: unknown,
  ): Effect.fn.Return<CompletionRouteDecision, MissionCompletionRouteResolverError> {
    // Detach exactly once; clone-unsafe input is a finite error, never a defect.
    let detached: unknown;
    try {
      detached = structuredClone(rawSelector);
    } catch {
      return yield* Effect.fail(requestConflict());
    }
    // Strict bounded selector validation BEFORE any private SQL: no caller
    // team/env/thread/epoch/role/provenance/lease/hashes/body accepted.
    let selector: CompletionSelector;
    if (!isRecord(detached) || typeof detached.kind !== "string") {
      return yield* Effect.fail(requestConflict());
    }
    if (detached.kind === "task-result") {
      if (
        !exactKeys(detached, TASK_SELECTOR_KEYS) ||
        !isHandoffSafeId(detached.missionId) ||
        !isHandoffSafeId(detached.taskId) ||
        !isCounter(detached.attemptNumber) ||
        !isCounter(detached.resultRevision)
      ) {
        return yield* Effect.fail(requestConflict());
      }
      selector = {
        kind: "task-result",
        missionId: detached.missionId as string,
        taskId: detached.taskId as string,
        attemptNumber: detached.attemptNumber as number,
        resultRevision: detached.resultRevision as number,
      };
    } else if (detached.kind === "retro-report") {
      if (
        !exactKeys(detached, RETRO_SELECTOR_KEYS) ||
        !isHandoffSafeId(detached.missionId) ||
        !isHandoffSafeId(detached.checkpointId) ||
        !isCounter(detached.reportRevision) ||
        (detached.reportRevision as number) <= 0
      ) {
        return yield* Effect.fail(requestConflict());
      }
      selector = {
        kind: "retro-report",
        missionId: detached.missionId as string,
        checkpointId: detached.checkpointId as string,
        reportRevision: detached.reportRevision as number,
      };
    } else {
      return yield* Effect.fail(requestConflict());
    }

    if (captured === null || !authorityIsCurrent()) return yield* Effect.fail(scopeDenied());
    // Role is derived from the selector kind and must match the private port
    // role, even when one controller thread holds both canonical roles.
    const role = selector.kind === "task-result" ? "delivery" : "retro";
    if (role !== captured.role) return yield* Effect.fail(scopeDenied());
    // Never join a foreign ambient transaction; only the owning read below.
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
      return yield* Effect.fail(new MissionCompletionRouteResolverError({
        operation: "resolve",
        category: "persistence",
      }));
    }
    const authority = captured;

    const decision = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (!authorityIsCurrent()) return yield* Effect.fail(scopeDenied());
          const rows = yield* sql<{
            mission_id: string;
            team_id: string;
            authority_environment_id: string;
            revision: number;
            snapshot_json: string;
          }>`SELECT mission_id, team_id, authority_environment_id, revision, snapshot_json FROM projection_missions WHERE mission_id = ${selector.missionId} AND team_id = ${authority.teamId} AND authority_environment_id = ${authority.environmentId}`;
          if (!authorityIsCurrent()) return yield* Effect.fail(scopeDenied());
          if (rows[0] === undefined) return yield* Effect.fail(scopeDenied());
          const row = rows[0];
          const mission = yield* decodeMission(row.snapshot_json).pipe(
            Effect.mapError(() => new MissionCompletionRouteResolverError({ operation: "resolve", category: "persistence" })),
          );
          if (!authorityIsCurrent()) return yield* Effect.fail(scopeDenied());
          // Projection revision and canonical identity must agree exactly;
          // drift or foreign private bindings fail closed.
          if (
            mission.id !== row.mission_id ||
            mission.id !== selector.missionId ||
            mission.revision !== row.revision ||
            mission.teamId !== row.team_id ||
            mission.teamId !== authority.teamId ||
            mission.authorityEnvironmentId !== row.authority_environment_id ||
            mission.authorityEnvironmentId !== authority.environmentId
          ) {
            return yield* Effect.fail(scopeDenied());
          }
          // The current canonical manager of the derived role must exactly
          // match the private controller thread with a known safe epoch
          // before ANY reference is returned.
          const assignment =
            role === "delivery" ? mission.managers.delivery : mission.managers.retro;
          if (
            assignment === undefined ||
            assignment.threadId !== authority.controllerThreadId ||
            !isCounter(assignment.epoch)
          ) {
            return yield* Effect.fail(scopeDenied());
          }
          // Find the exact unique persisted key; missing/duplicate keys hold
          // finitely with no highest/latest/parent fallback.
          let completion: CompletionReference | null = null;
          if (selector.kind === "task-result") {
            const keyed = (mission.execution?.results ?? []).filter(
              (entry) => entry.taskId === selector.taskId && entry.attemptNumber === selector.attemptNumber,
            );
            if (keyed.length === 0) {
              const hold = localHold(selector.missionId, "unknown_completion", "No persisted task-result record matches the selector.");
              if (!authorityIsCurrent()) return yield* Effect.fail(scopeDenied());
              return hold;
            }
            const firstResult = keyed[0];
            if (keyed.length > 1 || firstResult === undefined || !isResultRecord(firstResult)) {
              const hold = localHold(selector.missionId, "ambiguous_completion", "Duplicate persisted task-result records match; refusing to choose.");
              if (!authorityIsCurrent()) return yield* Effect.fail(scopeDenied());
              return hold;
            }
            const record = firstResult;
            const prov: Record<string, unknown> = record.provenance as unknown as Record<string, unknown>;
            if (
              !isRecord(prov) ||
              prov.resultRevision !== selector.resultRevision ||
              typeof prov.childTaskId !== "string" ||
              typeof prov.childThreadId !== "string" ||
              typeof prov.childRunId !== "string"
            ) {
              const hold = localHold(selector.missionId, "source_mismatch", "Task-result revision or producing run drifted from the persisted record.");
              if (!authorityIsCurrent()) return yield* Effect.fail(scopeDenied());
              return hold;
            }
            completion = {
              kind: "task-result",
              taskId: selector.taskId,
              attemptNumber: selector.attemptNumber,
              resultRevision: selector.resultRevision,
              childTaskId: prov.childTaskId,
              childThreadId: prov.childThreadId,
              childRunId: prov.childRunId,
            };
          } else {
            const receipts = mission.execution?.retroReportReceipts ?? [];
            const keyed = receipts.filter(
              (entry) => entry.checkpointId === selector.checkpointId && entry.reportRevision === selector.reportRevision,
            );
            if (keyed.length === 0) {
              const hold = localHold(selector.missionId, "unknown_completion", "No persisted retro-report receipt matches the selector.");
              if (!authorityIsCurrent()) return yield* Effect.fail(scopeDenied());
              return hold;
            }
            const firstReceipt = keyed[0];
            if (keyed.length > 1 || firstReceipt === undefined || !isReceipt(firstReceipt)) {
              const hold = localHold(selector.missionId, "ambiguous_completion", "Duplicate persisted retro-report receipts match; refusing to choose.");
              if (!authorityIsCurrent()) return yield* Effect.fail(scopeDenied());
              return hold;
            }
            const receipt = firstReceipt;
            completion = {
              kind: "retro-report",
              checkpointId: selector.checkpointId,
              teamId: receipt.teamId,
              environmentId: receipt.environmentId,
              missionId: receipt.missionId,
              sourceThreadId: receipt.sourceThreadId,
              sourceRoot: receipt.sourceRoot,
              snapshotFingerprint: receipt.snapshotFingerprint,
              coveredFromInclusive: receipt.coveredFromInclusive,
              coveredToExclusive: receipt.coveredToExclusive,
              normalizedReportHash: receipt.normalizedReportHash,
              sourceReportHash: receipt.sourceReportHash,
              reportRevision: selector.reportRevision,
              reporterChildThreadId: receipt.reporterChildThreadId,
              reporterRunId: receipt.reporterRunId,
            };
          }
          // Freeze/detach the bounded scope and derived reference, then run
          // the accepted pure resolver: it revalidates the full
          // task/project/admission or checkpoint/analysis/lease tuple.
          const scope: CompletionScope = Object.freeze({
            teamId: authority.teamId,
            environmentId: authority.environmentId,
            missionId: selector.missionId,
          });
          const frozenCompletion = Object.freeze(completion) as CompletionReference;
          if (!authorityIsCurrent()) return yield* Effect.fail(scopeDenied());
          const first = resolveCompletionRoute({ mission, scope, completion: frozenCompletion });
          if (!authorityIsCurrent()) return yield* Effect.fail(scopeDenied());
          if (first.kind === "hold") return first;
          // Stable rederivation plus currentness at the owning transaction
          // boundary: policy revocation, scope drift, or binding loss denies.
          const second = resolveCompletionRoute({ mission, scope, completion: frozenCompletion });
          if (
            second.kind !== "candidate" ||
            stableStringify(second.candidate) !== stableStringify(first.candidate) ||
            !isCompletionCandidateCurrent(mission, first.candidate)
          ) {
            return yield* Effect.fail(scopeDenied());
          }
          if (!authorityIsCurrent()) return yield* Effect.fail(scopeDenied());
          return first;
        }),
      )
      .pipe(Effect.mapError(toResolverError));
    // After-return guard: revocation across the transaction boundary denies,
    // even for an already-derived hold. A returned candidate is still not
    // live authority: no wake, routing-ready flag, or pointer availability.
    if (!authorityIsCurrent()) return yield* Effect.fail(scopeDenied());
    return decision;
  });

  return MissionCompletionRouteResolver.of({ resolve: (selector) => resolve(selector).pipe(Effect.mapError(toResolverError)) });
});

export const layer = Layer.effect(MissionCompletionRouteResolver, make);

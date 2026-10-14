// Private SQL-backed canonical completion reference producer (source-only).
//
// Derives the full bounded CompletionReference from the ACTUAL persisted
// canonical row instead of trusting caller-crafted proof fields, then invokes
// the accepted pure `resolveCompletionRoute`. Returns ONLY a candidate or a
// finite hold. This port is ROOT-INTERNAL current-role proof, not public
// caller claims: no wake, admission activation, event/CAS/receipt/outbox
// writes, or schema changes. Two authority modes share every read fence: the
// original required private role callback, and a genuine opaque
// MissionAuthority transaction guard supplied per invocation by the
// completion MCP consumer. The opaque mode never falls back to the private
// callback and never manufactures currency.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { Mission, MissionId } from "../../../../packages/contracts/src/mission.ts";
import {
  decodeMissionCompletionSelector,
  type MissionCompletionSelector,
} from "../../../../packages/contracts/src/missionCompletion.ts";
import { MissionResultRecord } from "../../../../packages/contracts/src/missionResult.ts";
import { MissionRetroReportReceipt } from "../../../../packages/contracts/src/missionRetroReportReceipt.ts";
import {
  isCompletionCandidateCurrent,
  resolveCompletionRoute,
  type CompletionReference,
  type CompletionRouteDecision,
  type CompletionScope,
} from "./MissionCompletionRouting.ts";
import { MissionManagerReservationAuthority } from "./MissionManagerTransferStore.ts";
import * as MissionService from "./MissionService.ts";

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

/**
 * Strict detached bounded metadata selector: key only, never proof.
 * Shared leaf canonical shape; the strict decode below preserves the exact
 * accept set of the previous inline validator (exact keys, compact ASCII
 * ids, safe-integer counters, positive retro revisions).
 */
export type CompletionSelector = MissionCompletionSelector;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

  // Genuine opaque MCP authority context: selected whenever a
  // MissionAuthority context is supplied, including a missing handle. The tuple, handle,
  // and request key are captured ONCE here so later mutation of the provided
  // record cannot retarget the check. While active, the private callback
  // above is never consulted, even if one is also supplied: a missing,
  // forged, or foreign handle denies instead of falling back.
  const opaqueOption = yield* Effect.serviceOption(MissionService.MissionAuthority);
  const opaque = Option.isSome(opaqueOption)
    ? {
        teamId: opaqueOption.value.teamId,
        environmentId: opaqueOption.value.environmentId,
        controllerThreadId: opaqueOption.value.controllerThreadId,
        transactionGuard: opaqueOption.value.transactionGuard,
        requestKey: opaqueOption.value.requestKey,
      }
    : null;

  const scopeDenied = (): MissionCompletionRouteResolverError =>
    new MissionCompletionRouteResolverError({ operation: "resolve", category: "scope_denied" });
  const requestConflict = (): MissionCompletionRouteResolverError =>
    new MissionCompletionRouteResolverError({ operation: "resolve", category: "request_conflict" });
  const toResolverError = (cause: unknown): MissionCompletionRouteResolverError =>
    isResolverError(cause)
      ? cause
      : new MissionCompletionRouteResolverError({ operation: "resolve", category: "persistence" });

  // Read-only handle request over the exact decoded selector: the guard binds
  // every actual selector byte, the owning SQL client, and the captured
  // handle/key. No expectedMission is ever supplied, so a spoof cannot bless
  // changed state.
  const guardRequestFor = (
    selector: CompletionSelector,
  ): MissionService.MissionTransactionRequest => ({
    operation: "completion-route-read",
    missionId: MissionId.make(selector.missionId),
    command: selector,
  });

  // Effect-based currency fence at every existing check site. The genuine
  // opaque guard runs when an MCP handle was supplied; otherwise the
  // original private callback decides. No manufactured default issuer.
  const assertCurrent = (
    selector: CompletionSelector,
  ): Effect.Effect<void, MissionCompletionRouteResolverError> => {
    if (opaque === null) {
      return authorityIsCurrent() ? Effect.void : Effect.fail(scopeDenied());
    }
    return MissionService.MissionTransactionGuard.check({
      sql,
      authority: {
        teamId: opaque.teamId,
        environmentId: opaque.environmentId,
        controllerThreadId: opaque.controllerThreadId,
        transactionGuard: opaque.transactionGuard,
        requestKey: opaque.requestKey,
      },
      request: guardRequestFor(selector),
    }).pipe(Effect.mapError(() => scopeDenied()));
  };

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
    // Shared leaf decode with excess properties rejected; the detached clone
    // above is the only input so caller mutation cannot retarget the check.
    const selector: CompletionSelector = yield* decodeMissionCompletionSelector(detached).pipe(
      Effect.mapError(() => requestConflict()),
    );

    // Role is derived from the selector kind, never from a caller claim.
    const role = selector.kind === "task-result" ? "delivery" : "retro";
    if (opaque !== null) {
      // Genuine opaque path: the guard binds this exact selector before any
      // private SQL. The private callback is never consulted here, even if
      // one is also supplied.
      yield* assertCurrent(selector);
    } else {
      if (captured === null || !authorityIsCurrent()) return yield* Effect.fail(scopeDenied());
      // The derived role must match the private port role, even when one
      // controller thread holds both canonical roles.
      if (role !== captured.role) return yield* Effect.fail(scopeDenied());
    }
    // Never join a foreign ambient transaction; only the owning read below.
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
      return yield* Effect.fail(new MissionCompletionRouteResolverError({
        operation: "resolve",
        category: "persistence",
      }));
    }
    const authority = opaque ?? captured;
    if (authority === null) return yield* Effect.fail(scopeDenied());

    const decision = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* assertCurrent(selector);
          const rows = yield* sql<{
            mission_id: string;
            team_id: string;
            authority_environment_id: string;
            revision: number;
            snapshot_json: string;
          }>`SELECT mission_id, team_id, authority_environment_id, revision, snapshot_json FROM projection_missions WHERE mission_id = ${selector.missionId} AND team_id = ${authority.teamId} AND authority_environment_id = ${authority.environmentId}`;
          yield* assertCurrent(selector);
          if (rows[0] === undefined) return yield* Effect.fail(scopeDenied());
          const row = rows[0];
          const mission = yield* decodeMission(row.snapshot_json).pipe(
            Effect.mapError(() => new MissionCompletionRouteResolverError({ operation: "resolve", category: "persistence" })),
          );
          yield* assertCurrent(selector);
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
              yield* assertCurrent(selector);
              return hold;
            }
            const firstResult = keyed[0];
            if (keyed.length > 1 || firstResult === undefined || !isResultRecord(firstResult)) {
              const hold = localHold(selector.missionId, "ambiguous_completion", "Duplicate persisted task-result records match; refusing to choose.");
              yield* assertCurrent(selector);
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
              yield* assertCurrent(selector);
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
              yield* assertCurrent(selector);
              return hold;
            }
            const firstReceipt = keyed[0];
            if (keyed.length > 1 || firstReceipt === undefined || !isReceipt(firstReceipt)) {
              const hold = localHold(selector.missionId, "ambiguous_completion", "Duplicate persisted retro-report receipts match; refusing to choose.");
              yield* assertCurrent(selector);
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
          yield* assertCurrent(selector);
          const first = resolveCompletionRoute({ mission, scope, completion: frozenCompletion });
          yield* assertCurrent(selector);
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
          yield* assertCurrent(selector);
          return first;
        }),
      )
      .pipe(Effect.mapError(toResolverError));
    // After-return guard: revocation across the transaction boundary denies,
    // even for an already-derived hold. A returned candidate is still not
    // live authority: no wake, routing-ready flag, or pointer availability.
    yield* assertCurrent(selector);
    return decision;
  });

  return MissionCompletionRouteResolver.of({ resolve: (selector) => resolve(selector).pipe(Effect.mapError(toResolverError)) });
});

export const layer = Layer.effect(MissionCompletionRouteResolver, make);

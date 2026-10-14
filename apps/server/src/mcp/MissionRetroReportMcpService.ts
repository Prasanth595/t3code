// @effect-diagnostics nodeBuiltinImport:off -- validate private root configuration without filesystem I/O.
import * as NodePath from "node:path";
import { MissionId } from "../../../../packages/contracts/src/mission.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as MissionService from "../orchestration-v2/MissionService.ts";
import * as Artifacts from "../orchestration-v2/MissionRetroReportArtifacts.ts";
import * as Resolver from "../orchestration-v2/MissionRetroReportSourceResolver.ts";
import * as Store from "../orchestration-v2/MissionRetroReportStore.ts";
import type { MissionRetroReportReconciliationError } from "../orchestration-v2/MissionRetroReportReconciliation.ts";
import type * as Invocation from "./McpInvocationContext.ts";
import * as MissionMcp from "./MissionMcpService.ts";

/** Pointer metadata only: private receipt records contain assignment tokens. */
export interface MissionRetroReportMcpOutcome {
  readonly missionId: string;
  readonly checkpointId: string;
  readonly commandId: string;
  readonly committed: boolean;
  readonly recovered: boolean;
  readonly eventSequence: number;
  readonly disposition: Store.MissionRetroReportOutcome["disposition"];
  readonly verdict: Store.MissionRetroReportOutcome["verdict"];
  readonly sourceReportHash: string;
  readonly normalizedReportHash: string;
  readonly normalizedArtifactRef: string;
}

export type MissionRetroReportMcpResult = Result.Result<
  MissionRetroReportMcpOutcome,
  | {
      readonly category: "report_rejected";
      readonly code: Store.MissionRetroReportRejection["code"];
    }
  | {
      readonly category: "reconciliation_rejected";
      readonly code: MissionRetroReportReconciliationError["category"];
    }
>;

export class MissionRetroReportMcpService extends Context.Service<
  MissionRetroReportMcpService,
  {
    readonly receive: (
      actualScope: Invocation.McpInvocationScope,
      unknownCommand: unknown,
    ) => Effect.Effect<MissionRetroReportMcpResult, MissionMcp.MissionMcpFailure>;
  }
>()("t3/mcp/MissionRetroReportMcpService") {}

const decodeCommand = Schema.decodeUnknownSync(Store.MissionRetroReportReceiveCommand, {
  onExcessProperty: "error",
});
const denied = () =>
  new MissionMcp.MissionMcpFailure({
    code: "scope_denied",
    message: "The current retro manager is not authorized to receive this report.",
  });
const unavailable = () =>
  new MissionMcp.MissionMcpFailure({
    code: "unavailable",
    message: "Retro report storage is unavailable.",
  });
const mapStoreError = (error: Store.MissionRetroReportStoreError) => {
  switch (error.category) {
    case "scope_denied":
      return denied();
    case "request_conflict":
      return new MissionMcp.MissionMcpFailure({
        code: "request_conflict",
        message: "The report command conflicts with current mission state.",
      });
    default:
      return unavailable();
  }
};

const make = (artifactDirectory: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const events = yield* Events.OrchestrationEventStore;
    const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
    const authorityPort = yield* Effect.serviceOption(MissionMcp.MissionMcpAuthorityPort);
    const receive = Effect.fn("MissionRetroReportMcpService.receive")(function* (
      actualScope: Invocation.McpInvocationScope,
      unknownCommand: unknown,
    ): Effect.fn.Return<MissionRetroReportMcpResult, MissionMcp.MissionMcpFailure> {
      const scope = {
        ...actualScope,
        thread: actualScope.thread === undefined ? undefined : { ...actualScope.thread },
        client: actualScope.client === undefined ? undefined : { ...actualScope.client },
        capabilities: new Set(actualScope.capabilities),
      };
      const command = yield* Effect.try({
        try: () => decodeCommand(structuredClone(unknownCommand)),
        catch: () =>
          new MissionMcp.MissionMcpFailure({
            code: "invalid_request",
            message: "The report receive command did not match the expected shape.",
          }),
      });
      if (!scope.capabilities.has("orchestration"))
        return yield* new MissionMcp.MissionMcpFailure({
          code: "capability_denied",
          message: "This credential cannot receive retro reports.",
        });
      if (scope.thread === undefined || scope.client !== undefined)
        return yield* new MissionMcp.MissionMcpFailure({
          code: "thread_credential_required",
          message: "Report receive requires an authenticated T3 thread credential.",
        });
      if (Option.isNone(authorityPort))
        return yield* new MissionMcp.MissionMcpFailure({
          code: "authority_unavailable",
          message: "A current report authority resolver is required.",
        });
      const requestKey = {};
      const request = {
        operation: "retro-report-receive" as const,
        missionId: MissionId.make(command.missionId),
        command,
      };
      const facts = yield* authorityPort.value
        .resolve({ ...request, scope: { ...scope, thread: scope.thread }, requestKey })
        .pipe(
          Effect.mapError(
            (error) =>
              new MissionMcp.MissionMcpFailure({
                code: error.code,
                message: "The report authority resolver denied the request.",
              }),
          ),
        );
      if (
        facts.company !== "nofun" ||
        facts.companyVerified !== true ||
        facts.bindingVerified !== true ||
        facts.environmentId !== scope.environmentId ||
        facts.controllerThreadId !== scope.thread.threadId ||
        facts.transactionGuard === undefined
      )
        return yield* denied();
      const authority = {
        teamId: facts.teamId,
        environmentId: facts.environmentId,
        controllerThreadId: facts.controllerThreadId,
        transactionGuard: facts.transactionGuard,
        requestKey,
      };
      // Facts or copied handles cannot authorize even the first private artifact read.
      yield* MissionService.MissionTransactionGuard.check({ sql, authority, request }).pipe(
        Effect.mapError(denied),
      );
      if (typeof artifactDirectory !== "string" || !NodePath.isAbsolute(artifactDirectory))
        return yield* unavailable();
      const base = Layer.mergeAll(
        Layer.succeed(SqlClient.SqlClient, sql),
        Layer.succeed(Events.OrchestrationEventStore, events),
        Layer.succeed(Receipts.OrchestrationCommandReceiptRepository, receipts),
        Layer.succeed(MissionService.MissionAuthority, authority),
      );
      const resolver = Resolver.layerMissionRetroReportSourceResolver({ artifactDirectory }).pipe(
        Layer.provide(base),
      );
      const artifacts = Artifacts.layerFilesystemReportArtifactPort(artifactDirectory).pipe(
        Layer.provide(resolver),
      );
      const inner = Layer.fresh(Store.layer).pipe(Layer.provide(Layer.mergeAll(base, artifacts)));
      const result = yield* Effect.gen(function* () {
        return yield* (yield* Store.MissionRetroReportStore).receive(command);
      }).pipe(Effect.provide(inner), Effect.mapError(mapStoreError));
      if (Result.isFailure(result)) {
        const failure = result.failure;
        return Result.fail(
          failure._tag === "MissionRetroReportRejection"
            ? { category: "report_rejected" as const, code: failure.code }
            : { category: "reconciliation_rejected" as const, code: failure.category },
        );
      }
      const outcome = result.success;
      return Result.succeed({
        missionId: command.missionId,
        checkpointId: command.checkpointId,
        commandId: command.commandId,
        committed: outcome.committed,
        recovered: outcome.recovered,
        eventSequence: outcome.eventSequence,
        disposition: outcome.disposition,
        verdict: outcome.verdict,
        sourceReportHash: outcome.sourceReportHash,
        normalizedReportHash: outcome.normalizedReportHash,
        normalizedArtifactRef: outcome.normalizedArtifactRef,
      });
    });
    return MissionRetroReportMcpService.of({ receive });
  });

/** Root supplies the private absolute directory; no registration, default, or activation. */
export const layer = (configuration: { readonly artifactDirectory: string }) =>
  Layer.effect(MissionRetroReportMcpService, make(configuration.artifactDirectory));

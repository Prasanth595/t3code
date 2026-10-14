import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { McpServer, Tool, Toolkit } from "effect/ai";

import {
  MissionRetroReportDispositionValue,
  MissionRetroReportVerdictValue,
} from "../../../../packages/contracts/src/missionRetroReportReceipt.ts";
import { RetroId, Sha256Hex } from "../../../../packages/contracts/src/missionRetro.ts";
import { NonNegativeInt } from "../../../../packages/contracts/src/baseSchemas.ts";
import * as Store from "../orchestration-v2/MissionRetroReportStore.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as MissionMcpAuthority from "./MissionMcpAuthority.ts";
import * as MissionMcp from "./MissionMcpService.ts";
import * as ReportMcp from "./MissionRetroReportMcpService.ts";

/**
 * Thin optional MCP seam over the accepted MissionRetroReportMcpService. This
 * module owns descriptors, one handler, and registration layers only: it
 * builds no service, supplies no policy, artifact directory, or activation,
 * and it changes no catalog, contract, or composition. Root provides the
 * genuine ReportMcpService (with its real SqlClient, projections, registry,
 * current policy, and transaction guard) and owns the optional merge.
 *
 * The scope is captured per MCP invocation from the ambient
 * McpInvocationContext, never from a caller reused across credentials and
 * never from tool parameters. The handler calls exactly one injected
 * ReportMcpService.receive; the delivery-only MissionMcpService.get path
 * cannot authorize this role. Callers supply only the eight existing
 * receive-command leaf fields; reporter text, DTOs, team/env/role, provider,
 * account, profile, path, credential, and auth-handle parameters do not
 * exist here and are SDK-rejected as excess JSON.
 */

/**
 * Bounded success: exactly the public service output, never the raw Effect
 * Result and never private store fields (receiptRecord, assignment token,
 * worker body, account, receipt, policy, or paths). normalizedArtifactRef is
 * content-addressed as `retro-normalized:<normalizedReportHash>` (the
 * semantic normalized hash), never the original whole-byte SHA.
 */
export const MissionRetroReportReceiveOutcome = Schema.Struct({
  missionId: RetroId,
  checkpointId: RetroId,
  commandId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  committed: Schema.Boolean,
  recovered: Schema.Boolean,
  eventSequence: NonNegativeInt,
  disposition: MissionRetroReportDispositionValue,
  verdict: MissionRetroReportVerdictValue,
  sourceReportHash: Sha256Hex,
  normalizedReportHash: Sha256Hex,
  normalizedArtifactRef: RetroId,
});
export type MissionRetroReportReceiveOutcome = typeof MissionRetroReportReceiveOutcome.Type;

/**
 * Bounded rejection: finite category plus the accepted report or
 * reconciliation code only. No worker body, assignment token, private
 * fields, or cause details.
 */
export const MissionRetroReportReceiveRejection = Schema.Struct({
  category: Schema.Literals(["report_rejected", "reconciliation_rejected"]),
  code: Schema.Literals([
    "checkpoint_missing",
    "analysis_missing",
    "lease_missing",
    "terminal_denied",
    "scope_mismatch",
    "epoch_mismatch",
    "claimed_hash_mismatch",
    "artifact_mismatch",
    "report_bound",
    "quarantine_bound",
    "malformed",
    "out_of_bounds",
    "unknown_source_ref",
    "invalid_shortlist_ref",
    "conflicting_incidents",
    "recursive_origin",
    "coverage_denied",
    "skill_evidence_invalid",
  ]),
});
export type MissionRetroReportReceiveRejection = typeof MissionRetroReportReceiveRejection.Type;

/** One explicit bounded object-root result: received carries only an outcome. */
export const MissionRetroReportReceiveResult = Schema.Struct({
  status: Schema.Literals(["received", "rejected"]),
  outcome: Schema.NullOr(MissionRetroReportReceiveOutcome),
  rejection: Schema.NullOr(MissionRetroReportReceiveRejection),
}).check(
  Schema.makeFilter((record) =>
    record.status === "received"
      ? record.outcome !== null && record.rejection === null
      : record.outcome === null && record.rejection !== null,
  ),
);
export type MissionRetroReportReceiveResult = typeof MissionRetroReportReceiveResult.Type;

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ReportMcp.MissionRetroReportMcpService,
];

export const MissionRetroReportReceiveTool = Tool.make("mission_retro_report_receive", {
  description:
    "Receive one already privately ingested immutable original retro report for the calling current RETRO manager thread on its current epoch. Needs an agent running inside a T3 thread with the orchestration capability; MCP clients signed in from outside a thread are unsupported. The eight command leaf fields reference the staged original artifact (ref plus whole-byte SHA) and the claimed source hash; the command id keys idempotent replay so retrying the exact command returns its durable outcome without a duplicate event, and a held partial stays held without promoting coverage. Returns a received outcome or a bounded rejection only: never a read ACK, skill-native execution, model upload, transport proof, or full-coverage claim.",
  parameters: Store.MissionRetroReportReceiveCommand,
  success: MissionRetroReportReceiveResult,
  failure: MissionMcp.MissionMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Title, "Receive a staged retro report")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const MissionRetroReportToolkit = Toolkit.make(MissionRetroReportReceiveTool);

const handlers = {
  mission_retro_report_receive: (input: Store.MissionRetroReportReceiveCommand) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ReportMcp.MissionRetroReportMcpService;
      const result = yield* service.receive(scope, input);
      if (Result.isSuccess(result)) {
        const outcome = result.success;
        return {
          status: "received" as const,
          outcome: {
            missionId: outcome.missionId,
            checkpointId: outcome.checkpointId,
            commandId: outcome.commandId,
            committed: outcome.committed,
            recovered: outcome.recovered,
            eventSequence: outcome.eventSequence,
            disposition: outcome.disposition,
            verdict: outcome.verdict,
            sourceReportHash: outcome.sourceReportHash,
            normalizedReportHash: outcome.normalizedReportHash,
            normalizedArtifactRef: outcome.normalizedArtifactRef,
          },
          rejection: null,
        };
      }
      return {
        status: "rejected" as const,
        outcome: null,
        rejection: {
          category: result.failure.category,
          code: result.failure.code,
        },
      };
    }),
} satisfies Parameters<typeof MissionRetroReportToolkit.toLayer>[0];

const handlersLayer = MissionRetroReportToolkit.toLayer(handlers);

/**
 * Toolkit registration over an injected ReportMcpService. Root supplies the
 * genuine service (config, SqlClient, projections, session registry, current
 * policy, transaction guard) in the build context; nothing here defaults it.
 */
export const layerMissionRetroReportToolkit = McpServer.toolkit(MissionRetroReportToolkit).pipe(
  Layer.provide(handlersLayer),
);

export { MissionRetroReportToolkit as Toolkit };

// A missing injected ReportMcpService or a missing trusted server policy
// keeps the tool out of the application catalog. An explicitly configured
// service under a disabled policy still registers and denies through the
// actual service (bounded MissionMcpFailure), never by silently enabling.
export const layerOptionalMissionRetroReportToolkit = Layer.unwrap(
  Effect.all([
    Effect.serviceOption(ReportMcp.MissionRetroReportMcpService),
    Effect.serviceOption(MissionMcpAuthority.MissionMcpTrustedPolicy),
  ]).pipe(
    Effect.map(([service, policy]) =>
      Option.isNone(service) || Option.isNone(policy)
        ? Layer.empty
        : layerMissionRetroReportToolkit.pipe(
            Layer.provide(Layer.succeed(ReportMcp.MissionRetroReportMcpService, service.value)),
            Layer.provide(
              Layer.succeed(MissionMcpAuthority.MissionMcpTrustedPolicy, policy.value),
            ),
          ),
    ),
  ),
);

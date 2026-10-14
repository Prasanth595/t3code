import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpServer, Tool, Toolkit } from "effect/ai";

import { Sha256Hex } from "../../../../packages/contracts/src/missionRetro.ts";
import {
  MissionCompletionSelector,
  type MissionCompletionSelector as MissionCompletionSelectorType,
} from "../../../../packages/contracts/src/missionCompletion.ts";
import { isHandoffOpaqueThreadId, isHandoffSafeId } from "../orchestration-v2/MissionManagerHandoff.ts";
import type { CompletionHoldReason } from "../orchestration-v2/MissionCompletionRouting.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as MissionMcpAuthority from "./MissionMcpAuthority.ts";
import * as MissionMcp from "./MissionMcpService.ts";
import * as CompletionMcp from "./MissionCompletionMcpService.ts";

/**
 * Thin optional MCP seam over the accepted MissionCompletionMcpService. This
 * module owns descriptors, one handler, and registration layers only: it
 * builds no service, supplies no policy, authority resolver, activation, or
 * wake/routing, and it changes no catalog, contract, or composition. Root
 * provides the genuine CompletionMcpService (with its real SqlClient,
 * authority port, current policy, and transaction guard) and owns the
 * optional merge.
 *
 * The scope is captured per MCP invocation from the ambient
 * McpInvocationContext, never from a caller reused across credentials and
 * never from tool parameters. The handler calls exactly one injected
 * CompletionMcpService.resolve. Callers supply only the strictly shared
 * MissionCompletionSelector leaf key; alleged scope, team, role, epoch,
 * provenance, lease, hash, body, or proof parameters do not exist here and
 * are SDK-rejected as excess JSON.
 */

/** Tool input: object root wrapping the strict shared selector leaf key. */
export const MissionCompletionRouteReadInput = Schema.Struct({
  selector: MissionCompletionSelector,
});
export type MissionCompletionRouteReadInput = typeof MissionCompletionRouteReadInput.Type;

/** Compact ASCII metadata id: 1-128 chars of `[A-Za-z0-9_.:-]`, no paths or controls. */
const CompactId128 = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.length >= 1 &&
      value.length <= 128 &&
      /^[A-Za-z0-9_.:-]+$/.test(value),
    { expected: "a compact ASCII id of 1-128 [A-Za-z0-9_.:-] characters" },
  ),
);

/**
 * Bounded encoded T3 thread id: compact ids plus actual delegated encodings
 * (colon segments with bounded percent-escapes). Pointer sized, never a body.
 */
const OpaqueThreadId = Schema.String.check(
  Schema.makeFilter((value) => isHandoffSafeId(value) || isHandoffOpaqueThreadId(value), { expected: "a bounded encoded T3 thread id" }),
);
const SafeCounter = Schema.Number.check(
  Schema.makeFilter((value) => Number.isSafeInteger(value) && value >= 0, { expected: "a nonnegative safe integer" }),
);

/**
 * Finite hold reason: exactly the existing
 * MissionCompletionRouting.ts union, no more and no fewer.
 */
export const MissionCompletionHoldReason = Schema.Literals([
  "malformed_input",
  "scope_mismatch",
  "mission_inactive",
  "missing_manager",
  "unknown_completion",
  "ambiguous_completion",
  "source_mismatch",
  "unresolved_source",
]);
const _holdReasonMatchesRouting: Record<CompletionHoldReason, true> = {
  malformed_input: true,
  scope_mismatch: true,
  mission_inactive: true,
  missing_manager: true,
  unknown_completion: true,
  ambiguous_completion: true,
  source_mismatch: true,
  unresolved_source: true,
};
void _holdReasonMatchesRouting;

/**
 * Bounded candidate route: current target plus the stable notification
 * pointer only. Never the full private scope, source binding, observed
 * copies, provenance, report hashes, lease, provider, account, body, detail,
 * paths, or credentials. The notification id is a pointer, not a durable
 * mailbox or wake acknowledgement.
 */
export const MissionCompletionRoute = Schema.Struct({
  role: Schema.Literals(["delivery", "retro"]),
  targetThreadId: OpaqueThreadId,
  targetEpoch: SafeCounter,
  canonicalRevision: SafeCounter,
  notificationId: Sha256Hex,
});
export type MissionCompletionRoute = typeof MissionCompletionRoute.Type;

/** One explicit bounded object-root result: candidate carries only a route. */
export const MissionCompletionRouteReadResult = Schema.Struct({
  status: Schema.Literals(["candidate", "hold"]),
  missionId: CompactId128,
  route: Schema.NullOr(MissionCompletionRoute),
  holdReason: Schema.NullOr(MissionCompletionHoldReason),
}).check(
  Schema.makeFilter((record) =>
    record.status === "candidate"
      ? record.route !== null && record.holdReason === null
      : record.route === null && record.holdReason !== null,
  ),
);
export type MissionCompletionRouteReadResult = typeof MissionCompletionRouteReadResult.Type;

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  CompletionMcp.MissionCompletionMcpService,
];

export const MissionCompletionRouteReadTool = Tool.make("mission_completion_route_read", {
  description:
    "Read one completion-route candidate or finite hold for the calling current completion manager thread on its current epoch. Needs an agent running inside a T3 thread with the orchestration capability; MCP clients signed in from outside a thread are unsupported. The selector is a lookup key only (task-result or retro-report identity plus counters); the current role manager, epoch, and canonical revision come from the actual canonical mission, never from caller claims. Returns a candidate route with a stable notification pointer, or a finite hold reason: never a wake, routing-ready mark, integration, acceptance, or delivery acknowledgement.",
  parameters: MissionCompletionRouteReadInput,
  success: MissionCompletionRouteReadResult,
  failure: MissionMcp.MissionMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Title, "Read a completion route candidate")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const MissionCompletionToolkit = Toolkit.make(MissionCompletionRouteReadTool);

const handlers = {
  mission_completion_route_read: (input: {
    readonly selector: MissionCompletionSelectorType;
  }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* CompletionMcp.MissionCompletionMcpService;
      const decision = yield* service.resolve(scope, input.selector);
      if (decision.kind === "candidate") {
        const candidate = decision.candidate;
        return {
          status: "candidate" as const,
          missionId: candidate.missionId,
          route: {
            role: candidate.role,
            targetThreadId: candidate.targetThreadId,
            targetEpoch: candidate.targetEpoch,
            canonicalRevision: candidate.canonicalRevision,
            notificationId: candidate.notificationId,
          },
          holdReason: null,
        };
      }
      return {
        status: "hold" as const,
        missionId: decision.missionId,
        route: null,
        holdReason: decision.reason,
      };
    }),
} satisfies Parameters<typeof MissionCompletionToolkit.toLayer>[0];

const handlersLayer = MissionCompletionToolkit.toLayer(handlers);

/**
 * Toolkit registration over an injected CompletionMcpService. Root supplies
 * the genuine service (SqlClient, authority port, current policy,
 * transaction guard) in the build context; nothing here defaults it.
 */
export const layerMissionCompletionToolkit = McpServer.toolkit(MissionCompletionToolkit).pipe(
  Layer.provide(handlersLayer),
);

export { MissionCompletionToolkit as Toolkit };

// A missing injected CompletionMcpService or a missing trusted server
// policy keeps the tool out of the application catalog. An explicitly
// configured service under a disabled policy still registers and denies
// through the actual service (bounded MissionMcpFailure), never by
// silently enabling.
export const layerOptionalMissionCompletionToolkit = Layer.unwrap(
  Effect.all([
    Effect.serviceOption(CompletionMcp.MissionCompletionMcpService),
    Effect.serviceOption(MissionMcpAuthority.MissionMcpTrustedPolicy),
  ]).pipe(
    Effect.map(([service, policy]) =>
      Option.isNone(service) || Option.isNone(policy)
        ? Layer.empty
        : layerMissionCompletionToolkit.pipe(
            Layer.provide(Layer.succeed(CompletionMcp.MissionCompletionMcpService, service.value)),
            Layer.provide(
              Layer.succeed(MissionMcpAuthority.MissionMcpTrustedPolicy, policy.value),
            ),
          ),
    ),
  ),
);

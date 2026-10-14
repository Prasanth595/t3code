import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpServer, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as MissionMcpAuthority from "./MissionMcpAuthority.ts";
import * as Access from "../orchestration-v2/MissionRetroSourceAccess.ts";

/**
 * Thin optional MCP seam over the accepted MissionRetroSourceAccess. This
 * module owns descriptors, one handler, and registration layers only: it
 * builds no service, supplies no policy, runtime probe, artifact directory,
 * or activation, and it changes no catalog, contract, or composition. Root
 * provides the genuine SourceAccess (with its real SqlClient, projections,
 * registry, current policy, and runtime port) and owns activation.
 *
 * The scope is captured per MCP invocation from the ambient
 * McpInvocationContext, never from a caller reused across credentials and
 * never from string metadata. The handler calls exactly one injected
 * SourceAccess.readChunk; delivery-only MissionMcpService.get cannot
 * authorize this role.
 */

/** Bounded tool input: window sizes are SDK-rejected above 16KiB. */
export const MissionRetroSourceReadInput = Schema.Struct({
  missionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  checkpointId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  chunkRef: Schema.String.check(Schema.isPattern(/^retro-source-chunk:[0-9a-f]{64}$/)),
  byteOffset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  byteLength: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: Access.MAX_MISSION_RETRO_SOURCE_FRAGMENT_BYTES }),
  ),
});
export type MissionRetroSourceReadInput = typeof MissionRetroSourceReadInput.Type;

/**
 * Bounded success: the UTF-8 window plus its prepared receipt binding.
 * receiptStatus is literally "prepared": never a model read, delivery, or
 * full-coverage claim, and never a trusted read receipt.
 */
export const MissionRetroSourceReadResult = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(Access.MAX_MISSION_RETRO_SOURCE_FRAGMENT_BYTES)),
  byteOffset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2_097_152 })),
  byteLength: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Access.MAX_MISSION_RETRO_SOURCE_FRAGMENT_BYTES })),
  totalChunkBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_097_152 })),
  chunkRef: Schema.String.check(Schema.isPattern(/^retro-source-chunk:[0-9a-f]{64}$/)),
  chunkHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  fragmentHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  preparedReceiptRef: Schema.String.check(Schema.isPattern(/^retro-source-read:[0-9a-f]{64}$/)),
  preparedReceiptHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  receiptStatus: Schema.Literal("prepared"),
});
export type MissionRetroSourceReadResult = typeof MissionRetroSourceReadResult.Type;

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  Access.MissionRetroSourceAccess,
];

export const MissionRetroSourceReadTool = Tool.make("mission_retro_source_read", {
  description:
    "Read one bounded window (at most 16KiB) of immutable staged mission retro source bytes for the calling reporter-child lease. Needs an agent running inside a T3 thread with the orchestration capability; MCP clients signed in from outside a thread are unsupported. Only the lease's reporter child thread, on its current run with the selected readonly profile, may read its staged chunk; caller liveness is checked against a root-supplied genuine runtime probe on every call. Returns the UTF-8 window plus a private prepared receipt reference with status prepared ONLY: not a model read, not delivery, not full coverage, and never a trusted read receipt.",
  parameters: MissionRetroSourceReadInput,
  success: MissionRetroSourceReadResult,
  failure: Access.MissionRetroSourceAccessError,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Title, "Read a staged retro source window")
  // Readonly in the canonical-data sense: the call writes no canonical rows,
  // promotes no read receipt, and touches no reconciliation state. It may
  // commit one private content-addressed prepared receipt blob, idempotently
  // reused when the exact byte tuple repeats.
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const MissionRetroSourceToolkit = Toolkit.make(MissionRetroSourceReadTool);

const handlers = {
  mission_retro_source_read: (input: MissionRetroSourceReadInput) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const access = yield* Access.MissionRetroSourceAccess;
      return yield* access.readChunk(scope, input);
    }),
} satisfies Parameters<typeof MissionRetroSourceToolkit.toLayer>[0];

const handlersLayer = MissionRetroSourceToolkit.toLayer(handlers);

/**
 * Toolkit registration over an injected SourceAccess. Root supplies the
 * genuine service (config, SqlClient, projections, session registry, current
 * policy, runtime port) in the build context; nothing here defaults it.
 */
export const layerMissionRetroSourceToolkit = McpServer.toolkit(MissionRetroSourceToolkit).pipe(
  Layer.provide(handlersLayer),
);

export { MissionRetroSourceToolkit as Toolkit };

// A missing injected SourceAccess or a missing trusted server policy keeps
// the tool out of the application catalog. An explicitly configured service
// under a disabled policy still registers and denies through the actual
// service (bounded SourceAccessError), never by silently enabling.
export const layerOptionalMissionRetroSourceToolkit = Layer.unwrap(
  Effect.all([
    Effect.serviceOption(Access.MissionRetroSourceAccess),
    Effect.serviceOption(MissionMcpAuthority.MissionMcpTrustedPolicy),
  ]).pipe(
    Effect.map(([access, policy]) =>
      Option.isNone(access) || Option.isNone(policy)
        ? Layer.empty
        : layerMissionRetroSourceToolkit.pipe(
            Layer.provide(Layer.succeed(Access.MissionRetroSourceAccess, access.value)),
            Layer.provide(
              Layer.succeed(MissionMcpAuthority.MissionMcpTrustedPolicy, policy.value),
            ),
          ),
    ),
  ),
);

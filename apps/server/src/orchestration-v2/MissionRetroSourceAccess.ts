// @effect-diagnostics nodeBuiltinImport:off -- exact chunk/fragment/receipt SHA binds prepared bytes.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { Mission, OrchestrationV2RunJson, ThreadId } from "@t3tools/contracts";
import type { OrchestrationV2AppThread } from "@t3tools/contracts";
import type { MissionRetroAnalysisLease } from "../../../../packages/contracts/src/missionRetroAnalysis.ts";
import {
  ELIGIBLE_RETRO_COMPANY,
  REQUESTED_RETRO_REPORTER,
} from "../../../../packages/contracts/src/missionRetro.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { MissionMcpTrustedPolicy, TrustedNoFunMissionPolicy } from "../mcp/MissionMcpAuthority.ts";
import * as Artifacts from "./MissionRetroReportArtifacts.ts";
import * as Projections from "./ProjectionStore.ts";

/**
 * Reporter-child access to canonical staged bytes. PRIVATE receipts are only
 * prepared: they cannot prove transport delivery, model receipt/read, or full
 * coverage, and never enter reconciliation's trusted readReceipts. A denied
 * call can leave an immutable prepared orphan. Root owns later observed ACK
 * promotion and production runtime resolution; this module activates nothing.
 * MissionMcpService.get is delivery-only and cannot authorize this role.
 */
export const MAX_MISSION_RETRO_SOURCE_FRAGMENT_BYTES = 16 * 1024;

export class MissionRetroSourceAccessError extends Schema.TaggedError<MissionRetroSourceAccessError>()(
  "MissionRetroSourceAccessError",
  {
    operation: Schema.Literal("readChunk"),
    category: Schema.Literals([
      "scope_denied",
      "invalid_input",
      "runtime_unavailable",
      "persistence",
    ]),
  },
) {
  override get message() {
    return `Mission retro source access ${this.operation} failed (${this.category}).`;
  }
}
const denied = () =>
  new MissionRetroSourceAccessError({ operation: "readChunk", category: "scope_denied" });
const invalid = () =>
  new MissionRetroSourceAccessError({ operation: "readChunk", category: "invalid_input" });

/** Trusted server-only request, detached from public input and canonical rows. */
export interface MissionRetroReporterRuntimeRequest {
  readonly threadId: string;
  readonly runId: string;
  readonly providerInstanceId: string;
  readonly thread: OrchestrationV2AppThread;
  readonly run: OrchestrationV2RunJson;
  readonly lease: MissionRetroAnalysisLease;
  readonly caller: {
    readonly environmentId: string;
    readonly requestNamespace: string;
    readonly issuedAt: number;
    readonly capabilities: ReadonlyArray<string>;
    readonly threadId: string;
    readonly providerInstanceId: string;
    readonly providerSessionId: string;
  };
}
const RuntimeFacts = Schema.Struct({
  threadId: Schema.String,
  runId: Schema.String,
  providerSessionId: Schema.String,
  verified: Schema.Boolean,
  accountVerified: Schema.Boolean,
  accountId: Schema.String,
  providerInstanceId: Schema.String,
  modelId: Schema.String,
  profile: Schema.String,
  company: Schema.String,
  capability: Schema.String,
  verifiedAccountRef: Schema.String,
  verifiedProviderRef: Schema.String,
  provenanceRef: Schema.String,
});
export type MissionRetroReporterRuntimeFacts = typeof RuntimeFacts.Type;

/**
 * REQUIRED external live probe of actual account/provider/model/profile and
 * capability, with verified provenance. String equality is NOT account
 * authentication. Root must supply a genuine resolver; no default success.
 */
export class MissionRetroReporterRuntimePort extends Context.Service<
  MissionRetroReporterRuntimePort,
  {
    readonly verify: (
      request: MissionRetroReporterRuntimeRequest,
    ) => Effect.Effect<MissionRetroReporterRuntimeFacts, MissionRetroSourceAccessError>;
  }
>()("t3/orchestration-v2/MissionRetroSourceAccess/MissionRetroReporterRuntimePort") {}

export interface MissionRetroSourceAccessConfig {
  /** Private root configuration, never a tool parameter. */
  readonly artifactDirectory: string;
}
export interface MissionRetroSourceChunkFragment {
  readonly text: string;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly totalChunkBytes: number;
  readonly chunkRef: string;
  readonly chunkHash: string;
  readonly fragmentHash: string;
  readonly preparedReceiptRef: string;
  readonly preparedReceiptHash: string;
  /** Preparation only; no transport/model-read claim. */
  readonly receiptStatus: "prepared";
}
export class MissionRetroSourceAccess extends Context.Service<
  MissionRetroSourceAccess,
  {
    readonly readChunk: (
      scope: McpInvocationScope,
      input: unknown,
    ) => Effect.Effect<MissionRetroSourceChunkFragment, MissionRetroSourceAccessError>;
  }
>()("t3/orchestration-v2/MissionRetroSourceAccess") {}

const Input = Schema.Struct({
  missionId: Schema.String,
  checkpointId: Schema.String,
  chunkRef: Schema.String,
  byteOffset: Schema.Number,
  byteLength: Schema.Number,
});
const decodeInputSync = Schema.decodeUnknownSync(Input, { onExcessProperty: "error" });
const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2RunJson), {
  onExcessProperty: "error",
});
const decodePolicySync = Schema.decodeUnknownSync(TrustedNoFunMissionPolicy, {
  onExcessProperty: "error",
});
const decodeFacts = Schema.decodeUnknownEffect(RuntimeFacts, { onExcessProperty: "error" });
const Entry = Schema.Struct({
  threadId: Schema.String,
  position: Schema.Int,
  itemId: Schema.String,
  sourceThreadId: Schema.String,
  runId: Schema.NullOr(Schema.String),
  messageId: Schema.NullOr(Schema.String),
  type: Schema.String,
  status: Schema.String,
  visibility: Schema.String,
  title: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  createdBy: Schema.NullOr(Schema.String),
  creationSource: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
const Chunk = Schema.Struct({
  threadId: Schema.String,
  coveredFromInclusive: Schema.Int,
  coveredToExclusive: Schema.Int,
  items: Schema.Array(Entry),
});
const decodeChunk = Schema.decodeUnknownEffect(Schema.fromJsonString(Chunk), {
  onExcessProperty: "error",
});
const sha = (bytes: Buffer | string) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const activeRun = (status: string) =>
  status === "starting" || status === "running" || status === "waiting";
const reviewSelection = (selection: OrchestrationV2AppThread["modelSelection"]) => {
  const profiles = selection.options?.filter((o) => o.id === "profile") ?? [];
  return profiles.length === 1 && profiles[0]?.value === "muse-review";
};
interface MissionRow {
  readonly team_id: string;
  readonly authority_environment_id: string;
  readonly revision: number;
  readonly snapshot_json: string;
}
interface RunRow {
  readonly run_id: string;
  readonly ordinal: number;
  readonly thread_id: string;
  readonly provider_instance_id: string;
  readonly status: string;
  readonly payload_json: string;
}
interface ProjectRow {
  readonly project_id: string;
  readonly workspace_root: string;
  readonly deleted_at: string | null;
}

const make = (config: MissionRetroSourceAccessConfig) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* Projections.ProjectionStoreV2;
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const policyService = yield* Effect.serviceOption(MissionMcpTrustedPolicy);
    const runtimePort = yield* Effect.serviceOption(MissionRetroReporterRuntimePort);
    const artifactDirectory = config?.artifactDirectory;
    const currentPolicy = Effect.try({
      try: () => {
        if (Option.isNone(policyService) || policyService.value.current === undefined)
          throw denied();
        return decodePolicySync(policyService.value.current());
      },
      catch: () => denied(),
    });

    const readChunk: MissionRetroSourceAccess["Service"]["readChunk"] = Effect.fn(
      "MissionRetroSourceAccess.readChunk",
    )(function* (scopeInput, unknownInput) {
      // All caller/input values are copied synchronously before the first yield.
      const scope = {
        ...scopeInput,
        capabilities: new Set(scopeInput.capabilities),
        thread: scopeInput.thread === undefined ? undefined : { ...scopeInput.thread },
        client: scopeInput.client === undefined ? undefined : { ...scopeInput.client },
      };
      const snapshotInput = Effect.try({
        try: () => Object.freeze(decodeInputSync(unknownInput)),
        catch: () => invalid(),
      });
      const input = yield* snapshotInput;
      if (
        typeof artifactDirectory !== "string" ||
        !NodePath.isAbsolute(artifactDirectory) ||
        input.missionId.length === 0 ||
        input.missionId.trim() !== input.missionId ||
        input.missionId.length > 512 ||
        input.checkpointId.length === 0 ||
        input.checkpointId.trim() !== input.checkpointId ||
        input.checkpointId.length > 512 ||
        !Number.isSafeInteger(input.byteOffset) ||
        !Number.isSafeInteger(input.byteLength) ||
        input.byteOffset < 0 ||
        input.byteLength <= 0 ||
        input.byteLength > MAX_MISSION_RETRO_SOURCE_FRAGMENT_BYTES ||
        !Number.isSafeInteger(input.byteOffset + input.byteLength) ||
        Artifacts.parseArtifactRef(input.chunkRef, "retro-source-chunk") === null
      )
        return yield* invalid();
      if (
        scope.thread === undefined ||
        scope.client !== undefined ||
        !scope.capabilities.has("orchestration")
      )
        return yield* denied();
      const caller = scope.thread;
      const authenticatedScope = { ...scope, thread: caller };
      if (Option.isNone(runtimePort))
        return yield* new MissionRetroSourceAccessError({
          operation: "readChunk",
          category: "runtime_unavailable",
        });
      const policy = yield* currentPolicy;
      const policyIdentity = stableStringify(policy);
      const environmentId = yield* environment.getEnvironmentId.pipe(
        Effect.mapError(() => denied()),
      );
      if (scope.environmentId !== environmentId || policy.environmentId !== environmentId)
        return yield* denied();
      const checkPolicy = currentPolicy.pipe(
        Effect.flatMap((p) =>
          stableStringify(p) === policyIdentity ? Effect.void : Effect.fail(denied()),
        ),
      );
      const checkSession = Effect.gen(function* () {
        if (
          registry.isActiveScope === undefined ||
          !(yield* registry.isActiveScope(authenticatedScope))
        )
          return yield* denied();
      });

      // Metadata only. The SAME SqlClient and ProjectionStore participate in
      // this read transaction; external runtime probes and FS never run here.
      const readCanonical = Effect.gen(function* () {
        const rows =
          yield* sql<MissionRow>`SELECT team_id, authority_environment_id, revision, snapshot_json FROM projection_missions WHERE mission_id = ${input.missionId}`;
        const row = rows[0];
        if (row === undefined) return yield* denied();
        const mission = yield* decodeMission(row.snapshot_json).pipe(
          Effect.mapError(() => denied()),
        );
        if (
          mission.id !== input.missionId ||
          mission.teamId !== row.team_id ||
          mission.authorityEnvironmentId !== row.authority_environment_id ||
          mission.revision !== row.revision ||
          mission.teamId !== policy.teamId ||
          mission.authorityEnvironmentId !== policy.environmentId
        )
          return yield* denied();
        const checkpoint = mission.execution?.retroCheckpoints?.find(
          (c) => c.checkpointId === input.checkpointId,
        );
        const analysis = mission.execution?.retroAnalyses?.find(
          (a) => a.checkpointId === input.checkpointId,
        );
        const manager = mission.managers.retro;
        if (
          checkpoint === undefined ||
          analysis === undefined ||
          manager === undefined ||
          analysis.lease === null
        )
          return yield* denied();
        if (
          checkpoint.teamId !== mission.teamId ||
          checkpoint.environmentId !== mission.authorityEnvironmentId ||
          checkpoint.missionId !== mission.id ||
          checkpoint.sourceRoot !== `thread://${encodeURIComponent(checkpoint.sourceThreadId)}` ||
          analysis.teamId !== mission.teamId ||
          analysis.environmentId !== mission.authorityEnvironmentId ||
          analysis.missionId !== mission.id ||
          analysis.sourceThreadId !== checkpoint.sourceThreadId ||
          analysis.sourceRoot !== checkpoint.sourceRoot ||
          analysis.snapshotFingerprint !== checkpoint.snapshotFingerprint ||
          analysis.coveredFromInclusive !== checkpoint.coveredFromInclusive ||
          analysis.coveredToExclusive !== checkpoint.coveredToExclusive ||
          analysis.status !== "reserved" ||
          analysis.settlement !== null ||
          analysis.managerThreadId !== manager.threadId ||
          analysis.managerEpoch !== manager.epoch
        )
          return yield* denied();
        const lease = analysis.lease;
        const refs = checkpoint.sourceRefs.filter((r) => r.chunkRef === input.chunkRef);
        const sourceRef = refs[0];
        if (
          refs.length !== 1 ||
          sourceRef === undefined ||
          sourceRef.rootRef !== checkpoint.sourceRoot ||
          sourceRef.chunkHash !==
            Artifacts.parseArtifactRef(input.chunkRef, "retro-source-chunk") ||
          sourceRef.coveredFromInclusive < checkpoint.coveredFromInclusive ||
          sourceRef.coveredToExclusive > checkpoint.coveredToExclusive ||
          lease.reporterChildThreadId !== caller.threadId ||
          lease.providerInstanceId !== caller.providerInstanceId ||
          lease.modelId !== REQUESTED_RETRO_REPORTER ||
          lease.profile !== "muse-review" ||
          lease.company !== ELIGIBLE_RETRO_COMPANY ||
          lease.expiresAtMs - lease.claimedAtMs > 900_000
        )
          return yield* denied();
        const thread = yield* projections.getThread(caller.threadId);
        const retro = yield* projections.getThread(ThreadId.make(manager.threadId));
        const source = yield* projections.getThread(ThreadId.make(checkpoint.sourceThreadId));
        if (
          [thread, retro, source].some(
            (t) =>
              t.deletedAt !== null ||
              t.archivedAt !== null ||
              !policy.allowedProjectIds.includes(t.projectId) ||
              !mission.bindings.some((b) => b.projectId === t.projectId),
          ) ||
          thread.id !== caller.threadId ||
          retro.id !== manager.threadId ||
          source.id !== checkpoint.sourceThreadId ||
          thread.providerInstanceId !== lease.providerInstanceId ||
          thread.modelSelection.instanceId !== lease.providerInstanceId ||
          thread.modelSelection.model !== lease.modelId ||
          !reviewSelection(thread.modelSelection) ||
          thread.lineage.parentThreadId !== retro.id ||
          thread.lineage.relationshipToParent !== "subagent" ||
          thread.lineage.rootThreadId !== retro.lineage.rootThreadId ||
          source.lineage.rootThreadId !== source.id ||
          source.lineage.parentThreadId !== null
        )
          return yield* denied();
        const projects =
          yield* sql<ProjectRow>`SELECT project_id, workspace_root, deleted_at FROM projection_projects WHERE ${sql.in("project_id", policy.allowedProjectIds)}`;
        if (
          !mission.bindings.every(
            (b) =>
              policy.allowedProjectIds.includes(b.projectId) &&
              projects.some(
                (p) =>
                  p.project_id === b.projectId &&
                  p.deleted_at === null &&
                  p.workspace_root === b.workspaceRoot,
              ),
          )
        )
          return yield* denied();
        // A stale running row is insufficient: the lease must own the latest
        // native run, with a consistent canonical payload and current selection.
        const runs =
          yield* sql<RunRow>`SELECT run_id, ordinal, thread_id, provider_instance_id, status, payload_json FROM orchestration_v2_projection_runs WHERE thread_id = ${caller.threadId} ORDER BY ordinal DESC LIMIT 1`;
        const runRow = runs[0];
        if (runRow === undefined) return yield* denied();
        const run = yield* decodeRun(runRow.payload_json).pipe(Effect.mapError(() => denied()));
        if (
          runRow.run_id !== lease.reporterRunId ||
          runRow.thread_id !== caller.threadId ||
          runRow.provider_instance_id !== lease.providerInstanceId ||
          !activeRun(runRow.status) ||
          run.id !== runRow.run_id ||
          run.threadId !== runRow.thread_id ||
          run.providerInstanceId !== runRow.provider_instance_id ||
          run.ordinal !== runRow.ordinal ||
          run.status !== runRow.status ||
          run.completedAt !== null ||
          run.modelSelection.instanceId !== lease.providerInstanceId ||
          run.modelSelection.model !== lease.modelId ||
          !reviewSelection(run.modelSelection)
        )
          return yield* denied();
        return {
          mission,
          checkpoint,
          analysis,
          lease,
          sourceRef,
          thread,
          retro,
          source,
          projects,
          run,
        };
      });
      const boundary = (expectedIdentity?: string) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const canonical = yield* readCanonical;
              if (expectedIdentity !== undefined && stableStringify(canonical) !== expectedIdentity)
                return yield* denied();
              const now = yield* Clock.currentTimeMillis;
              if (now < canonical.lease.claimedAtMs || now >= canonical.lease.expiresAtMs)
                return yield* denied();
              // Final authorization linearizes at the synchronized registry read.
              // Canonical SQL rows stay locked, and the local never-reused policy
              // revision brackets registry liveness with synchronous snapshots.
              yield* checkPolicy;
              yield* checkSession;
              yield* checkPolicy;
              return canonical;
            }),
          )
          .pipe(Effect.mapError(() => denied()));
      const canonical = yield* boundary();
      const { mission, checkpoint, analysis, lease, sourceRef } = canonical;
      const canonicalIdentity = stableStringify(canonical);
      const capturedCaller = Object.freeze({
        environmentId: scope.environmentId,
        issuedAt: scope.issuedAt,
        requestNamespace: scope.requestNamespace,
        capabilities: Object.freeze([...scope.capabilities].sort()),
        ...caller,
      });
      const scopeIdentityHash = sha(stableStringify(capturedCaller));
      // Deep detach on every probe; the port cannot mutate the expected binding.
      const runtimeRequest = (): MissionRetroReporterRuntimeRequest => ({
        threadId: lease.reporterChildThreadId,
        runId: lease.reporterRunId,
        providerInstanceId: lease.providerInstanceId,
        thread: structuredClone(canonical.thread),
        run: structuredClone(canonical.run),
        lease: Object.freeze({ ...lease }),
        caller: { ...capturedCaller, capabilities: [...capturedCaller.capabilities] },
      });
      const verifyRuntime = Effect.gen(function* () {
        const raw = yield* runtimePort.value.verify(runtimeRequest());
        const facts = yield* decodeFacts(raw).pipe(Effect.mapError(() => denied()));
        if (
          facts.threadId !== lease.reporterChildThreadId ||
          facts.runId !== lease.reporterRunId ||
          facts.providerSessionId !== caller.providerSessionId ||
          facts.verified !== true ||
          facts.accountVerified !== true ||
          facts.capability !== "read_only" ||
          facts.accountId !== lease.accountId ||
          facts.providerInstanceId !== lease.providerInstanceId ||
          facts.modelId !== lease.modelId ||
          facts.profile !== lease.profile ||
          facts.company !== lease.company ||
          facts.verifiedAccountRef !== lease.verifiedAccountRef ||
          facts.verifiedProviderRef !== lease.verifiedProviderRef ||
          facts.provenanceRef.trim().length === 0 ||
          facts.provenanceRef.length > 512
        )
          return yield* denied();
        return stableStringify(facts);
      });
      const runtimeIdentity = yield* verifyRuntime;
      // Initial external verification may yield while authority is revoked.
      yield* boundary(canonicalIdentity);
      const revalidate = Effect.gen(function* () {
        if ((yield* verifyRuntime) !== runtimeIdentity) return yield* denied();
        // Recanonicalize AFTER the external probe, never merely its input echo.
        yield* boundary(canonicalIdentity);
      });
      const stored = yield* Artifacts.readArtifactBytes({
        artifactDirectory,
        namespace: "retro-source-chunk",
        ref: sourceRef.chunkRef,
        maxBytes: 2_097_152,
      }).pipe(
        Effect.mapError(
          () =>
            new MissionRetroSourceAccessError({ operation: "readChunk", category: "persistence" }),
        ),
      );
      if (stored.sha !== sourceRef.chunkHash) return yield* denied();
      const payload = yield* decodeChunk(stored.text).pipe(Effect.mapError(() => denied()));
      if (
        payload.threadId !== checkpoint.sourceThreadId ||
        payload.coveredFromInclusive !== sourceRef.coveredFromInclusive ||
        payload.coveredToExclusive !== sourceRef.coveredToExclusive ||
        payload.items.length !== payload.coveredToExclusive - payload.coveredFromInclusive ||
        payload.items.some(
          (item, i) =>
            item.threadId !== payload.threadId ||
            item.position !== payload.coveredFromInclusive + i ||
            item.itemId.length === 0 ||
            item.sourceThreadId.length === 0,
        )
      )
        return yield* denied();
      yield* revalidate;
      const bytes = Buffer.from(stored.text, "utf8");
      if (input.byteOffset >= bytes.length || input.byteOffset + input.byteLength > bytes.length)
        return yield* invalid();
      const fragment = bytes.subarray(input.byteOffset, input.byteOffset + input.byteLength);
      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(fragment),
        catch: () => invalid(),
      });
      if (!Buffer.from(text, "utf8").equals(fragment)) return yield* invalid();
      const fragmentHash = sha(fragment);
      const receiptBytes = Buffer.from(
        stableStringify({
          version: 1,
          status: "prepared",
          scopeIdentityHash,
          runtimeIdentityHash: sha(runtimeIdentity),
          leaseIdentityHash: sha(stableStringify(lease)),
          teamId: mission.teamId,
          environmentId: mission.authorityEnvironmentId,
          missionId: mission.id,
          checkpointId: checkpoint.checkpointId,
          snapshotFingerprint: checkpoint.snapshotFingerprint,
          sourceRoot: checkpoint.sourceRoot,
          chunkRef: sourceRef.chunkRef,
          chunkHash: sourceRef.chunkHash,
          fragmentHash,
          byteOffset: input.byteOffset,
          byteLength: input.byteLength,
          totalChunkBytes: bytes.length,
          reporterChildThreadId: lease.reporterChildThreadId,
          reporterRunId: lease.reporterRunId,
          fence: analysis.fence,
          managerEpoch: analysis.managerEpoch,
          reportRevision: lease.reportRevision,
          assignmentRevision: lease.assignmentRevision,
          policyRevision: policy.revision,
        }),
        "utf8",
      );
      const preparedReceiptHash = sha(receiptBytes);
      yield* revalidate;
      yield* Artifacts.commitArtifactBytes({
        artifactDirectory,
        namespace: "retro-source-read",
        sha: preparedReceiptHash,
        bytes: receiptBytes,
      }).pipe(
        Effect.mapError(
          () =>
            new MissionRetroSourceAccessError({ operation: "readChunk", category: "persistence" }),
        ),
      );
      yield* revalidate;
      return {
        text,
        byteOffset: input.byteOffset,
        byteLength: input.byteLength,
        totalChunkBytes: bytes.length,
        chunkRef: sourceRef.chunkRef,
        chunkHash: sourceRef.chunkHash,
        fragmentHash,
        preparedReceiptRef: `retro-source-read:${preparedReceiptHash}`,
        preparedReceiptHash,
        receiptStatus: "prepared" as const,
      };
    });
    return MissionRetroSourceAccess.of({ readChunk });
  });

/** Root supplies the SAME SQL/projections/registry, local current policy,
 * ServerEnvironment, genuine runtime port and private artifact root. No tool,
 * transport receipt promotion, lease write, settlement or report activation. */
export const layerMissionRetroSourceAccess = (config: MissionRetroSourceAccessConfig) =>
  Layer.effect(MissionRetroSourceAccess, make(config));
export const makeMissionRetroSourceAccess = make;

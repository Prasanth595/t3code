// @effect-diagnostics nodeBuiltinImport:off -- preparation and immutable source identities use SHA-256.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { stableStringify } from "@t3tools/shared/relaySigning";
import type { Mission } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as MissionMcp from "../mcp/MissionMcpService.ts";
import * as OrchestratorMcp from "../mcp/OrchestratorMcpService.ts";
import * as Checkpoints from "./MissionRetroCheckpointStore.ts";
import * as Manifest from "./MissionRetroSourceManifest.ts";
import * as Artifacts from "./MissionRetroReportArtifacts.ts";
import * as Projections from "./ProjectionStore.ts";

/** Server-owned manual eligibility decision, never a public command assertion. */
export interface MissionRetroSourceTriggerContext {
  readonly mission: Mission;
  readonly caller: Invocation.McpInvocationScope;
  readonly command: Checkpoints.MissionRetroCaptureCommand;
  /** Derived from the authenticated current delivery-root relationship. */
  readonly actualOrigin: "product";
}

export interface MissionRetroSourceCaptureConfig {
  readonly artifactDirectory: string;
  readonly sanitize: Manifest.MissionRetroSourceSanitizer;
  readonly authorizeSource: Manifest.MissionRetroSourceAuthorizer;
  /** Required trusted root gate: approve this manual evidence boundary/trigger or deny. */
  readonly triggerGate: (
    input: MissionRetroSourceTriggerContext,
  ) => Effect.Effect<void, Checkpoints.MissionRetroCheckpointStoreError>;
  readonly budget?: Manifest.MissionRetroSourceBudget | undefined;
}

const denied = () =>
  new Checkpoints.MissionRetroCheckpointStoreError({
    operation: "capture",
    category: "scope_denied",
  });
const digest = (bytes: string) =>
  NodeCrypto.createHash("sha256").update(bytes, "utf8").digest("hex");
const detachCaller = (scope: Invocation.McpInvocationScope): Invocation.McpInvocationScope => ({
  ...scope,
  capabilities: new Set(scope.capabilities),
  thread: scope.thread === undefined ? undefined : { ...scope.thread },
  client: scope.client === undefined ? undefined : { ...scope.client },
});

const make = (configuration: MissionRetroSourceCaptureConfig) =>
  Effect.gen(function* () {
    // This optional adapter has no fallback authority, reader, caller or sanitizer.
    // Missing composition returns a denied port; construction performs no I/O.
    const reader = yield* Effect.serviceOption(OrchestratorMcp.OrchestratorMcpService);
    const missions = yield* Effect.serviceOption(MissionMcp.MissionMcpService);
    const authority = yield* Effect.serviceOption(MissionMcp.MissionMcpAuthorityPort);
    const projections = yield* Effect.serviceOption(Projections.ProjectionStoreV2);
    const invocation = yield* Effect.serviceOption(Invocation.McpInvocationContext);
    const config =
      configuration === undefined
        ? undefined
        : {
            ...configuration,
            budget: configuration.budget === undefined ? undefined : { ...configuration.budget },
          };
    const caller = Option.isNone(invocation) ? undefined : detachCaller(invocation.value);
    const readSnapshot = Effect.fn("MissionRetroSourceCapture.readSnapshot")(function* (
      proposed: Checkpoints.MissionRetroCaptureCommand,
    ): Effect.fn.Return<
      Checkpoints.MissionRetroTrustedSnapshot,
      Checkpoints.MissionRetroCheckpointStoreError
    > {
      if (
        config === undefined ||
        typeof config.artifactDirectory !== "string" ||
        !NodePath.isAbsolute(config.artifactDirectory) ||
        typeof config.sanitize !== "function" ||
        typeof config.authorizeSource !== "function" ||
        typeof config.triggerGate !== "function" ||
        Option.isNone(reader) ||
        Option.isNone(missions) ||
        Option.isNone(authority) ||
        Option.isNone(projections) ||
        caller?.thread === undefined ||
        caller.client !== undefined ||
        !caller.capabilities.has("orchestration")
      )
        return yield* denied();
      // Detach mutable caller command before the first yield; it supplies only a proposal.
      const callerThreadId = caller.thread.threadId;
      const command = Object.freeze({ ...proposed });
      if (
        !Number.isSafeInteger(command.fromInclusive) ||
        !Number.isSafeInteger(command.toExclusive) ||
        command.fromInclusive < 0 ||
        command.fromInclusive >= command.toExclusive ||
        command.toExclusive - command.fromInclusive > 10_000 ||
        command.sourceThreadId !== caller.thread.threadId ||
        !Checkpoints.ELIGIBLE_RETRO_TRIGGERS.has(command.trigger)
      )
        return yield* denied();
      const getCurrent = Effect.fn("MissionRetroSourceCapture.authorize")(function* () {
        const result = yield* missions.value
          .get(detachCaller(caller), { id: command.missionId })
          .pipe(
            Effect.provideService(MissionMcp.MissionMcpAuthorityPort, authority.value),
            Effect.mapError(() => denied()),
          );
        const mission = result.mission;
        if (
          result.status !== "found" ||
          mission === null ||
          mission.id !== command.missionId ||
          mission.authorityEnvironmentId !== caller.environmentId ||
          mission.managers.delivery?.threadId !== caller.thread?.threadId ||
          mission.managers.delivery?.epoch !== command.deliveryEpoch ||
          mission.managers.delivery.threadId !== command.sourceThreadId
        )
          return yield* denied();
        const thread = yield* projections.value
          .getThread(callerThreadId)
          .pipe(Effect.mapError(() => denied()));
        if (thread.lineage.rootThreadId !== thread.id || thread.lineage.parentThreadId !== null)
          return yield* denied();
        return mission;
      });
      const mission = yield* getCurrent();
      const canonicalIdentity = stableStringify(mission);
      const triggerContext = () => ({
        mission: structuredClone(mission),
        caller: detachCaller(caller),
        command,
        actualOrigin: "product" as const,
      });
      yield* config.triggerGate(triggerContext());
      const sourceRoot = `thread://${encodeURIComponent(command.sourceThreadId)}`;
      // This preparation identity exists BEFORE the canonical checkpoint ID. In
      // particular neither commandId nor snapshotFingerprint can enter it.
      const boundary = {
        teamId: mission.teamId,
        environmentId: mission.authorityEnvironmentId,
        missionId: mission.id,
        sourceThreadId: command.sourceThreadId,
        sourceRoot,
        fromInclusive: command.fromInclusive,
        toExclusive: command.toExclusive,
      };
      const captureBoundaryId = `retro-preparation:${digest(stableStringify(boundary))}`;
      let sourceContext: Manifest.MissionRetroSourceAuthorizationContext | undefined;
      const reauthorize = Effect.gen(function* () {
        if (stableStringify(yield* getCurrent()) !== canonicalIdentity) return yield* denied();
        yield* config.triggerGate(triggerContext());
        if (sourceContext !== undefined)
          yield* config.authorizeSource(sourceContext).pipe(Effect.mapError(() => denied()));
        // The trusted trigger gate may yield; check its current canonical binding too.
        if (stableStringify(yield* getCurrent()) !== canonicalIdentity) return yield* denied();
      });
      const trustedScope: Manifest.MissionRetroSourceTrustedScope = {
        ...boundary,
        captureBoundaryId,
        // Inherited/child lineage widening is deliberately root-integration work.
        allowedSourceThreadIds: [command.sourceThreadId],
      };
      const authorize: Manifest.MissionRetroSourceAuthorizer = (context) =>
        Effect.gen(function* () {
          sourceContext = context;
          yield* reauthorize.pipe(
            Effect.mapError(
              () =>
                new Manifest.MissionRetroSourceManifestError({
                  operation: "collect",
                  category: "scope_denied",
                }),
            ),
          );
        });
      const bundle = yield* Manifest.collectRetroSources({
        trustedScope,
        mcpScope: detachCaller(caller),
        reader: reader.value,
        authorize,
        sanitize: config.sanitize,
        budget: config.budget,
      }).pipe(Effect.mapError(() => denied()));
      yield* reauthorize;
      const persist = Effect.fn("MissionRetroSourceCapture.persist")(function* (
        namespace: "retro-source" | "retro-source-chunk",
        text: string,
        hash: string,
      ) {
        yield* reauthorize;
        yield* Artifacts.commitArtifactBytes({
          artifactDirectory: config.artifactDirectory,
          namespace,
          sha: hash,
          bytes: Buffer.from(text, "utf8"),
        });
        yield* reauthorize;
        const reopened = yield* Artifacts.readArtifactBytes({
          artifactDirectory: config.artifactDirectory,
          namespace,
          ref: `${namespace}:${hash}`,
          maxBytes: 2_097_152,
        });
        yield* reauthorize;
        if (reopened.sha !== hash || reopened.text !== text) return yield* denied();
      });
      // External API and filesystem work stays outside the owning checkpoint SQL
      // transaction. On denial/rollback, immutable unreferenced files may remain;
      // never eagerly delete a content address that another capture can reuse.
      for (const chunk of bundle.chunkArtifacts) {
        if (chunk.chunkRef !== `retro-source-chunk:${chunk.chunkHash}`) return yield* denied();
        yield* persist("retro-source-chunk", chunk.chunkBytes, chunk.chunkHash).pipe(
          Effect.mapError((error) =>
            error._tag === "MissionRetroCheckpointStoreError"
              ? error
              : new Checkpoints.MissionRetroCheckpointStoreError({
                  operation: "capture",
                  category: "persistence",
                  cause: error,
                }),
          ),
        );
      }
      yield* persist("retro-source", bundle.artifactBytes, bundle.artifactSha256).pipe(
        Effect.mapError((error) =>
          error._tag === "MissionRetroCheckpointStoreError"
            ? error
            : new Checkpoints.MissionRetroCheckpointStoreError({
                operation: "capture",
                category: "persistence",
                cause: error,
              }),
        ),
      );
      const checkpointId = Checkpoints.checkpointIdFor({
        teamId: mission.teamId,
        environmentId: mission.authorityEnvironmentId,
        missionId: mission.id,
        sourceThreadId: command.sourceThreadId,
        fromInclusive: command.fromInclusive,
        toExclusive: command.toExclusive,
        snapshotFingerprint: bundle.snapshotFingerprint,
      });
      // Separate private mapping avoids a cryptographic fixed point. This is a
      // prepared candidate ID; only a committed canonical checkpoint proves capture.
      const bindingBytes = stableStringify({
        version: 1,
        captureBoundaryId,
        checkpointId,
        snapshotFingerprint: bundle.snapshotFingerprint,
        manifestRef: bundle.artifactRef,
      });
      const bindingHash = digest(bindingBytes);
      yield* persist("retro-source", bindingBytes, bindingHash).pipe(
        Effect.mapError((error) =>
          error._tag === "MissionRetroCheckpointStoreError"
            ? error
            : new Checkpoints.MissionRetroCheckpointStoreError({
                operation: "capture",
                category: "persistence",
                cause: error,
              }),
        ),
      );
      yield* reauthorize;
      // Reserve one slot for the store's pending-child-runs note. Full omission
      // and uncovered-range indexes remain in the manifest, never silently lost.
      const notes = [
        "child-log-coverage-unknown",
        "raw-stdout-coverage-unknown",
        `source-manifest:${bundle.artifactRef}`,
        `source-binding:retro-source:${bindingHash}`,
      ];
      const omissions =
        bundle.omissions.length + notes.length <= 15
          ? [...bundle.omissions, ...notes]
          : [
              ...bundle.omissions.slice(0, 10),
              `source-omission-index:${bundle.omissions.length}:${bundle.artifactRef}`,
              ...notes,
            ];
      return {
        teamId: mission.teamId,
        environmentId: mission.authorityEnvironmentId,
        missionId: mission.id,
        deliveryThreadId: callerThreadId,
        deliveryEpoch: command.deliveryEpoch,
        nowMs: yield* Clock.currentTimeMillis,
        sourceRoot,
        sourceThreadId: command.sourceThreadId,
        actualOrigin: "product",
        eligibleTrigger: command.trigger,
        fromInclusive: command.fromInclusive,
        toExclusive: command.toExclusive,
        snapshotFingerprint: bundle.snapshotFingerprint,
        sourceRefs: bundle.sourceRefs,
        omissions,
        coverage: bundle.apiCoverage === "full" ? "unknown" : "partial",
        pendingChildRuns: bundle.pendingChildRuns || !bundle.pendingChildRunsKnown,
        capacity: {
          state: "unknown",
          accountId: null,
          company: null,
          reporterIdentity: null,
          exhausted: false,
          lowReserve: false,
          profile: null,
        },
      };
    });
    return Checkpoints.MissionRetroSnapshotPort.of({ readSnapshot });
  });

/**
 * Optional, invocation-scoped implementation of the EXISTING snapshot port.
 * Root must provide authentic OrchestratorMcpService, MissionMcpService (with
 * current MissionMcpAuthorityPort registry/policy resolver), ProjectionStoreV2,
 * McpInvocationContext, a private directory,
 * trusted source authorizer, sanitizer and manual trigger gate. Never install
 * this layer globally: the caller identity belongs to one authenticated MCP
 * invocation. No default gate, capacity probe, registration or automatic trigger.
 */
export const layerSourceCapture = (config: MissionRetroSourceCaptureConfig) =>
  Layer.effect(Checkpoints.MissionRetroSnapshotPort, make(config));

import {
  EnvironmentId,
  Mission,
  MissionCommand,
  MissionId,
  ProjectId,
  TeamId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as MissionService from "../orchestration-v2/MissionService.ts";
import { MissionRetroReportReceiveCommand } from "../orchestration-v2/MissionRetroReportStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as MissionMcpService from "./MissionMcpService.ts";

/** Server-only configuration; neither tool parameters nor persona/path inference may supply it. */
export const TrustedNoFunMissionPolicy = Schema.Struct({
  enabled: Schema.Literal(true),
  company: Schema.Literal("nofun"),
  companyVerified: Schema.Literal(true),
  bindingVerified: Schema.Literal(true),
  policyRef: TrimmedNonEmptyString,
  revision: TrimmedNonEmptyString,
  teamId: TeamId,
  environmentId: EnvironmentId,
  allowedProjectIds: Schema.Array(ProjectId),
  bootstrapControllerThreadIds: Schema.Array(ThreadId),
});
export type TrustedNoFunMissionPolicy = typeof TrustedNoFunMissionPolicy.Type;

/**
 * Root composition must provide a current trusted configuration reader. There
 * is deliberately no producer/default layer here. Revisions must change on
 * every policy edit, including disablement and revocation, and must never be
 * reused (including disable/re-enable). The local snapshot is published in
 * the same JavaScript runtime as the registry. This makes the equal revision
 * checks bracketing a synchronized registry read proof of policy at that point.
 */
export class MissionMcpTrustedPolicy extends Context.Service<
  MissionMcpTrustedPolicy,
  {
    readonly read: Effect.Effect<unknown, MissionMcpService.MissionMcpFailure>;
    /** Local, synchronous current snapshot, published atomically with revision
     * changes. No network, filesystem, promises, or yielding Effect inside SQL.
     * Missing this seam denies MCP; root owns its producer and activation. */
    readonly current?: (() => unknown) | undefined;
  }
>()("t3/mcp/MissionMcpAuthority/MissionMcpTrustedPolicy") {}

const decodePolicy = Schema.decodeUnknownEffect(TrustedNoFunMissionPolicy, {
  onExcessProperty: "error",
});
const decodeCurrentPolicy = Schema.decodeUnknownSync(TrustedNoFunMissionPolicy, {
  onExcessProperty: "error",
});
const decodeCommandSnapshot = Schema.decodeUnknownSync(Schema.fromJsonString(MissionCommand));
const decodeReportCommand = Schema.decodeUnknownSync(MissionRetroReportReceiveCommand, {
  onExcessProperty: "error",
});
const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));

/**
 * Detach a proposed commit body from caller-mutable memory. Returns undefined
 * for a missing or malformed proposal so commit resolution can fail closed.
 */
const decodeProposedSnapshot = Schema.decodeUnknownSync(Schema.fromJsonString(Mission));

const snapshotProposedMission = (input: unknown): Mission | undefined => {
  try {
    if (input === undefined) return undefined;
    return decodeProposedSnapshot(stableStringify(input));
  } catch {
    return undefined;
  }
};

const snapshotCommand = (input: unknown): MissionCommand | undefined => {
  try {
    return input === undefined ? undefined : decodeCommandSnapshot(stableStringify(input));
  } catch {
    return undefined;
  }
};

interface MissionRow {
  readonly team_id: string;
  readonly authority_environment_id: string;
  readonly revision: number;
  readonly snapshot_json: string;
}

interface ProjectRow {
  readonly project_id: string;
  readonly workspace_root: string;
  readonly deleted_at: string | null;
}

const make = Effect.gen(function* () {
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const policyReader = yield* Effect.serviceOption(MissionMcpTrustedPolicy);

  const readPolicy = Effect.gen(function* () {
    if (Option.isNone(policyReader)) {
      return yield* new MissionMcpService.MissionMcpFailure({
        code: "authority_unavailable",
        message: "A trusted NoFun mission policy is required.",
      });
    }
    if (policyReader.value.current === undefined) {
      return yield* new MissionMcpService.MissionMcpFailure({
        code: "authority_unavailable",
        message: "A local current NoFun mission policy snapshot is required.",
      });
    }
    const raw = yield* policyReader.value.read.pipe(
      Effect.mapError(
        () =>
          new MissionMcpService.MissionMcpFailure({
            code: "authority_unavailable",
            message: "The trusted NoFun mission policy is unavailable.",
          }),
      ),
    );
    return yield* decodePolicy(raw).pipe(
      Effect.mapError(
        () =>
          new MissionMcpService.MissionMcpFailure({
            code: "authority_unavailable",
            message: "The trusted NoFun mission policy is not enabled and verified.",
          }),
      ),
    );
  });

  const resolve = Effect.fn("MissionMcpAuthority.resolve")(function* (
    request: MissionMcpService.MissionMcpAuthorityRequest,
  ): Effect.fn.Return<
    MissionMcpService.MissionMcpAuthorityFacts,
    MissionMcpService.MissionMcpFailure
  > {
    // Snapshot caller identity before any I/O, including its mutable Set.
    const scope = {
      ...request.scope,
      thread: request.scope.thread === undefined ? undefined : { ...request.scope.thread },
      capabilities: new Set(request.scope.capabilities),
    };
    const missionId = request.missionId;
    const operation = request.operation;
    const requestKey = request.requestKey;
    const reportCommand =
      operation === "retro-report-receive"
        ? (() => {
            try {
              return decodeReportCommand(structuredClone(request.command));
            } catch {
              return undefined;
            }
          })()
        : undefined;
    const command =
      operation === "retro-report-receive" ? undefined : snapshotCommand(request.command);
    const deny = new MissionMcpService.MissionMcpFailure({
      code: "scope_denied",
      message: "The current credential, project, or mission controller binding is not authorized.",
    });
    if (
      operation === "retro-report-receive" &&
      (reportCommand === undefined ||
        reportCommand.missionId !== missionId ||
        requestKey === undefined)
    )
      return yield* deny;
    const guardRequest: MissionService.MissionTransactionRequest =
      operation === "retro-report-receive"
        ? {
            operation,
            missionId: MissionId.make(missionId),
            command: reportCommand as MissionRetroReportReceiveCommand,
          }
        : { operation, missionId, command };
    // Snapshot the proposed commit body before any I/O: the caller's object
    // stays mutable while policy, projection, and session reads yield.
    const proposedMission =
      operation === "commit" ? snapshotProposedMission(request.proposedMission) : undefined;
    if (
      operation === "commit" &&
      (proposedMission === undefined ||
        (requestKey !== undefined &&
          (command === undefined ||
            stableStringify(command.mission) !== stableStringify(proposedMission))))
    ) {
      return yield* deny;
    }
    if (!scope.capabilities.has("orchestration")) {
      return yield* new MissionMcpService.MissionMcpFailure({
        code: "capability_denied",
        message: "This credential cannot read or change missions.",
      });
    }
    if (scope.thread === undefined || scope.client !== undefined) {
      return yield* new MissionMcpService.MissionMcpFailure({
        code: "thread_credential_required",
        message: "Mission authority requires an authenticated T3 thread credential.",
      });
    }
    const authenticatedScope = { ...scope, thread: scope.thread };
    const actualEnvironmentId = yield* environment.getEnvironmentId;
    const assertLive = Effect.gen(function* () {
      if (
        scope.environmentId !== actualEnvironmentId ||
        registry.isActiveScope === undefined ||
        !(yield* registry.isActiveScope(authenticatedScope))
      ) {
        return yield* deny;
      }
    });
    yield* assertLive;
    const loadedPolicy = yield* readPolicy;
    const policy = {
      ...loadedPolicy,
      allowedProjectIds: [...loadedPolicy.allowedProjectIds],
      bootstrapControllerThreadIds: [...loadedPolicy.bootstrapControllerThreadIds],
    };
    // Materialize now so later in-place edits to a policy reader's arrays cannot
    // erase evidence of the original policy used to authorize this resolution.
    const policyIdentity = stableStringify(policy);
    if (policy.environmentId !== scope.environmentId) return yield* deny;

    const readBinding = (expectedMission?: Mission | null) =>
      Effect.gen(function* () {
        const thread = yield* projections.getThread(authenticatedScope.thread.threadId).pipe(
          Effect.mapError((error) =>
            error._tag === "ProjectionStoreThreadNotFoundError"
              ? deny
              : new MissionMcpService.MissionMcpFailure({
                  code: "unavailable",
                  message: "Mission authority records are unavailable.",
                }),
          ),
        );
        if (
          thread.id !== authenticatedScope.thread.threadId ||
          thread.deletedAt !== null ||
          thread.archivedAt !== null ||
          thread.providerInstanceId !== authenticatedScope.thread.providerInstanceId ||
          thread.modelSelection.instanceId !== authenticatedScope.thread.providerInstanceId ||
          !policy.allowedProjectIds.includes(thread.projectId)
        )
          return yield* deny;

        const projects = yield* sql<ProjectRow>`
        SELECT project_id, workspace_root, deleted_at FROM projection_projects
        WHERE ${sql.in("project_id", policy.allowedProjectIds)}
      `;
        const currentProject = projects.find((project) => project.project_id === thread.projectId);
        if (currentProject === undefined || currentProject.deleted_at !== null) return yield* deny;
        if (operation === "commit") {
          // Verify the proposed create/replace bindings against trusted policy
          // and current project rows. Proposed team, environment, and
          // controller values are never authority evidence: they are compared
          // here, never blessed, and the canonical manager checks below stay.
          if (
            proposedMission === undefined ||
            proposedMission.id !== missionId ||
            proposedMission.teamId !== policy.teamId ||
            proposedMission.authorityEnvironmentId !== policy.environmentId ||
            !proposedMission.bindings.some((binding) => binding.projectId === thread.projectId) ||
            !proposedMission.bindings.every(
              (binding) =>
                policy.allowedProjectIds.includes(binding.projectId) &&
                projects.some(
                  (project) =>
                    project.project_id === binding.projectId &&
                    project.deleted_at === null &&
                    project.workspace_root === binding.workspaceRoot,
                ),
            )
          )
            return yield* deny;
        }
        const rows = yield* sql<MissionRow>`
        SELECT team_id, authority_environment_id, revision, snapshot_json
        FROM projection_missions WHERE mission_id = ${missionId}
      `;
        const row = rows[0];
        if (row === undefined) {
          if (operation === "retro-report-receive") return yield* deny;
          // Missing reads and creates share the explicitly authorized bootstrap
          // root gate; knowledge of a missing id is not an authority grant.
          if (
            !policy.bootstrapControllerThreadIds.includes(thread.id) ||
            thread.lineage.rootThreadId !== thread.id ||
            thread.lineage.parentThreadId !== null
          )
            return yield* deny;
        } else {
          if (
            row.team_id !== policy.teamId ||
            row.authority_environment_id !== policy.environmentId
          )
            return yield* deny;
          const mission = yield* decodeMission(row.snapshot_json).pipe(Effect.mapError(() => deny));
          const manager =
            operation === "retro-report-receive"
              ? mission.managers.retro
              : mission.managers.delivery;
          if (
            mission.id !== missionId ||
            mission.teamId !== policy.teamId ||
            mission.authorityEnvironmentId !== policy.environmentId ||
            mission.revision !== row.revision ||
            manager?.threadId !== thread.id ||
            manager.epoch === undefined ||
            (operation === "retro-report-receive" && manager.epoch !== reportCommand?.retroEpoch) ||
            !mission.bindings.some((binding) => binding.projectId === thread.projectId) ||
            !mission.bindings.every(
              (binding) =>
                policy.allowedProjectIds.includes(binding.projectId) &&
                projects.some(
                  (project) =>
                    project.project_id === binding.projectId &&
                    project.deleted_at === null &&
                    project.workspace_root === binding.workspaceRoot,
                ),
            )
          )
            return yield* deny;
        }
        if (expectedMission !== undefined) {
          const actual =
            row === undefined
              ? null
              : yield* decodeMission(row.snapshot_json).pipe(Effect.mapError(() => deny));
          if (stableStringify(actual) !== stableStringify(expectedMission)) return yield* deny;
        }
        let lineage;
        if (operation === "retro-report-receive") {
          // Historical ancestors remain lineage evidence after archival. The
          // current caller must stay active; deleted ancestors still deny.
          const root = yield* projections
            .getThread(thread.lineage.rootThreadId)
            .pipe(Effect.mapError(() => deny));
          const parent =
            thread.lineage.parentThreadId === null
              ? null
              : yield* projections
                  .getThread(thread.lineage.parentThreadId)
                  .pipe(Effect.mapError(() => deny));
          if (
            root.deletedAt !== null ||
            root.lineage.rootThreadId !== root.id ||
            root.lineage.parentThreadId !== null ||
            !policy.allowedProjectIds.includes(root.projectId) ||
            (parent === null
              ? thread.id !== root.id || thread.lineage.relationshipToParent !== null
              : parent.deletedAt !== null ||
                parent.id === thread.id ||
                thread.id === root.id ||
                parent.lineage.rootThreadId !== root.id ||
                !policy.allowedProjectIds.includes(parent.projectId) ||
                thread.lineage.relationshipToParent === null)
          )
            return yield* deny;
          lineage = {
            caller: thread.lineage,
            root: { id: root.id, projectId: root.projectId, lineage: root.lineage },
            parent:
              parent === null
                ? null
                : { id: parent.id, projectId: parent.projectId, lineage: parent.lineage },
          };
        }
        return {
          ...(lineage === undefined ? {} : { lineage }),
          threadId: thread.id,
          projectId: thread.projectId,
          providerInstanceId: thread.providerInstanceId,
          projectRoot: currentProject.workspace_root,
          mission: row ?? null,
          projects: projects.slice().sort((a, b) => a.project_id.localeCompare(b.project_id)),
        };
      });
    const binding = yield* readBinding().pipe(
      Effect.mapError((error) =>
        error._tag === "MissionMcpFailure"
          ? error
          : new MissionMcpService.MissionMcpFailure({
              code: "unavailable",
              message: "Mission authority records are unavailable.",
            }),
      ),
    );
    if (stableStringify(yield* readPolicy) !== policyIdentity) return yield* deny;
    const checkLocalPolicy = Effect.try({
      try: () => {
        if (Option.isNone(policyReader) || policyReader.value.current === undefined) throw deny;
        return stableStringify(decodeCurrentPolicy(policyReader.value.current()));
      },
      catch: () => deny,
    }).pipe(
      Effect.flatMap((identity) => (identity === policyIdentity ? Effect.void : Effect.fail(deny))),
    );
    // I/O can yield while sessions, policy, or controller epochs are changed.
    // Recheck durable bindings under a transaction with current local policy
    // and registry liveness. No reads renew credentials or write authority.
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (stableStringify(yield* readBinding()) !== stableStringify(binding))
            return yield* deny;
          yield* assertLive;
          yield* checkLocalPolicy;
          const facts = {
            teamId: policy.teamId,
            environmentId: policy.environmentId,
            controllerThreadId: authenticatedScope.thread.threadId,
          };
          const transactionGuard =
            requestKey === undefined
              ? undefined
              : MissionService.MissionTransactionGuard.make({
                  sql,
                  requestKey,
                  request: guardRequest,
                  authority: facts,
                  check: (expectedMission) =>
                    Effect.gen(function* () {
                      yield* assertLive;
                      yield* checkLocalPolicy;
                      const current = yield* readBinding(expectedMission);
                      // The owning transaction may create/replace its mission. Compare
                      // external bindings separately from its explicitly expected result.
                      const external = { ...current, mission: null };
                      const originalExternal = { ...binding, mission: null };
                      if (
                        stableStringify(external) !== stableStringify(originalExternal) ||
                        (expectedMission === undefined &&
                          stableStringify(current) !== stableStringify(binding))
                      )
                        return yield* deny;
                      yield* checkLocalPolicy;
                      yield* assertLive;
                      // Registry check is synchronized with revocation. The local
                      // non-yielding policy snapshot brackets that read with an equal,
                      // never-reused revision. Authorization linearizes at the final
                      // registry read, before any later revocation/expiry. SQL
                      // authority rows remain locked until this transaction finishes.
                      yield* checkLocalPolicy;
                    }).pipe(
                      Effect.mapError(
                        () =>
                          new MissionService.MissionServiceError({
                            operation,
                            category: "scope_denied",
                          }),
                      ),
                    ),
                });
          return {
            company: "nofun" as const,
            companyVerified: true as const,
            bindingVerified: true as const,
            teamId: policy.teamId,
            environmentId: policy.environmentId,
            controllerThreadId: authenticatedScope.thread.threadId,
            ...(transactionGuard === undefined ? {} : { transactionGuard }),
          };
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "MissionMcpFailure"
            ? error
            : new MissionMcpService.MissionMcpFailure({
                code: "unavailable",
                message: "Mission authority records are unavailable.",
              }),
        ),
      );
  });
  return MissionMcpService.MissionMcpAuthorityPort.of({ resolve });
});

/** Optional production resolver. Root owns explicit policy production and activation. */
export const layer = Layer.effect(MissionMcpService.MissionMcpAuthorityPort, make);

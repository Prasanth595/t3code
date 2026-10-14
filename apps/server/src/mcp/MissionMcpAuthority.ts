import {
  EnvironmentId,
  Mission,
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
 * every policy edit, including disablement and revocation.
 */
export class MissionMcpTrustedPolicy extends Context.Service<
  MissionMcpTrustedPolicy,
  {
    readonly read: Effect.Effect<unknown, MissionMcpService.MissionMcpFailure>;
  }
>()("t3/mcp/MissionMcpAuthority/MissionMcpTrustedPolicy") {}

const decodePolicy = Schema.decodeUnknownEffect(TrustedNoFunMissionPolicy, {
  onExcessProperty: "error",
});
const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));

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
    const deny = new MissionMcpService.MissionMcpFailure({
      code: "scope_denied",
      message: "The current credential, project, or mission controller binding is not authorized.",
    });
    const assertLive = Effect.gen(function* () {
      if (
        scope.environmentId !== (yield* environment.getEnvironmentId) ||
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

    const readBinding = Effect.gen(function* () {
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
      const rows = yield* sql<MissionRow>`
        SELECT team_id, authority_environment_id, revision, snapshot_json
        FROM projection_missions WHERE mission_id = ${missionId}
      `;
      const row = rows[0];
      if (row === undefined) {
        // Missing reads and creates share the explicitly authorized bootstrap
        // root gate; knowledge of a missing id is not an authority grant.
        if (
          !policy.bootstrapControllerThreadIds.includes(thread.id) ||
          thread.lineage.rootThreadId !== thread.id ||
          thread.lineage.parentThreadId !== null
        )
          return yield* deny;
      } else {
        if (row.team_id !== policy.teamId || row.authority_environment_id !== policy.environmentId)
          return yield* deny;
        const mission = yield* decodeMission(row.snapshot_json).pipe(Effect.mapError(() => deny));
        const manager = mission.managers.delivery;
        if (
          mission.id !== missionId ||
          mission.teamId !== policy.teamId ||
          mission.authorityEnvironmentId !== policy.environmentId ||
          mission.revision !== row.revision ||
          manager?.threadId !== thread.id ||
          manager.epoch === undefined ||
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
      return stableStringify({
        threadId: thread.id,
        projectId: thread.projectId,
        providerInstanceId: thread.providerInstanceId,
        projectRoot: currentProject.workspace_root,
        mission: row ?? null,
        projects: projects.slice().sort((a, b) => a.project_id.localeCompare(b.project_id)),
      });
    });
    const binding = yield* readBinding.pipe(
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
    // I/O can yield while sessions, policy, or controller epochs are changed.
    // Recheck durable bindings under a transaction while re-reading current
    // policy and registry liveness. No reads renew credentials or write authority.
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if ((yield* readBinding) !== binding) return yield* deny;
          if (stableStringify(yield* readPolicy) !== policyIdentity) return yield* deny;
          yield* assertLive;
          return {
            company: "nofun" as const,
            companyVerified: true as const,
            bindingVerified: true as const,
            teamId: policy.teamId,
            environmentId: policy.environmentId,
            controllerThreadId: authenticatedScope.thread.threadId,
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

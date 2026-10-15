import {
  MessageId,
  ThreadId,
  OrchestratorMcpFailure,
  ProjectId,
  type Project as ProjectRecord,
  type ProjectScopedServerSettingKey,
  type ProjectSettingsOverrides,
  type ProjectUpdatePayload,
} from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import {
  clearProjectSettingsOverrides,
  resolveProjectSettings,
} from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Settings from "../../../serverSettings.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { newCommandId, readCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { ProjectToolkit } from "./tools.ts";

function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectNotFoundError"
      ? "The project was not found."
      : error._tag === "ProjectConflictError"
        ? "The workspace is already registered to a project."
        : "The project is not empty; force=true is required to delete it.";
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}

/**
 * An existing checkout a launch may bind: one of the project's own git
 * worktrees. Without this check a launch could point an agent at any directory
 * on the machine.
 */
const assertProjectWorktree = Effect.fn("mcp.assertProjectWorktree")(function* (
  workspaceRoot: string,
  worktreePath: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const real = (path: string) => fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));
  const worktrees = yield* git.listWorktreePaths(workspaceRoot).pipe(
    Effect.flatMap((paths) => Effect.forEach(paths, real)),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  if (!worktrees.includes(yield* real(worktreePath)))
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "worktreePath must be one of the project's git worktrees. t3_worktree_list shows them.",
    });
});

type ProjectSettingsInput = Pick<
  ProjectUpdatePayload,
  "scripts" | "defaultModelSelection" | "defaultThreadEnvMode" | "autoPull"
>;

/**
 * These fields live in the project's settings override, which is what
 * `resolveProjectSettings`, `resolveProjectScripts` and the app read. The
 * aggregate's own fields only count before the legacy fold, so writing them
 * there is lost. A `null` model or env mode removes the override, so the
 * project inherits the environment value again.
 * Read-then-patch, like the app's editors: a concurrent override write to the
 * same project between the two steps is lost. Revisit if settings gain an
 * atomic per-project patch.
 */
const writeProjectSettings = Effect.fn("mcp.writeProjectSettings")(function* (
  projectId: ProjectId,
  input: ProjectSettingsInput,
) {
  const set: ProjectSettingsOverrides = {
    ...(input.scripts === undefined ? {} : { defaultProjectScripts: input.scripts }),
    ...(input.defaultModelSelection == null
      ? {}
      : { defaultModelSelection: input.defaultModelSelection }),
    ...(input.defaultThreadEnvMode == null
      ? {}
      : { defaultThreadEnvMode: input.defaultThreadEnvMode }),
    ...(input.autoPull === undefined ? {} : { defaultAutoPull: input.autoPull }),
  };
  const cleared: ProjectScopedServerSettingKey[] = [
    ...(input.defaultModelSelection === null ? (["defaultModelSelection"] as const) : []),
    ...(input.defaultThreadEnvMode === null ? (["defaultThreadEnvMode"] as const) : []),
  ];
  if (Object.keys(set).length === 0 && cleared.length === 0) return;
  const settings = yield* Settings.ServerSettingsService;
  const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
  const kept = clearProjectSettingsOverrides(current, projectId, cleared) ?? {};
  yield* settings
    .updateSettings({ projectSettingsOverrides: { [projectId]: { ...kept, ...set } } })
    .pipe(Effect.mapError(unavailable));
});

/** The project as the app resolves it, not the aggregate's legacy fields. */
const withResolvedSettings = Effect.fn("mcp.withResolvedSettings")(function* <
  P extends ProjectRecord,
>(project: P) {
  const settings = yield* Settings.ServerSettingsService;
  const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
  const resolved = resolveProjectSettings(current, project.id, project);
  return {
    ...project,
    scripts: resolveProjectScripts(current, project),
    // The project's own choice; null when it inherits the environment.
    defaultModelSelection:
      resolved.sources.defaultModelSelection === "project"
        ? resolved.settings.defaultModelSelection
        : null,
    defaultThreadEnvMode:
      resolved.sources.defaultThreadEnvMode === "project"
        ? resolved.settings.defaultThreadEnvMode
        : null,
    autoPull: resolved.settings.defaultAutoPull,
  };
});

const access = Effect.gen(function* () {
  yield* readCaller();
  return yield* Project.ProjectService;
});
export const layer = McpToolAccess.toLayer(ProjectToolkit, {
  t3_thread_launch: McpToolAccess.startsThreads(
    (input) => input,
    (input, { runtimeMode, interactionMode }) =>
      Effect.gen(function* () {
        const context = yield* readCaller();
        const { caller } = context;
        const commandId = yield* newCommandId();
        const threadId = ThreadId.make(commandId);
        const messageId = MessageId.make(commandId);
        const attachments = input.attachments ?? [];
        if (attachments.some((attachment) => !Claims.attachmentIsPendingUpload(attachment)))
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "A new thread accepts only pending attachment uploads.",
          });
        if (
          input.scratch === true &&
          (input.projectId !== undefined || input.workspaceStrategy !== undefined)
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "scratch:true picks its own project and folder; omit projectId and workspaceStrategy.",
          });
        const projectId =
          input.scratch === true
            ? (yield* ManagedProjectFolders.ManagedProjectFolders.pipe(
                Effect.flatMap((folders) => folders.ensureScratchProject),
                Effect.mapError(
                  (error) =>
                    new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: error.message,
                    }),
                ),
              )).projectId
            : yield* resolveProjectId(context, input.projectId);
        const readProject = Project.ProjectService.pipe(
          Effect.flatMap((projects) => projects.getById(projectId)),
          Effect.mapError(unavailable),
          Effect.map(Option.getOrUndefined),
        );
        if (input.workspaceStrategy?.type === "existing_worktree") {
          const project = yield* readProject;
          if (project === undefined)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "The project was not found.",
            });
          yield* assertProjectWorktree(project.workspaceRoot, input.workspaceStrategy.worktreePath);
        }
        // A launch is accepted before its worktree is provisioned, so a base
        // ref that cannot resolve, or a branch that exists, is refused while
        // the agent can still act on it.
        const strategy = input.workspaceStrategy;
        if (strategy?.type === "worktree")
          yield* ThreadLaunch.ThreadLaunchService.pipe(
            Effect.flatMap((launches) =>
              launches.checkWorktreeBase({ projectId, workspaceStrategy: strategy }),
            ),
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message:
                    error._tag === "ThreadLaunchBranchExistsError"
                      ? `${error.message} No thread was created. Pass a new branch name, or omit branch to let T3 Code name it.`
                      : error._tag === "ThreadLaunchNotRepositoryError"
                        ? `${error.message} No thread was created. Use workspaceStrategy type "root" to run in the project folder.`
                        : `${error.message} No thread was created. Pass a branch, tag, or commit that exists there${
                            strategy.startFromOrigin === true
                              ? "; the project has no origin remote to fetch it from."
                              : ", or set startFromOrigin:true if it exists only on origin."
                          }`,
                }),
            ),
          );
        const projectDefaultModel = Effect.gen(function* () {
          const project = yield* readProject;
          const settings = yield* Settings.ServerSettingsService.pipe(
            Effect.flatMap((service) => service.getSettings),
            Effect.mapError(unavailable),
          );
          // The same resolver the app uses: project override, then environment.
          return resolveProjectSettings(settings, projectId, project).settings
            .defaultModelSelection;
        });
        const modelSelection =
          input.modelSelection ??
          caller?.modelSelection ??
          (yield* projectDefaultModel) ??
          undefined;
        if (modelSelection === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
          });
        const result = yield* ThreadMessageIntake.launchThread({
          commandId,
          threadId,
          projectId,
          title: input.title,
          modelSelection,
          runtimeMode,
          interactionMode,
          workspaceStrategy: input.workspaceStrategy ?? { type: "root" },
          ...(input.message === undefined && attachments.length === 0
            ? {}
            : {
                initialMessage: {
                  messageId,
                  ...(caller === undefined ? {} : { senderThreadId: caller.id }),
                  text: input.message ?? "",
                  attachments,
                },
              }),
          createdBy: "agent",
          creationSource: "mcp",
        }).pipe(
          Effect.mapError((error) => {
            if (error._tag === "AttachmentClaimError") {
              return new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: error.message,
              });
            }
            if (error._tag === "ThreadManagementProviderInstanceDisabledError") {
              return new OrchestratorMcpFailure({
                code: "invalid_request",
                message: error.message,
              });
            }
            return unavailable();
          }),
        );
        const thread = result.projection.thread;
        const run = result.projection.runs.find((run) => run.userMessageId === messageId);
        return {
          threadId: thread.id,
          projectId: thread.projectId,
          modelSelection: thread.modelSelection,
          runId: run?.id ?? null,
          status: run?.status ?? null,
        };
      }),
  ),
  t3_project_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projects = yield* access;
      const snapshot = yield* projects.snapshot.pipe(Effect.mapError(unavailable));
      const rows = snapshot.projects.filter((project) => project.deletedAt === null);
      const start = input.cursor ?? 0,
        end = start + (input.limit ?? 20);
      return { projects: rows.slice(start, end), nextCursor: end < rows.length ? end : null };
    }),
  ),
  t3_project_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projects = yield* access;
      const result = yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(result))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      return yield* withResolvedSettings(result.value);
    }),
  ),
  t3_project_create: McpToolAccess.writesEnvironment(({ workspaceRoot, scripts, ...input }) =>
    Effect.gen(function* () {
      const projects = yield* Project.ProjectService;
      if (workspaceRoot === undefined) {
        // Project creation records no model default (only an update does), so
        // reject what this mode would otherwise drop silently.
        if (
          scripts !== undefined ||
          input.createWorkspaceRootIfMissing !== undefined ||
          input.defaultModelSelection !== undefined
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "A project started from its title takes only a title; set scripts or defaultModelSelection afterwards with t3_project_update.",
          });
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const created = yield* folders
          .createNamedProject({ name: input.title })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
            ),
          );
        const project = yield* projects
          .getById(created.projectId)
          .pipe(
            Effect.mapError(unavailable),
            Effect.flatMap(
              Option.match({ onNone: () => Effect.fail(unavailable()), onSome: Effect.succeed }),
            ),
          );
        return {
          ...project,
          ...(created.commitError === undefined ? {} : { commitError: created.commitError }),
        };
      }
      const commandId = yield* newCommandId();
      const created = yield* projects
        .create({ ...input, workspaceRoot, commandId, projectId: ProjectId.make(commandId) })
        .pipe(Effect.mapError(projectFailure));
      yield* writeProjectSettings(created.id, {
        scripts,
        defaultModelSelection: input.defaultModelSelection,
      });
      return yield* withResolvedSettings(created);
    }),
  ),
  t3_project_update: McpToolAccess.writesEnvironment(
    ({ scripts, defaultModelSelection, defaultThreadEnvMode, autoPull, ...input }) =>
      Effect.gen(function* () {
        const projects = yield* Project.ProjectService;
        // The update runs first so an unknown project fails before settings change.
        const updated = yield* projects
          .update({ ...input, commandId: yield* newCommandId() })
          .pipe(Effect.mapError(projectFailure));
        yield* writeProjectSettings(updated.id, {
          scripts,
          defaultModelSelection,
          defaultThreadEnvMode,
          autoPull,
        });
        return yield* withResolvedSettings(updated);
      }),
  ),
  t3_project_delete: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const projects = yield* Project.ProjectService;
      return yield* projects
        .delete({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
    }),
  ),
  t3_project_clone: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const repositories = yield* Repositories.SourceControlRepositoryService;
      return yield* repositories.cloneRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: error.detail,
            }),
        ),
      );
    }),
  ),
});

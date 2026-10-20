import { OrchestratorMcpFailure, type TerminalError } from "@t3tools/contracts";
import {
  projectScriptRuntimeEnv,
  projectScriptTerminalInput,
} from "@t3tools/shared/projectScripts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as Project from "../../../project/ProjectService.ts";
import * as TerminalManager from "../../../terminal/Manager.ts";
import { isWithinRoot } from "../../../workspace/KnownWorkspaces.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertFullAccess, readThread, unavailable } from "../../threadAccess.ts";
import { TerminalToolkit } from "./tools.ts";

const terminalFailure = (error: TerminalError) =>
  error._tag === "TerminalCwdNotFoundError" || error._tag === "TerminalCwdNotDirectoryError"
    ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
    : unavailable();

const handlers = {
  // The target must be within the caller's modes, like any write to another
  // thread, and the caller must be full-access: a typed command runs outside
  // the provider's sandbox and approval flow.
  t3_terminal_open: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const context = yield* readThread(input.threadId);
        yield* assertFullAccess(
          context,
          "Opening a terminal needs a live full-access/default calling thread or a full-access client.",
        );
        const { thread } = context.projection;
        const projects = yield* Project.ProjectService;
        const project = yield* projects
          .getById(thread.projectId)
          .pipe(Effect.mapError(unavailable));
        if (Option.isNone(project))
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The project was not found.",
          });
        const { workspaceRoot } = project.value;
        const path = yield* Path.Path;
        const roots = [workspaceRoot, thread.worktreePath]
          .filter((root) => root !== null)
          .map((root) => path.resolve(root));
        const cwd = path.resolve(thread.worktreePath ?? workspaceRoot, input.cwd ?? ".");
        if (!roots.some((root) => isWithinRoot(path, cwd, root)))
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "cwd must be inside the project root or the thread's worktree.",
          });
        const crypto = yield* Crypto.Crypto;
        const terminalId =
          input.terminalId ??
          `agent-${(yield* crypto.randomUUIDv4().pipe(Effect.orDie)).slice(0, 8)}`;
        const terminals = yield* TerminalManager.TerminalManager;
        const session = yield* terminals
          .open({
            threadId: thread.id,
            terminalId,
            cwd,
            worktreePath: thread.worktreePath,
            env: {
              ...projectScriptRuntimeEnv({
                project: { cwd: workspaceRoot },
                worktreePath: thread.worktreePath,
              }),
              ...input.env,
            },
          })
          .pipe(Effect.mapError(terminalFailure));
        if (input.command !== undefined)
          yield* terminals
            .write({
              threadId: thread.id,
              terminalId,
              data: projectScriptTerminalInput(input.command),
            })
            .pipe(Effect.mapError(terminalFailure));
        return {
          threadId: thread.id,
          terminalId,
          cwd: session.cwd,
          pid: session.pid,
          status: session.status,
        };
      }),
  ),
} satisfies McpToolAccess.Handlers<typeof TerminalToolkit.tools>;

export const layer = McpToolAccess.toLayer(TerminalToolkit, handlers);

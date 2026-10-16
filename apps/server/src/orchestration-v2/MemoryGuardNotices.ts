import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { MemoryGuardNotices, type StoppedCommand } from "../process/memoryGuard.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export function memoryGuardNoticeText(stopped: StoppedCommand): string {
  const gigabytes = (stopped.bytes / 1024 ** 3).toFixed(1);
  return `T3 Code stopped \`${stopped.command}\` (${gigabytes} GB across ${stopped.processes} processes) because macOS reported ${stopped.pressure} memory pressure. This was not a failure in the code it ran. If you need it again, run it alone or with fewer parallel workers.`;
}

export const layer = Layer.effect(
  MemoryGuardNotices,
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectService.ProjectService;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const real = (target: string) =>
      fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));

    return {
      commandStopped: (stopped) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(stopped.threadId);
          const thread = yield* projections.getThread(threadId);
          if (thread.archivedAt !== null || thread.deletedAt !== null) return;
          if (stopped.codexThreadId !== undefined) {
            const { providerThreads } = yield* projections.getThreadRecords(threadId, [
              "providerThreads",
            ]);
            const ownsCommand = providerThreads.some(
              (providerThread) =>
                providerThread.nativeThreadRef?.nativeId === stopped.codexThreadId,
            );
            if (!ownsCommand) {
              return yield* Effect.logInfo(
                "Memory guard notice skipped: the command belongs to another Codex thread",
                { threadId },
              );
            }
          }
          const root =
            thread.worktreePath ??
            Option.getOrUndefined(yield* projects.getById(thread.projectId))?.workspaceRoot;
          if (root === undefined) return;
          const [cwd, threadRoot] = [yield* real(stopped.cwd), yield* real(root)];
          // A shared provider server labels every command with the thread that
          // launched it, so only notify when the command ran inside this thread.
          const relative = path.relative(threadRoot, cwd);
          if (relative.startsWith("..") || path.isAbsolute(relative)) {
            return yield* Effect.logInfo(
              "Memory guard notice skipped: command ran outside the thread",
              {
                threadId,
              },
            );
          }
          const key = `${stopped.threadId}:${yield* Clock.currentTimeMillis}`;
          const text = memoryGuardNoticeText(stopped);
          yield* engine.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`server:memory-guard:${key}`),
            threadId,
            messageId: MessageId.make(`message:memory-guard:${key}`),
            text,
            notification: {
              source: { kind: "system" },
              outcome: "failed",
              summary: `T3 Code stopped ${path.basename(stopped.command.split(" ")[0] ?? "a command")} to free memory`,
              detail: text,
            },
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "server",
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Memory guard could not notify the thread", {
              threadId: stopped.threadId,
              cause,
            }),
          ),
        ),
    };
  }),
);

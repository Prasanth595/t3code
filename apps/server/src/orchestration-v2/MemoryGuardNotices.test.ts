// @effect-diagnostics nodeBuiltinImport:off -- the notice compares real directories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { MemoryGuardNotices, type StoppedCommand } from "../process/memoryGuard.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as MemoryGuardNoticesLive from "./MemoryGuardNotices.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

describe("MemoryGuardNotices", () => {
  it.effect(
    "tells the thread that ran the command, and skips other directories and Codex threads",
    () =>
      Effect.gen(function* () {
        const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-memory-guard-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(base, { recursive: true, force: true })),
        );
        const worktree = NodePath.join(base, "worktree");
        const elsewhere = NodePath.join(base, "elsewhere");
        NodeFS.mkdirSync(NodePath.join(worktree, "packages", "app"), { recursive: true });
        NodeFS.mkdirSync(elsewhere);
        const dispatched: Array<{ threadId: string; summary: string | undefined; text: string }> =
          [];
        const layer = MemoryGuardNoticesLive.layer.pipe(
          Layer.provide(
            Layer.mock(Orchestrator.OrchestratorV2)({
              dispatch: (command) =>
                Effect.sync(() => {
                  if (command.type !== "message.dispatch") return undefined as never;
                  dispatched.push({
                    threadId: command.threadId,
                    summary: command.notification?.summary,
                    text: command.text,
                  });
                  return undefined as never;
                }),
            }),
          ),
          Layer.provide(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThread: (threadId) =>
                Effect.succeed({
                  id: threadId,
                  projectId: "project-1",
                  worktreePath: worktree,
                  archivedAt: null,
                  deletedAt: null,
                } as never),
              getThreadRecords: () =>
                Effect.succeed({
                  providerThreads: [{ nativeThreadRef: { nativeId: "native-1" } }],
                } as never),
            }),
          ),
          Layer.provide(
            Layer.mock(ProjectService.ProjectService)({
              getById: () => Effect.succeed(Option.none()),
            }),
          ),
          Layer.provide(NodeServices.layer),
        );
        const stopped: StoppedCommand = {
          threadId: "thread-1",
          command: "node",
          cwd: NodePath.join(worktree, "packages", "app"),
          bytes: 3 * 1024 ** 3,
          processes: 9,
          pressure: "critical",
        };

        yield* Effect.gen(function* () {
          const notices = yield* MemoryGuardNotices;
          yield* notices.commandStopped(stopped);
          yield* notices.commandStopped({ ...stopped, cwd: elsewhere });
          yield* notices.commandStopped({ ...stopped, codexThreadId: "native-2" });
          yield* notices.commandStopped({ ...stopped, codexThreadId: "native-1" });
        }).pipe(Effect.provide(layer));

        const notice = {
          threadId: "thread-1",
          summary: "T3 Code stopped node to free memory",
          text: MemoryGuardNoticesLive.memoryGuardNoticeText(stopped),
        };
        expect(dispatched).toEqual([notice, notice]);
        expect(dispatched[0]?.text).toContain("3.0 GB across 9 processes");
      }).pipe(Effect.scoped),
  );
});

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type TerminalOpenInput,
  type TerminalWriteInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as TerminalManager from "../../../terminal/Manager.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as TerminalHandlers from "./handlers.ts";
import { TerminalToolkit } from "./tools.ts";

const callerId = ThreadId.make("terminal-caller");
const worktreeThreadId = ThreadId.make("terminal-worktree-thread");
const projectId = ProjectId.make("project:mcp-test");
const workspaceRoot = "/workspace/project";
const worktreePath = "/workspace/worktrees/feature";

interface TerminalToolInput {
  readonly threadId?: ThreadId;
  readonly cwd?: string;
  readonly env?: TerminalOpenInput["env"];
  readonly command?: string;
  readonly terminalId?: string;
}

interface Options {
  readonly callerMode?: RuntimeMode;
  readonly capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>;
}

const openTerminal = (input: TerminalToolInput, options: Options = {}) =>
  Effect.gen(function* () {
    const calls: Array<
      | { readonly kind: "open"; readonly input: TerminalOpenInput }
      | { readonly kind: "write"; readonly input: TerminalWriteInput }
    > = [];
    const shells = new Map([
      [callerId, liveThreadShell(callerId, { runtimeMode: options.callerMode ?? "full-access" })],
      [worktreeThreadId, { ...liveThreadShell(worktreeThreadId), worktreePath }],
    ]);
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId: EnvironmentId.make("terminal-environment"),
      requestNamespace: "terminal-provider-session",
      thread: {
        threadId: callerId,
        providerSessionId: "terminal-provider-session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(options.capabilities ?? ["orchestration"]),
      issuedAt: 0,
    };
    const dependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
        getProjectThreadRecords: ({ threadId }) =>
          Effect.succeed({ thread: shells.get(threadId) } as never),
      }),
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.succeed(
            id === projectId ? Option.some({ id, workspaceRoot } as never) : Option.none(),
          ),
      }),
      Layer.mock(TerminalManager.TerminalManager)({
        open: (openInput) => {
          calls.push({ kind: "open", input: openInput });
          return Effect.succeed({
            threadId: openInput.threadId,
            terminalId: openInput.terminalId,
            cwd: openInput.cwd,
            worktreePath: openInput.worktreePath ?? null,
            status: "running",
            pid: 4242,
            history: "",
            exitCode: null,
            exitSignal: null,
            label: openInput.terminalId,
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
        },
        write: (writeInput) => {
          calls.push({ kind: "write", input: writeInput });
          return Effect.void;
        },
      }),
      NodeCrypto.layer,
      NodeServices.layer,
    );
    const toolkit = yield* TerminalToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(TerminalHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const result = yield* toolkit
      .handle("t3_terminal_open", input)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    return { result: result.at(-1)?.result, calls };
  });

it.effect("opens a terminal for the calling thread in its workspace by default", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const { result, calls } = yield* openTerminal({});
    expect(calls).toHaveLength(1);
    const open = calls[0]!;
    expect(open.kind).toBe("open");
    expect(open.input).toMatchObject({
      threadId: callerId,
      cwd: path.resolve(workspaceRoot),
      worktreePath: null,
      env: { T3CODE_PROJECT_ROOT: workspaceRoot },
    });
    expect(open.input.terminalId).toMatch(/^agent-[0-9a-f]{8}$/);
    expect(result).toEqual({
      threadId: callerId,
      terminalId: open.input.terminalId,
      cwd: path.resolve(workspaceRoot),
      pid: 4242,
      status: "running",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("passes cwd and env through and types the command after opening", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const { result, calls } = yield* openTerminal({
      threadId: worktreeThreadId,
      cwd: "packages/app",
      env: { FOO: "bar" },
      command: "echo hello",
      terminalId: "login",
    });
    const cwd = path.resolve(worktreePath, "packages/app");
    expect(calls).toEqual([
      {
        kind: "open",
        input: {
          threadId: worktreeThreadId,
          terminalId: "login",
          cwd,
          worktreePath,
          env: {
            T3CODE_PROJECT_ROOT: workspaceRoot,
            T3CODE_WORKTREE_PATH: worktreePath,
            FOO: "bar",
          },
        },
      },
      {
        kind: "write",
        input: { threadId: worktreeThreadId, terminalId: "login", data: " echo hello\r" },
      },
    ]);
    expect(result).toMatchObject({ threadId: worktreeThreadId, terminalId: "login", cwd });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("accepts an absolute cwd inside the project root for a worktree thread", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const cwd = path.resolve(workspaceRoot, "docs");
    const { calls } = yield* openTerminal({ threadId: worktreeThreadId, cwd });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "open", input: { cwd } });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { name: "a relative escape", cwd: "../elsewhere" },
  { name: "an unrelated absolute path", cwd: "/somewhere/else" },
])("rejects $name as cwd without opening a terminal", ({ cwd }) =>
  Effect.gen(function* () {
    const { result, calls } = yield* openTerminal({ cwd });
    expect(result).toMatchObject({ code: "invalid_request" });
    expect(calls).toEqual([]);
  }),
);

it.effect("rejects an unknown thread", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* openTerminal({ threadId: ThreadId.make("missing-thread") });
    expect(result).toMatchObject({ code: "thread_not_found" });
    expect(calls).toEqual([]);
  }),
);

it.effect("rejects callers that are not full-access", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* openTerminal({}, { callerMode: "approval-required" });
    expect(result).toMatchObject({ code: "capability_denied" });
    expect(calls).toEqual([]);
  }),
);

it.effect("rejects credentials without orchestration capability", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* openTerminal({}, { capabilities: [] });
    expect(result).toMatchObject({ code: "capability_denied" });
    expect(calls).toEqual([]);
  }),
);

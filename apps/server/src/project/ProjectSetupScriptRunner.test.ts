import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type TerminalEvent,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Queue from "effect/Queue";
import { TestClock } from "effect/testing";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectScriptPorts from "./ProjectScriptPorts.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

it.effect("ReservedScript-overlappingStarts-reusesOwnerAndRetriesAfterCompletionOrFailure", () =>
  Effect.gen(function* () {
    const opening = yield* Deferred.make<void>();
    const releaseOpen = yield* Deferred.make<void>();
    const writing = yield* Deferred.make<void>();
    let writeGate: Deferred.Deferred<void> | null = null;
    const listeners = new Set<
      Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0]
    >();
    const publish = (event: TerminalEvent) =>
      Effect.forEach([...listeners], (listener) => listener(event), { discard: true });
    let openCount = 0;
    const openRequests: Array<Parameters<TerminalManager.TerminalManager["Service"]["open"]>[0]> =
      [];
    let failWrite = false;
    let exitBeforeSubscribe = false;
    let terminalExited = false;
    const writes: string[] = [];
    let outputWritten: Deferred.Deferred<void> | undefined;
    const projectId = ProjectId.make("project:reserved-runner");
    const script = {
      id: "preview",
      name: "Preview",
      command: "vp dev",
      icon: "play" as const,
      runOnWorktreeCreate: true,
      runOnSettle: true,
      previewUrl: "http://localhost:${T3CODE_PREVIEW_PORT}",
      async: false,
    };
    const project = {
      id: projectId,
      title: "Project",
      workspaceRoot: "/repo",
      repositoryIdentity: null,
      faviconPath: null,
      defaultModelSelection: null,
      scripts: [script],
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
      deletedAt: null,
    };
    const input = {
      threadId: ThreadId.make("thread-owner"),
      projectId,
      worktreePath: "/repo-worktree",
      scriptId: script.id,
    };
    const layer = ProjectSetupScriptRunner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeedSome(project),
          }),
          Layer.mock(ProjectScriptPorts.ProjectScriptPorts)({
            reserve: () => Effect.succeed(43123),
          }),
          Layer.mock(TerminalManager.TerminalManager)({
            open: (request) =>
              Effect.gen(function* () {
                openRequests.push(request);
                if (openCount++ === 0) {
                  yield* Deferred.succeed(opening, undefined);
                  yield* Deferred.await(releaseOpen);
                }
                terminalExited = exitBeforeSubscribe;
                if (terminalExited) {
                  yield* publish({
                    type: "exited",
                    threadId: request.threadId,
                    terminalId: request.terminalId,
                    exitCode: 1,
                    exitSignal: null,
                  });
                }
                yield* publish({
                  type: "output",
                  threadId: request.threadId,
                  terminalId: request.terminalId,
                  data: "% \x1b[?2004h",
                });
                return {
                  ...request,
                  worktreePath: request.worktreePath ?? null,
                  status: "running" as const,
                  pid: 123,
                  history: "",
                  exitCode: null,
                  exitSignal: null,
                  label: "Shell",
                  updatedAt: project.createdAt,
                };
              }),
            write: (request) =>
              Effect.gen(function* () {
                assert.equal(
                  request.expectedPid,
                  request.terminalId.startsWith("script-") ? 123 : undefined,
                );
                assert.match(request.data, /^ \S/);
                if (terminalExited) {
                  return yield* new TerminalManager.TerminalNotRunningError({
                    threadId: request.threadId,
                    terminalId: request.terminalId,
                  });
                }
                if (failWrite) {
                  return yield* new TerminalManager.TerminalWriteError({
                    threadId: request.threadId,
                    terminalId: request.terminalId,
                    terminalPid: 123,
                    cause: new Error("write failed"),
                  });
                }
                writes.push(request.data);
                if (outputWritten) yield* Deferred.succeed(outputWritten, undefined);
                const pendingWrite = writeGate;
                if (pendingWrite) {
                  yield* Deferred.succeed(writing, undefined);
                  yield* Deferred.await(pendingWrite);
                }
              }),
            subscribe: (listener) =>
              Effect.sync(() => {
                listeners.add(listener);
                return () => listeners.delete(listener);
              }),
            closeIdle: () => Effect.void,
          }),
          ServerSettings.layerTest(),
          NodeCrypto.layer,
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const first = yield* runner.runScript(input).pipe(Effect.forkChild);
      yield* Deferred.await(opening);
      const contenders = yield* Effect.all(
        [
          runner.runScript({ ...input, threadId: ThreadId.make("thread-other") }),
          runner.runForThread({
            threadId: input.threadId,
            projectId,
            worktreePath: input.worktreePath,
            trigger: "settle",
            observeCompletion: {},
          }),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* Deferred.succeed(releaseOpen, undefined);
      const started = yield* Fiber.join(first);
      const [otherThread, lifecycle] = yield* Fiber.join(contenders);
      assert.deepEqual(started, {
        status: "started",
        threadId: input.threadId,
        terminalId: "script-43123",
        port: 43123,
      });
      assert.deepEqual(otherThread, started);
      assert.equal(openCount, 1);
      assert.equal(writes.length, 1);
      assert.equal(lifecycle.status, "started");
      if (lifecycle.status !== "started") return;
      assert.equal(lifecycle.async, false);
      assert.deepEqual(
        yield* runner.runForThread({
          threadId: "thread-other",
          projectId,
          worktreePath: input.worktreePath,
          trigger: "settle",
        }),
        { status: "no-script" },
      );

      const token = /__T3_SETUP_DONE___(\w+):/.exec(writes[0]!)![1];
      yield* publish({
        type: "output",
        threadId: input.threadId,
        terminalId: "script-43123",
        data: `\r\n__T3_SETUP_DONE___${token}:0\r\n$ `,
      });
      assert.equal((yield* lifecycle.completion!).exitCode, 0);
      assert.equal(listeners.size, 0);
      failWrite = true;
      assert.equal(
        (yield* runner.runScript(input).pipe(Effect.flip))._tag,
        "ProjectSetupScriptOperationError",
      );
      assert.equal(listeners.size, 0);
      failWrite = false;
      assert.deepEqual(yield* runner.runScript(input), started);
      assert.equal(openCount, 3);
      assert.equal(writes.length, 2);

      const restarted = yield* runner.runForThread({
        threadId: input.threadId,
        projectId,
        worktreePath: input.worktreePath,
      });
      yield* publish({
        type: "restarted",
        threadId: input.threadId,
        terminalId: "script-43123",
        snapshot: {
          threadId: input.threadId,
          terminalId: "script-43123",
          cwd: input.worktreePath,
          worktreePath: input.worktreePath,
          status: "running",
          pid: 456,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "Shell",
          updatedAt: project.createdAt,
        },
      });
      assert.equal(restarted.status, "started");
      if (restarted.status === "started") {
        assert.equal((yield* restarted.completion!).exitCode, null);
      }
      assert.equal(listeners.size, 0);

      writeGate = yield* Deferred.make<void>();
      const disconnected = yield* runner.runScript(input).pipe(Effect.forkChild);
      yield* Deferred.await(writing);
      const interruption = yield* Fiber.interrupt(disconnected).pipe(Effect.forkChild);
      yield* Deferred.succeed(writeGate, undefined);
      yield* Fiber.join(interruption);
      writeGate = null;
      const writtenBeforeRetry = writes.length;
      assert.deepEqual(yield* runner.runScript(input), started);
      assert.equal(writes.length, writtenBeforeRetry);
      const interruptedRun = yield* runner.runForThread({
        threadId: input.threadId,
        projectId,
        worktreePath: input.worktreePath,
      });
      yield* publish({
        type: "exited",
        threadId: input.threadId,
        terminalId: "script-43123",
        exitCode: 0,
        exitSignal: null,
      });
      if (interruptedRun.status === "started") yield* interruptedRun.completion!;

      exitBeforeSubscribe = true;
      const lostExit = yield* runner.runScript(input).pipe(Effect.flip);
      assert.equal(lostExit._tag, "ProjectSetupScriptOperationError");
      if (lostExit._tag === "ProjectSetupScriptOperationError") {
        assert.equal(lostExit.operation, "writeCommand");
      }
      assert.equal(listeners.size, 0);
      exitBeforeSubscribe = false;

      yield* runner.runScript({ ...input, worktreePath: null });
      assert.deepEqual(openRequests.at(-1), {
        threadId: input.threadId,
        terminalId: "script-43123",
        cwd: project.workspaceRoot,
        worktreePath: null,
        env: {
          T3CODE_PROJECT_ROOT: project.workspaceRoot,
          T3CODE_PREVIEW_PORT: "43123",
        },
      });

      script.previewUrl = "http://localhost:5173";
      const outputLines: string[] = [];
      outputWritten = yield* Deferred.make<void>();
      const observed = yield* runner.runForThread({
        threadId: input.threadId,
        projectId,
        worktreePath: input.worktreePath,
        preferredTerminalId: "setup-output",
        observeCompletion: {
          onOutputLine: (line) =>
            Effect.sync(() => {
              outputLines.push(line);
            }),
        },
      });
      assert.equal(observed.status, "started");
      if (observed.status !== "started") return;
      yield* Deferred.await(outputWritten);
      const wrapper = writes.at(-1)!;
      const outputToken = /__T3_SETUP_DONE___(\w+):/.exec(wrapper)![1];
      yield* publish({
        type: "output",
        threadId: input.threadId,
        terminalId: "setup-output",
        data: `${wrapper}\r\n% (\r\nsubsh> )\r\nReady (vite)\r\nBuild complete ( 42 files )\r\nbackend\r\n__T3_SETUP_DONE___${outputToken}:0\r\n$ `,
      });
      assert.equal((yield* observed.completion!).exitCode, 0);
      assert.deepEqual(outputLines, ["Ready (vite)", "Build complete ( 42 files )", "backend"]);
    }).pipe(Effect.provide(layer));
    assert.equal(listeners.size, 0);
  }),
);

const threadId = "thread-1";
const terminalId = "setup-setup";
const event = { threadId, terminalId, sequence: 1, createdAt: "2026-01-01T00:00:00.000Z" };

const openSnapshot = (history: string): TerminalSessionSnapshot => ({
  threadId,
  terminalId,
  cwd: "/repo/.t3/worktrees/feature",
  worktreePath: null,
  status: "running",
  pid: 123,
  history,
  exitCode: null,
  exitSignal: null,
  label: "zsh",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const makeHarness = Effect.fn(function* (options: {
  readonly history?: string;
  readonly opening?: Deferred.Deferred<void>;
  readonly reserved?: boolean;
}) {
  let currentPid = 123;
  let openCount = 0;
  const scriptTerminalId = options.reserved ? "script-43123" : terminalId;
  const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const writes = yield* Queue.unbounded<string>();
  const outputLines = yield* Queue.unbounded<string>();
  const terminals = Layer.mock(TerminalManager.TerminalManager)({
    open: () => {
      openCount += 1;
      return (
        options.opening
          ? Deferred.succeed(options.opening, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.void
      ).pipe(Effect.as({ ...openSnapshot(options.history ?? ""), terminalId: scriptTerminalId }));
    },
    subscribe: (listener) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    write: (input) =>
      input.expectedPid !== undefined && input.expectedPid !== currentPid
        ? Effect.fail(
            new TerminalManager.TerminalNotRunningError({ threadId, terminalId: scriptTerminalId }),
          )
        : Queue.offer(writes, input.data).pipe(Effect.asVoid),
    closeIdle: () => Effect.void,
  });
  const project = {
    id: ProjectId.make("project-1"),
    workspaceRoot: "/repo",
    title: "Project",
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: null,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    deletedAt: null,
    scripts: [
      {
        id: "setup",
        name: "Setup",
        command: "vp i",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
        ...(options.reserved ? { previewUrl: "http://localhost:${T3CODE_PREVIEW_PORT}" } : {}),
      },
    ],
  };
  const runner = yield* ProjectSetupScriptRunner.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        terminals,
        Layer.mock(ProjectScriptPorts.ProjectScriptPorts)({ reserve: () => Effect.succeed(43123) }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome(project),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () => Effect.succeed(null),
        }),
        ServerSettings.layerTest(),
        NodeCrypto.layer,
      ),
    ),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.Environment, { SHELL: "/bin/zsh" }),
  );
  const start = runner.runForThread({
    threadId,
    worktreePath: "/repo/.t3/worktrees/feature",
    observeCompletion: { onOutputLine: (line) => Queue.offer(outputLines, line) },
    project,
  });
  const emit = (terminalEvent: TerminalEvent) => {
    if (terminalEvent.type === "restarted") currentPid = terminalEvent.snapshot.pid!;
    return Effect.forEach([...listeners], (listener) => listener(terminalEvent), { discard: true });
  };
  return {
    start,
    listeners,
    writes,
    outputLines,
    emit,
    openCount: () => openCount,
    runManual: runner.runScript({
      threadId: ThreadId.make(threadId),
      projectId: ProjectId.make("project-1"),
      worktreePath: "/repo/.t3/worktrees/feature",
      scriptId: "setup",
    }),
    event: { ...event, terminalId: scriptTerminalId },
  };
});

const setup = Effect.fn(function* (options: { readonly history?: string } = {}) {
  const harness = yield* makeHarness(options);
  const result = yield* harness.start;
  const completion = result.status === "started" ? result.completion : undefined;
  if (!completion) return yield* Effect.die("setup did not start an observed run");
  return { ...harness, result, completion };
});

describe("ProjectSetupScriptRunner", () => {
  it.effect(
    "shares a reserved launch while startup waits and reports delivery to manual callers",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ reserved: true });
        const result = yield* harness.start;
        expect(result.status).toBe("started");
        yield* harness.emit({ ...harness.event, type: "output", data: "Install Node? [y/N]: " });
        yield* harness.emit({
          ...harness.event,
          type: "activity",
          hasRunningSubprocess: true,
          label: "fnm",
        });
        const manual = yield* harness.runManual.pipe(Effect.forkChild);
        yield* TestClock.adjust("1 minute");
        expect(harness.openCount()).toBe(1);
        expect(yield* Queue.size(harness.writes)).toBe(0);
        expect(manual.pollUnsafe()).toBeUndefined();
        expect(yield* Queue.takeAll(harness.outputLines)).toEqual(["Install Node? [y/N]:"]);
        yield* harness.emit({ ...harness.event, type: "output", data: "\r\n% \x1b[?2004h" });
        const command = yield* Queue.take(harness.writes);
        expect(yield* Fiber.join(manual)).toMatchObject({ status: "started", port: 43123 });
        const token = /__T3_SETUP_DONE___(\w+):/.exec(command)![1];
        yield* harness.emit({
          ...harness.event,
          type: "output",
          data: `\r\n__T3_SETUP_DONE___${token}:0\r\n$ `,
        });
        if (result.status === "started") expect((yield* result.completion!).exitCode).toBe(0);
        expect(harness.listeners.size).toBe(0);
      }),
  );

  it.effect("rejects a reserved command if its terminal is replaced during startup", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ reserved: true });
      const result = yield* harness.start;
      yield* harness.emit({
        ...harness.event,
        type: "restarted",
        snapshot: { ...openSnapshot(""), pid: 456 },
      });
      yield* harness.emit({ ...harness.event, type: "output", data: "% \x1b[?2004h" });
      if (result.status !== "started") return;
      const failure = yield* result.commandDelivery!.pipe(Effect.flip);
      expect(failure.operation).toBe("writeCommand");
      expect((yield* result.completion!).exitCode).toBeNull();
      expect(yield* Queue.size(harness.writes)).toBe(0);
      expect(harness.listeners.size).toBe(0);
    }),
  );

  it.effect("shows a startup prompt and types only once the line editor starts", () =>
    Effect.gen(function* () {
      const { result, writes, outputLines, emit } = yield* setup();
      expect(result).toMatchObject({ status: "started", terminalId });

      yield* emit({ ...event, type: "output", data: "Missing Node.\r\nInstall it? [y/N]: " });
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
      expect(yield* Queue.takeAll(outputLines)).toEqual(["Missing Node.", "Install it? [y/N]:"]);

      yield* emit({ ...event, type: "activity", hasRunningSubprocess: false, label: "zsh" });
      yield* emit({ ...event, type: "output", data: "\r\n% \x1b[?2004h" });
      expect(yield* Queue.take(writes)).toMatch(/^ \(\rtrap 'exit 130' INT\r/);
    }),
  );

  it.effect("types into a quiet shell that has no line editor", () =>
    Effect.gen(function* () {
      const { writes } = yield* setup();
      yield* TestClock.adjust("3 seconds");
      expect(yield* Queue.take(writes)).toMatch(/^ \(\rtrap 'exit 130' INT\r/);
    }),
  );

  it.effect("ignores line editor state restored from an earlier shell", () =>
    Effect.gen(function* () {
      const { writes, emit } = yield* setup({ history: "old run\r\n% \x1b[?2004h" });
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
    }),
  );

  it.effect("forgets a busy startup child when the shell restarts", () =>
    Effect.gen(function* () {
      const { writes, emit } = yield* setup();
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
      yield* emit({ ...event, type: "restarted", snapshot: openSnapshot("") });
      // The restart lands inside a quiet window, so the next full window decides.
      yield* TestClock.adjust("6 seconds");
      expect(yield* Queue.take(writes)).toMatch(/^ \(\rtrap 'exit 130' INT\r/);
    }),
  );

  it.effect("drops its terminal listeners when cancelled while the terminal opens", () =>
    Effect.gen(function* () {
      const opening = yield* Deferred.make<void>();
      const { start, listeners } = yield* makeHarness({ opening });
      const fiber = yield* Effect.forkChild(start);
      yield* Deferred.await(opening);
      expect(listeners.size).toBe(2);
      yield* Fiber.interrupt(fiber);
      expect(listeners.size).toBe(0);
    }),
  );

  it.effect("does not type into a shell that exits during startup", () =>
    Effect.gen(function* () {
      const { completion, writes, emit } = yield* setup();
      yield* emit({ ...event, type: "exited", exitCode: 1, exitSignal: null });
      expect(yield* completion).toMatchObject({ exitCode: null });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
    }),
  );
});

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  TerminalRunAndSendError,
  type OrchestrationV2ServerCommand,
  type TerminalEvent,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { OrchestratorCommandRejectedError } from "../orchestration-v2/Orchestrator.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Manager from "./Manager.ts";
import * as RunAndSend from "./RunAndSend.ts";

type Scripts = Parameters<Manager.TerminalManager["Service"]["openForCommand"]>[1];
const input = {
  threadId: "original-thread",
  terminalId: "command-1",
  command: "printf test",
  cwd: "/tmp",
  worktreePath: null,
};
const snapshot: TerminalSessionSnapshot = {
  ...input,
  status: "running",
  pid: 1,
  history: "",
  exitCode: null,
  exitSignal: null,
  label: "Shell",
  updatedAt: "2026-10-16T00:00:00.000Z",
};
const baseLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
);

const harness = Effect.fn(function* (
  options: {
    shell?: string;
    failDispatch?: () => boolean;
    failOpen?: boolean;
    worktreePath?: string | null;
  } = {},
) {
  const attempts = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
  const delivered = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
  const notice = yield* Deferred.make<void>();
  const opened = yield* Deferred.make<void>();
  const listeners = new Set<Parameters<Manager.TerminalManager["Service"]["subscribe"]>[0]>();
  let scripts: Scripts | undefined;
  let openCount = 0;
  let closeCount = 0;
  const emit = (event: TerminalEvent) =>
    Effect.forEach([...listeners], (listener) => listener(event), { discard: true });
  const mockManager = Layer.mock(Manager.TerminalManager)({
    subscribe: (listener) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }),
    openForCommand: (_input, supplied) =>
      Effect.gen(function* () {
        scripts = supplied;
        openCount++;
        yield* Deferred.succeed(opened, undefined);
        if (options.failOpen)
          return yield* new TerminalRunAndSendError({
            ...input,
            operation: "open",
            cause: "failed",
          });
        return snapshot;
      }),
    close: () =>
      Effect.sync(() => {
        closeCount++;
      }),
    reportDeliveryError: () => Deferred.succeed(notice, undefined).pipe(Effect.asVoid),
  });
  let managerLayer: Layer.Layer<Manager.TerminalManager> = mockManager;
  let realManager: Manager.TerminalManager["Service"] | undefined;
  if (options.shell) {
    const fs = yield* FileSystem.FileSystem;
    const logsDir = yield* fs.makeTempDirectoryScoped({ prefix: "run-send-test-" });
    const adapter = yield* NodePtyAdapter.make();
    realManager = yield* Manager.makeWithOptions({
      logsDir,
      ptyAdapter: adapter,
      shellResolver: () => options.shell!,
      processKillGraceMs: 20,
    });
    managerLayer = Layer.succeed(Manager.TerminalManager, realManager);
  }
  const layer = RunAndSend.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        managerLayer,
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed(
              id === input.threadId
                ? { ...liveThreadShell(id), worktreePath: options.worktreePath ?? null }
                : null,
            ),
          dispatch: (command) =>
            Effect.gen(function* () {
              yield* Queue.offer(attempts, command);
              if (options.failDispatch?.())
                return yield* new OrchestratorCommandRejectedError({
                  commandId: command.commandId,
                  commandType: command.type,
                });
              yield* Queue.offer(delivered, command);
              return { sequence: 1, storedEvents: [] };
            }),
        }),
        Layer.mock(Projects.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({
                id: ProjectId.make("project:mcp-test"),
                title: "Project",
                workspaceRoot: "/tmp",
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-10-16T00:00:00.000Z",
                updatedAt: "2026-10-16T00:00:00.000Z",
                deletedAt: null,
              }),
            ),
        }),
      ),
    ),
  );
  return {
    layer,
    attempts,
    delivered,
    notice,
    opened,
    emit,
    listeners,
    get scripts() {
      return scripts!;
    },
    get openCount() {
      return openCount;
    },
    get closeCount() {
      return closeCount;
    },
    realManager,
  };
});

const markerToken = (scripts: Scripts) => /'([a-f0-9]+):start'/.exec(scripts.posix)![1]!;
const output = (data: string): TerminalEvent => ({ ...input, type: "output", data });
const frame = (token: string, kind: string) => `\x1b]99999;t3:${token}:${kind}\x07`;
const messageText = (command: OrchestrationV2ServerCommand) => {
  assert.strictEqual(command.type, "message.dispatch");
  if (command.type !== "message.dispatch") throw new Error("Unexpected command");
  return command.text;
};

it.effect(
  "captures split markers, blank and long lines, ANSI and no final newline exactly once",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Effect.gen(function* () {
        const service = yield* RunAndSend.TerminalRunAndSend;
        yield* service.run(input);
        const token = markerToken(h.scripts);
        yield* h.emit(output("prompt and echoed wrapper\r\n" + frame(token, "start").slice(0, 12)));
        const text = "\n\n" + "x".repeat(9000) + "\nlast";
        yield* h.emit(output(frame(token, "start").slice(12) + "\x1b[3"));
        yield* h.emit(output("1m" + text + "\x1b[0m" + frame(token, "done:7").slice(0, 15)));
        yield* h.emit(output(frame(token, "done:7").slice(15) + "prompt noise"));
        const command = yield* Queue.take(h.delivered);
        assert.strictEqual(
          messageText(command),
          `Terminal command: ${input.command}\nWorking directory: /tmp\nStatus: completed\nExit code: 7\nOutput:\n${text}`,
        );
        if (command.type === "message.dispatch") {
          assert.deepEqual(command.dispatchMode, { type: "queue_after_active" });
          assert.strictEqual(command.createdBy, "user");
          assert.strictEqual(command.threadId, input.threadId);
        }
        assert.strictEqual(h.listeners.size, 0);
        assert.strictEqual((yield* service.run(input)).status, "already_started");
        assert.strictEqual(h.openCount, 1);
        assert.strictEqual(yield* Queue.size(h.delivered), 0);
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.effect.each([
  ["DCS", "\x1bP", "\x1b\\"],
  ["SOS", "\x1bX", "\x1b\\"],
  ["PM", "\x1b^", "\x1b\\"],
  ["APC", "\x1b_", "\x1b\\"],
  ["C1 DCS", "\x90", "\x9c"],
  ["C1 SOS", "\x98", "\x9c"],
  ["C1 PM", "\x9e", "\x9c"],
  ["C1 APC", "\x9f", "\x9c"],
  ["C1 OSC", "\x9d", "\x9c"],
  ["OSC with C1 ST", "\x1b]", "\x9c"],
  ["C1 OSC with ESC ST", "\x9d", "\x1b\\"],
  ["C1 OSC with BEL", "\x9d", "\x07"],
])("strips split %j control strings through the service", ([, begin, end]) =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* (yield* RunAndSend.TerminalRunAndSend).run(input);
      const token = markerToken(h.scripts);
      const raw =
        frame(token, "start") +
        "\n\tbefore\r\n" +
        begin +
        "private-terminal-payload" +
        end +
        "\x9b31mred\x9b0m\x9c\nlast" +
        frame(token, "done:7");
      for (const char of raw) yield* h.emit(output(char));
      assert.strictEqual(
        messageText(yield* Queue.take(h.delivered)),
        `Terminal command: ${input.command}\nWorking directory: /tmp\nStatus: completed\nExit code: 7\nOutput:\n\n\tbefore\nred\nlast`,
      );
      assert.strictEqual(h.listeners.size, 0);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.effect("strips split ESC intermediate sequences without leaking their final bytes", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* (yield* RunAndSend.TerminalRunAndSend).run(input);
      const token = markerToken(h.scripts);
      const raw =
        frame(token, "start") + "before\x1b#8\x1b%G\x1b(B\x1b !pafter" + frame(token, "done:0");
      for (const char of raw) yield* h.emit(output(char));
      assert.strictEqual(
        messageText(yield* Queue.take(h.delivered)),
        `Terminal command: ${input.command}\nWorking directory: /tmp\nStatus: completed\nExit code: 0\nOutput:\nbeforeafter`,
      );
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.effect.each(["\x1bP", "\x1bX", "\x1b^", "\x1b_", "\x90", "\x98", "\x9e", "\x9f", "\x9d"])(
  "bounds unterminated control string %j without hiding exact completion framing",
  (begin) =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Effect.gen(function* () {
        yield* (yield* RunAndSend.TerminalRunAndSend).run(input);
        const token = markerToken(h.scripts);
        const otherToken = (token[0] === "a" ? "b" : "a") + token.slice(1);
        yield* h.emit(output(frame(token, "start") + "visible" + frame(otherToken, "done:99")));
        assert.strictEqual(yield* Queue.size(h.delivered), 0);
        yield* h.emit(output(begin + "private-payload".repeat(100_000)));
        assert.strictEqual(yield* Queue.size(h.delivered), 0);
        const completion = frame(token, "done:3");
        yield* h.emit(output(completion.slice(0, -1)));
        assert.strictEqual(yield* Queue.size(h.delivered), 0);
        yield* h.emit(output(completion.slice(-1)));
        assert.strictEqual(
          messageText(yield* Queue.take(h.delivered)),
          `Terminal command: ${input.command}\nWorking directory: /tmp\nStatus: completed\nExit code: 3\nOutput:\nvisible`,
        );
        assert.strictEqual(h.listeners.size, 0);
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.effect("bounds flood while still recognizing completion past the output limit", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* (yield* RunAndSend.TerminalRunAndSend).run(input);
      const token = markerToken(h.scripts);
      yield* h.emit(
        output(frame(token, "start") + "x".repeat(1024 * 1024) + frame(token, "done:0")),
      );
      const text = messageText(yield* Queue.take(h.delivered));
      assert.include(text, "truncated at 131072 characters");
      assert.strictEqual(
        text.split("Output (truncated at 131072 characters):\n")[1]!.length,
        131072,
      );
      assert.strictEqual(h.listeners.size, 0);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.effect.each(["closed", "exited", "error"] as const)(
  "sends explicit %s without a completion marker",
  (kind) =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Effect.gen(function* () {
        yield* (yield* RunAndSend.TerminalRunAndSend).run(input);
        yield* h.emit(output(frame(markerToken(h.scripts), "start") + "partial"));
        yield* h.emit(
          kind === "closed"
            ? { ...input, type: kind }
            : kind === "error"
              ? { ...input, type: kind, message: "error" }
              : { ...input, type: kind, exitCode: 7, exitSignal: null },
        );
        const text = messageText(yield* Queue.take(h.delivered));
        assert.include(
          text,
          kind === "exited"
            ? "Status: exited_without_completion\nExit code: 7"
            : `Status: ${kind}\nExit code: unknown`,
        );
        assert.isTrue(text.endsWith("partial"));
        assert.strictEqual(h.listeners.size, 0);
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.effect("concurrent duplicate identity executes once and collisions fail", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      const service = yield* RunAndSend.TerminalRunAndSend;
      const results = yield* Effect.all([service.run(input), service.run(input)], {
        concurrency: "unbounded",
      });
      assert.deepEqual(
        results.map((result) => result.status),
        ["started", "already_started"],
      );
      assert.strictEqual(h.openCount, 1);
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(service.run({ ...input, command: "another" }))),
      );
      yield* h.emit({ ...input, type: "closed" });
      yield* Queue.take(h.delivered);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.effect("validates original destination workspace before opening a process", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      const service = yield* RunAndSend.TerminalRunAndSend;
      for (const bad of [
        { ...input, cwd: "/elsewhere" },
        { ...input, terminalId: "other", worktreePath: "/tmp" },
        { ...input, threadId: "missing" },
      ])
        assert.isTrue(Exit.isFailure(yield* Effect.exit(service.run(bad))));
      assert.strictEqual(h.openCount, 0);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.effect("startup failure removes listeners and never reruns the reserved identity", () =>
  Effect.gen(function* () {
    const h = yield* harness({ failOpen: true });
    yield* Effect.gen(function* () {
      const service = yield* RunAndSend.TerminalRunAndSend;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(service.run(input))));
      assert.strictEqual(h.listeners.size, 0);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(service.run(input))));
      assert.strictEqual(h.openCount, 1);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.effect("retains failed delivery and retries stable IDs without reexecuting", () =>
  Effect.gen(function* () {
    let reject = true;
    const h = yield* harness({ failDispatch: () => reject });
    yield* Effect.gen(function* () {
      const service = yield* RunAndSend.TerminalRunAndSend;
      yield* service.run(input);
      yield* h.emit(
        output(
          frame(markerToken(h.scripts), "start") +
            "result" +
            frame(markerToken(h.scripts), "done:0"),
        ),
      );
      const first = yield* Queue.take(h.attempts);
      for (const delay of [100, 200, 400, 800]) {
        yield* TestClock.adjust(delay);
        yield* Queue.take(h.attempts);
      }
      yield* Deferred.await(h.notice);
      reject = false;
      yield* service.run(input);
      const second = yield* Queue.take(h.delivered);
      assert.deepEqual(first, second);
      assert.strictEqual(h.openCount, 1);
      assert.strictEqual(h.listeners.size, 0);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.effect("timeout closes its command terminal and sends explicit unknown exit", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* (yield* RunAndSend.TerminalRunAndSend).run(input);
      yield* TestClock.adjust("24 hours");
      const text = messageText(yield* Queue.take(h.delivered));
      assert.include(text, "Status: timed_out\nExit code: unknown");
      assert.strictEqual(h.closeCount, 1);
      assert.strictEqual(h.listeners.size, 0);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.effect("request fiber ending does not cancel capture; service scope ending closes it", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* RunAndSend.TerminalRunAndSend;
        const request = yield* service.run(input).pipe(Effect.forkChild);
        yield* Fiber.join(request);
        yield* Fiber.interrupt(request);
        assert.strictEqual(h.listeners.size, 1);
      }).pipe(Effect.provide(h.layer)),
    );
    assert.strictEqual(h.closeCount, 1);
    assert.strictEqual(h.listeners.size, 0);
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.live.each(["/bin/bash", "/bin/zsh", "/opt/homebrew/bin/pwsh"])(
  "actual %s executes immediately, preserves output and reports nonzero",
  (shell) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (!(yield* fs.exists(shell))) return;
      const h = yield* harness({ shell });
      yield* Effect.gen(function* () {
        const service = yield* RunAndSend.TerminalRunAndSend;
        const command = shell.endsWith("pwsh")
          ? '[Console]::Write("a`n`nb"); & /bin/sh -c "exit 7"'
          : "printf 'a\\n\\nb'; false";
        yield* service.run({ ...input, command });
        const text = messageText(yield* Queue.take(h.delivered));
        assert.include(text, `Status: completed\nExit code: ${shell.endsWith("pwsh") ? 7 : 1}`);
        assert.isTrue(text.endsWith("a\n\nb"));
        assert.strictEqual((yield* service.run({ ...input, command })).status, "already_started");
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.scoped, Effect.provide(baseLayer)),
  15_000,
);

it.live(
  "actual PowerShell flushes object output and preserves explicit exit code",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const shell = "/opt/homebrew/bin/pwsh";
      if (!(yield* fs.exists(shell))) return;
      const h = yield* harness({ shell });
      yield* Effect.gen(function* () {
        const service = yield* RunAndSend.TerminalRunAndSend;
        yield* service.run({
          ...input,
          command: '[pscustomobject]@{Name="captured-value";Count=1}',
        });
        const text = messageText(yield* Queue.take(h.delivered));
        assert.include(text, "captured-value");
        assert.include(text, "Status: completed\nExit code: 0");
        yield* service.run({
          ...input,
          terminalId: "exit-7",
          command: 'Write-Output "hello"; exit 7',
        });
        const exit = messageText(yield* Queue.take(h.delivered));
        assert.include(exit, "Status: completed\nExit code: 7");
        assert.include(exit, "hello");
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.scoped, Effect.provide(baseLayer)),
  15_000,
);

it.live.each(["/bin/bash", "/bin/zsh", "/opt/homebrew/bin/pwsh"])(
  "actual %s closes command stdin",
  (shell) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (!(yield* fs.exists(shell))) return;
      const h = yield* harness({ shell });
      yield* Effect.gen(function* () {
        const service = yield* RunAndSend.TerminalRunAndSend;
        const command = shell.endsWith("pwsh")
          ? `& /bin/sh -c 'read data; printf "read:%s" "$?"'`
          : `read data; printf 'read:%s' "$?"`;
        yield* service.run({ ...input, command });
        assert.include(messageText(yield* Queue.take(h.delivered)), "read:1");
        if (shell.endsWith("pwsh")) {
          yield* service.run({ ...input, terminalId: "read-host", command: 'Read-Host "input"' });
          const text = messageText(yield* Queue.take(h.delivered));
          assert.include(text, "Status: completed\nExit code: 1");
        }
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.scoped, Effect.provide(baseLayer)),
  5_000,
);

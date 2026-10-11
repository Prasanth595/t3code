import { describe, expect, it } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeAntigravityCliRuntime, makeStreamingContentParser } from "./AntigravityCliRuntime.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

describe("AntigravityCliRuntime", () => {
  it("initializes and reports antigravity-cli agent info", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const spawner = ChildProcessSpawner.make(
            Effect.fn("test.spawn")(function* () {
              return yield* Effect.die("Should not spawn during initialize");
            }),
          );

          const runtime = yield* makeAntigravityCliRuntime({
            executablePath: "agy",
            cwd: "C:\\test",
            childProcessSpawner: spawner,
          });

          const initResult = yield* runtime.initialize();
          expect(initResult.agentInfo?.name).toBe("antigravity-cli");
          expect(initResult.protocolVersion).toBe(1);
          expect(initResult.agentCapabilities?.loadSession).toBe(true);
        }),
      ),
    );
  });

  it("handles start, stream-json deltas, and multi-turn prompt completion without closing stdin", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const outputQueue = yield* Queue.unbounded<Uint8Array>();
          const exitedDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const receivedInputs: string[] = [];

          const spawner = ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              if (command._tag === "StandardCommand" && command.args[0] === "models") {
                return ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(99),
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                  isRunning: Effect.succeed(false),
                  kill: () => Effect.void,
                  unref: Effect.succeed(Effect.void),
                  stdin: Sink.drain,
                  stdout: Stream.encodeText(
                    Stream.make("gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n"),
                  ),
                  stderr: Stream.empty,
                  all: Stream.empty,
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                });
              }
              return ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(100),
                exitCode: Deferred.await(exitedDeferred),
                isRunning: Deferred.isDone(exitedDeferred).pipe(Effect.map((done) => !done)),
                kill: () =>
                  Deferred.succeed(exitedDeferred, ChildProcessSpawner.ExitCode(0)).pipe(
                    Effect.asVoid,
                  ),
                unref: Effect.succeed(Effect.void),
                stdin: Sink.forEach((bytes: Uint8Array) =>
                  Effect.sync(() => {
                    receivedInputs.push(new TextDecoder().decode(bytes));
                  }),
                ),
                stdout: Stream.fromQueue(outputQueue),
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              });
            }),
          );

          const runtime = yield* makeAntigravityCliRuntime({
            executablePath: "agy",
            cwd: "C:\\test",
            childProcessSpawner: spawner,
          });

          const started = yield* runtime.start();
          expect(started.sessionId).toBeDefined();

          const events: AcpSessionRuntime.AcpSessionRuntimeEvent[] = [];
          yield* Stream.runForEach(runtime.getEvents(), (ev) =>
            Effect.sync(() => {
              events.push(ev);
            }),
          ).pipe(Effect.forkScoped);

          // Simulate agy output: init event
          yield* Queue.offer(
            outputQueue,
            new TextEncoder().encode(
              JSON.stringify({
                event: "init",
                conversation_id: "conv-1234",
                init: { tools: ["run_command", "view_file"] },
              }) + "\n",
            ),
          );

          // === Turn 1 ===
          const promptFiber1 = yield* runtime
            .prompt({
              prompt: [{ type: "text", text: "Turn 1 question" }],
            })
            .pipe(Effect.forkScoped);

          yield* Effect.sleep("50 millis");
          expect(receivedInputs.length).toBe(1);
          expect(receivedInputs[0]).toContain('"content":"Turn 1 question"');

          yield* Queue.offer(
            outputQueue,
            new TextEncoder().encode(
              JSON.stringify({
                event: "step_update",
                step_update: {
                  step_index: 1,
                  step_type: "agent_response",
                  text_delta: "Turn 1 answer",
                },
              }) + "\n",
            ),
          );

          yield* Queue.offer(
            outputQueue,
            new TextEncoder().encode(
              JSON.stringify({
                event: "result",
                result: {
                  conversation_id: "conv-1234",
                  status: "SUCCESS",
                  response: "Turn 1 answer",
                },
              }) + "\n",
            ),
          );

          const promptResult1 = yield* Fiber.join(promptFiber1);
          expect(promptResult1.stopReason).toBe("end_turn");

          // === Turn 2 (MUST not hang or fail on closed stdin!) ===
          const promptFiber2 = yield* runtime
            .prompt({
              prompt: [{ type: "text", text: "Turn 2 question" }],
            })
            .pipe(Effect.forkScoped);

          yield* Effect.sleep("50 millis");
          expect(receivedInputs.length).toBe(2);
          expect(receivedInputs[1]).toContain('"content":"Turn 2 question"');

          yield* Queue.offer(
            outputQueue,
            new TextEncoder().encode(
              JSON.stringify({
                event: "step_update",
                step_update: {
                  step_index: 2,
                  step_type: "agent_response",
                  text_delta: "Turn 2 answer",
                },
              }) + "\n",
            ),
          );

          yield* Queue.offer(
            outputQueue,
            new TextEncoder().encode(
              JSON.stringify({
                event: "result",
                result: {
                  conversation_id: "conv-1234",
                  status: "SUCCESS",
                  response: "Turn 2 answer",
                },
              }) + "\n",
            ),
          );

          const promptResult2 = yield* Fiber.join(promptFiber2);
          expect(promptResult2.stopReason).toBe("end_turn");

          yield* Effect.sleep("50 millis");

          // Verify events from both turns were received
          const contentDeltas = events.filter((e) => e._tag === "ContentDelta");
          expect(contentDeltas.length).toBe(2);
          expect((contentDeltas[0] as any).text).toBe("Turn 1 answer");
          expect((contentDeltas[1] as any).text).toBe("Turn 2 answer");
        }),
      ),
    );
  });

  it("extracts explicit and inline thought deltas correctly", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const outputQueue = yield* Queue.unbounded<Uint8Array>();
          const exitedDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();

          const spawner = ChildProcessSpawner.make(() =>
            Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(101),
                exitCode: Deferred.await(exitedDeferred),
                isRunning: Effect.succeed(true),
                kill: () =>
                  Deferred.succeed(exitedDeferred, ChildProcessSpawner.ExitCode(0)).pipe(
                    Effect.asVoid,
                  ),
                unref: Effect.succeed(Effect.void),
                stdin: Sink.drain,
                stdout: Stream.fromQueue(outputQueue),
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              }),
            ),
          );

          const runtime = yield* makeAntigravityCliRuntime({
            executablePath: "agy",
            cwd: "C:\\test",
            childProcessSpawner: spawner,
          });

          yield* runtime.start();

          const events: AcpSessionRuntime.AcpSessionRuntimeEvent[] = [];
          yield* Stream.runForEach(runtime.getEvents(), (ev) =>
            Effect.sync(() => {
              events.push(ev);
            }),
          ).pipe(Effect.forkScoped);

          const promptFiber = yield* runtime
            .prompt({
              prompt: [{ type: "text", text: "Think carefully" }],
            })
            .pipe(Effect.forkScoped);

          yield* Effect.sleep("20 millis");

          // 1. Explicit thinking field
          yield* Queue.offer(
            outputQueue,
            new TextEncoder().encode(
              JSON.stringify({
                event: "step_update",
                step_update: {
                  step_index: 1,
                  step_type: "agent_response",
                  thinking_delta: "Reasoning step 1. ",
                },
              }) + "\n",
            ),
          );

          // 2. Inline thought tags
          yield* Queue.offer(
            outputQueue,
            new TextEncoder().encode(
              JSON.stringify({
                event: "step_update",
                step_update: {
                  step_index: 2,
                  step_type: "agent_response",
                  text_delta: "<thought>Reasoning step 2.</thought>Here is the final answer.",
                },
              }) + "\n",
            ),
          );

          // 3. Result to close turn
          yield* Queue.offer(
            outputQueue,
            new TextEncoder().encode(
              JSON.stringify({
                event: "result",
                result: {
                  conversation_id: "conv-1234",
                  status: "SUCCESS",
                  response: "Here is the final answer.",
                },
              }) + "\n",
            ),
          );

          yield* Fiber.join(promptFiber);
          yield* Effect.sleep("20 millis");

          const thoughts = events.filter((e) => e._tag === "ThoughtDelta");
          const contents = events.filter((e) => e._tag === "ContentDelta");

          expect(thoughts.length).toBe(2);
          expect((thoughts[0] as any).text).toBe("Reasoning step 1. ");
          expect((thoughts[1] as any).text).toBe("Reasoning step 2.");

          expect(contents.length).toBe(1);
          expect((contents[0] as any).text).toBe("Here is the final answer.");
        }),
      ),
    );
  });

  it("immediately cancels prompt and kills child process", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const outputQueue = yield* Queue.unbounded<Uint8Array>();
          const exitedDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          let killed = false;

          const spawner = ChildProcessSpawner.make(() =>
            Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(102),
                exitCode: Deferred.await(exitedDeferred),
                isRunning: Effect.succeed(true),
                kill: () =>
                  Effect.sync(() => {
                    killed = true;
                  }).pipe(
                    Effect.flatMap(() =>
                      Deferred.succeed(exitedDeferred, ChildProcessSpawner.ExitCode(0)).pipe(
                        Effect.asVoid,
                      ),
                    ),
                  ),
                unref: Effect.succeed(Effect.void),
                stdin: Sink.drain,
                stdout: Stream.fromQueue(outputQueue),
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              }),
            ),
          );

          const runtime = yield* makeAntigravityCliRuntime({
            executablePath: "agy",
            cwd: "C:\\test",
            childProcessSpawner: spawner,
          });

          yield* runtime.start();

          const promptFiber = yield* runtime
            .prompt({
              prompt: [{ type: "text", text: "Long task" }],
            })
            .pipe(Effect.forkScoped);

          yield* Effect.sleep("30 millis");

          // Cancel the running prompt
          yield* runtime.cancel;

          const result = yield* Fiber.join(promptFiber);
          expect(result.stopReason).toBe("cancelled");
          expect(killed).toBe(true);
        }),
      ),
    );
  });

  it("handles streaming content parser edge cases across chunk boundaries", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const thoughts: string[] = [];
          const contents: string[] = [];

          const parser = makeStreamingContentParser({
            onContent: (t) =>
              Effect.sync(() => {
                contents.push(t);
              }),
            onThought: (t) =>
              Effect.sync(() => {
                thoughts.push(t);
              }),
          });

          // Tag split across chunk boundary: "<think" and "ing>thought text</thinking>content"
          yield* parser.process("Initial content <think");
          yield* parser.process("ing>internal reasoning</thinking> and rest of content");
          yield* parser.flush();

          expect(contents.join("")).toBe("Initial content  and rest of content");
          expect(thoughts.join("")).toBe("internal reasoning");
        }),
      ),
    );
  });
});

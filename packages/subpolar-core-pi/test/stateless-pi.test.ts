import { expect, test } from "bun:test";
import { createPolicyGateway, createStatelessSubpolarRuntime } from "../../subpolar-core/src/index.ts";
import { createPiStatelessExecutor, createPiSdkExecutorFactory, type PiExecutionRequest, type PiSdkModule } from "../src/index.ts";

const request = { runId: "run", requestId: "request", prompt: "hello" };

test("shared Pi executor delegates tool calls through the runtime policy boundary", async () => {
  let executions = 0;
  let disposed = 0;
  const progress: unknown[] = [];
  const runtime = createStatelessSubpolarRuntime({
    context: { async load() { return { requestId: "request", principal: { id: "local", kind: "local" } }; } },
    gateway: createPolicyGateway({
      tools: [{ id: "denied", namespace: "test", description: "Denied", inputSchema: {}, enabled: true, risk: "high" }],
      resolvePolicy: () => ({ deny: true }),
      execute: async () => { executions++; return { ok: true, value: "unsafe" }; },
    }),
    executor: createPiStatelessExecutor(() => ({
      async execute(input) {
        expect(input.transcript.entries).toEqual([{ role: "user", content: "prior" }]);
        const result = await input.tools!.call({ callId: "call", toolId: "denied", input: {} });
        await input.emit({ type: "status", data: "done" });
        return result;
      },
      dispose() { disposed++; },
    }), undefined, () => [{ role: "user", content: "prior" }]),
    eventSink: (event) => { progress.push(event.type); },
  });
  expect(await runtime.run(request)).toMatchObject({ state: "completed", output: { ok: false, status: "denied" }, recoverable: false });
  expect(executions).toBe(0);
  expect(disposed).toBe(1);
  expect(progress).toEqual(["run.started", "run.progress", "run.completed"]);
});

test("SDK execution aborts, unsubscribes, and disposes without loading tools or file sessions", async () => {
  const controller = new AbortController();
  let aborts = 0;
  let disposed = 0;
  let unsubscribed = 0;
  let rejectPrompt: ((reason: Error) => void) | undefined;
  const sdk: PiSdkModule = {
    getAgentDir: () => "/test/agent",
    SessionManager: { inMemory: () => ({ appendMessage() {} }) },
    SettingsManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class {
      constructor(options: Record<string, unknown>) {
        expect(options).toMatchObject({ noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true });
      }
      async reload() {}
    },
    async createAgentSession(options) {
      expect(options).toMatchObject({ tools: [], noTools: "all" });
      return { session: {
        subscribe: () => () => { unsubscribed++; },
        prompt: () => new Promise<void>((_, reject) => { rejectPrompt = reject; controller.abort(); }),
        async abort() { aborts++; rejectPrompt?.(new Error("aborted")); },
        dispose() { disposed++; },
        messages: [],
      } };
    },
  };
  const runtime = createStatelessSubpolarRuntime({
    context: { async load() { return { requestId: "request", principal: { id: "local", kind: "local" } }; } },
    gateway: createPolicyGateway({ tools: [], resolvePolicy: () => ({ deny: true }), execute: async () => ({ ok: true, value: null }) }),
    executor: createPiStatelessExecutor(createPiSdkExecutorFactory(async () => sdk), undefined),
  });
  expect(await runtime.run({ ...request, signal: controller.signal })).toMatchObject({ state: "interrupted", recoverable: false });
  expect(aborts).toBe(1);
  expect(unsubscribed).toBe(1);
  expect(disposed).toBe(1);
});

test("SDK exposes only policy-gateway tools and routes calls through the run invoker", async () => {
  const observedCalls: unknown[] = [];
  let optionsSeen: Record<string, unknown> | undefined;
  const messages: Array<{ role: string; content: unknown; stopReason?: string }> = [];
  const sdk: PiSdkModule = {
    getAgentDir: () => "/test/agent",
    SessionManager: { inMemory: () => ({ appendMessage() {} }) },
    SettingsManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class { async reload() {} },
    async createAgentSession(options) {
      optionsSeen = options;
      return { session: {
        subscribe: () => () => undefined,
        async prompt() {
          const tools = options.customTools as Array<{
            name: string;
            parameters: Record<string, unknown>;
            execute(id: string, params: unknown): Promise<unknown>;
          }>;
          const toolResult = await tools[0]!.execute("call-1", { text: "hello" });
          observedCalls.push(toolResult);
          messages.push({ role: "assistant", content: [{ type: "text", text: "tool finished" }], stopReason: "stop" });
        },
        async abort() {},
        dispose() {},
        messages,
      } };
    },
  };
  const execution: PiExecutionRequest = {
    runId: "run-1",
    requestId: "request-1",
    prompt: "use the tool",
    context: { principal: { id: "owner-1", kind: "local" }, sessionId: "session-1" },
    transcript: { entries: [] },
    toolDefinitions: [{
      id: "test.echo",
      namespace: "test",
      description: "Echo text",
      inputSchema: {},
      enabled: true,
      risk: "low",
    }],
    emit: () => undefined,
    tools: {
      async call(call) {
        observedCalls.push(call);
        return { ok: true, status: "executed", callId: call.callId, toolId: call.toolId, value: { accepted: true } };
      },
    },
  };

  const executor = await createPiSdkExecutorFactory(async () => sdk)(undefined, execution);
  const result = await executor.execute(execution);

  expect(optionsSeen).toMatchObject({ noTools: "builtin", tools: [expect.stringMatching(/^subpolar_[a-f0-9]{16}$/)] });
  const customTools = optionsSeen?.customTools as Array<{ parameters: Record<string, unknown> }>;
  expect(customTools[0]?.parameters).toEqual({});
  expect(observedCalls[0]).toMatchObject({
    callId: "call-1",
    toolId: "test.echo",
    input: { text: "hello" },
    requestId: "request-1",
    runId: "run-1",
  });
  expect(observedCalls[1]).toMatchObject({
    content: [{ type: "text", text: expect.stringContaining('"accepted":true') }],
    details: { toolId: "test.echo" },
  });
  expect(result).toEqual({ text: "tool finished" });
  await executor.dispose?.();
});

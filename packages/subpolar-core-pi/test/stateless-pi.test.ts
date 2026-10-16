import { expect, test } from "bun:test";
import { createPolicyGateway, createStatelessSubpolarRuntime } from "../../subpolar-core/src/index.ts";
import { createPiStatelessExecutor, createPiSdkExecutorFactory, type PiSdkModule } from "../src/index.ts";

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

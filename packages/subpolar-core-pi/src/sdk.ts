import { PiRuntimeError, type PiExecutorFactory, type PiExecutionRequest } from "./index.ts";

export const PI_SDK_MODULE = "@earendil-works/pi-coding-agent";

/** Structural SDK boundary: the host owns SDK installation and credentials. */
export interface PiSdkModule {
  getAgentDir(): string;
  SessionManager: { inMemory(cwd?: string): { appendMessage(message: unknown): unknown } };
  SettingsManager: { inMemory(): unknown };
  DefaultResourceLoader: new (options: Record<string, unknown>) => { reload(): Promise<void> };
  createAgentSession(options: Record<string, unknown>): Promise<{ session: {
    subscribe(listener: (event: unknown) => void): () => void;
    prompt(prompt: string): Promise<void>;
    abort(): Promise<void>;
    dispose(): void;
    messages: readonly { role: string; content?: unknown; stopReason?: string; errorMessage?: string }[];
  } }>;
}

export interface PiSdkConfig {
  cwd?: string;
  agentDir?: string;
  model?: unknown;
  modelRuntime?: unknown;
}

export async function loadPiSdk(): Promise<PiSdkModule> {
  try {
    return await import(PI_SDK_MODULE);
  } catch {
    throw new PiRuntimeError("Pi SDK is unavailable. Install @earendil-works/pi-coding-agent for this standalone package, supply a Pi factory/module, or use --fixture for tests.");
  }
}

/** Prompt-only SDK composition. No built-ins or discovered extensions bypass policy. */
export function createPiSdkExecutorFactory(load: () => Promise<PiSdkModule> = loadPiSdk): PiExecutorFactory<PiSdkConfig | undefined> {
  return async (config, request) => {
    if (!request) throw new PiRuntimeError("Pi execution request is required");
    const sdk = await load();
    const cwd = request.context.cwd ?? config?.cwd ?? process.cwd();
    const agentDir = config?.agentDir ?? sdk.getAgentDir();
    const manager = sdk.SessionManager.inMemory(cwd);
    for (const entry of request.transcript.entries) {
      // Canonical text history is projected as user/custom context, not fabricated
      // provider assistant records (which require model/usage/tool-call metadata).
      manager.appendMessage({ role: "custom", customType: `subpolar.${entry.role}`, content: typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content), display: false, timestamp: Date.parse(entry.occurredAt ?? "") || Date.now() });
    }
    const settingsManager = sdk.SettingsManager.inMemory();
    const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
    await resourceLoader.reload();
    const { session } = await sdk.createAgentSession({ cwd, agentDir, model: config?.model, modelRuntime: config?.modelRuntime, sessionManager: manager, settingsManager, resourceLoader, tools: [], noTools: "all" });
    return {
      async execute(execution: PiExecutionRequest) {
        const pending: Promise<void>[] = [];
        const unsubscribe = session.subscribe((event) => { pending.push(Promise.resolve(execution.emit(event))); });
        const abort = () => { void session.abort().catch(() => {}); };
        execution.signal?.addEventListener("abort", abort, { once: true });
        try {
          if (execution.signal?.aborted) throw new PiRuntimeError("Pi execution cancelled");
          await session.prompt(execution.prompt);
          await Promise.all(pending);
          const message = [...session.messages].reverse().find((entry) => entry.role === "assistant");
          if (!message || message.stopReason === "error" || message.stopReason === "aborted") throw new PiRuntimeError("Pi did not produce a completed assistant response");
          const text = Array.isArray(message.content)
            ? message.content.filter((block) => block.type === "text").map((block) => block.text).join("")
            : typeof message.content === "string" ? message.content : "";
          return { text };
        } finally {
          execution.signal?.removeEventListener("abort", abort);
          unsubscribe();
        }
      },
      dispose: () => session.dispose(),
    };
  };
}

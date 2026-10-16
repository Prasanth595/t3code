import {
  EnvironmentManagerError,
  type EnvironmentIdentity,
  type EnvironmentInteractiveOutputEvent,
  type EnvironmentInteractiveProcessRequest,
  type EnvironmentInteractiveStartResult,
  type EnvironmentManagedSessionOutputEvent,
  type EnvironmentManagedSessionRequest,
  type EnvironmentManagedSessionStartResult,
  type EnvironmentManager,
  type EnvironmentProcessRequest,
  type EnvironmentProcessResult,
  type EnvironmentReconciliationResult,
  type EnvironmentRequest,
  type ManagedEnvironment,
  type EnvironmentRegistration,
} from "./index.ts";

export interface EnvironmentManagerHttpClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Manager URL must be an absolute HTTP URL");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Manager URL must use HTTP or HTTPS and cannot contain credentials, a query, or a fragment");
  }
  return parsed.toString().replace(/\/$/, "");
}

function managerError(body: unknown, status: number): EnvironmentManagerError {
  const code = isRecord(body) && typeof body.error === "string" ? body.error : "MANAGER_OPERATION_FAILED";
  const knownCode = code === "INVALID_REQUEST" || code === "WORKTREE_OUTSIDE_ROOT" || code === "OWNERSHIP_MISMATCH" ||
    code === "ENVIRONMENT_NOT_FOUND" || code === "BACKEND_FAILURE"
    ? code
    : "BACKEND_FAILURE";
  return new EnvironmentManagerError(knownCode, `Environment manager request failed (${status}, ${code})`);
}

async function readError(response: Response): Promise<never> {
  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  throw managerError(body, response.status);
}

/** Client for the authenticated environment-manager service boundary. */
export function createEnvironmentManagerHttpClient(options: EnvironmentManagerHttpClientOptions): EnvironmentManager {
  const baseUrl = validateBaseUrl(options.baseUrl);
  if (options.token.length < 32 || options.token.includes("\0")) throw new Error("Manager API token must contain at least 32 characters");
  const fetcher = options.fetch ?? fetch;

  const post = async (route: string, body?: unknown, signal?: AbortSignal): Promise<Response> => {
    const response = await fetcher(`${baseUrl}/v1/environments/${route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) await readError(response);
    return response;
  };

  const environmentBody = (request: EnvironmentRequest) => ({ environment: request });

  return {
    async list(ownerId?: string): Promise<readonly EnvironmentRegistration[]> {
      const response = await post("admin/list", ownerId === undefined ? {} : { ownerId });
      const value: unknown = await response.json();
      if (!isRecord(value) || !Array.isArray(value.environments)) {
        throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment manager returned an invalid environment list");
      }
      return value.environments as EnvironmentRegistration[];
    },
    async status(): Promise<{ readonly ok: true; readonly registeredEnvironmentCount: number }> {
      const response = await post("admin/status", {});
      const value: unknown = await response.json();
      if (!isRecord(value) || value.ok !== true || !Number.isSafeInteger(value.registeredEnvironmentCount) || (value.registeredEnvironmentCount as number) < 0) {
        throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment manager returned invalid status");
      }
      return { ok: true, registeredEnvironmentCount: value.registeredEnvironmentCount as number };
    },
    async inspect(request: EnvironmentRequest): Promise<ManagedEnvironment | null> {
      const response = await post("admin/inspect", environmentBody(request));
      const value: unknown = await response.json();
      if (!isRecord(value) || !(value.environment === null || isRecord(value.environment))) {
        throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment manager returned an invalid inspection result");
      }
      return value.environment as ManagedEnvironment | null;
    },
    async rebuild(request: EnvironmentRequest): Promise<ManagedEnvironment> {
      const response = await post("admin/rebuild", environmentBody(request));
      return await response.json() as ManagedEnvironment;
    },
    async identity(request) {
      const response = await post("identity", environmentBody(request));
      const value: unknown = await response.json();
      if (!isRecord(value) || typeof value.id !== "string" || typeof value.ownerId !== "string" ||
          typeof value.workspaceId !== "string" || typeof value.storageRoot !== "string" || typeof value.worktreePath !== "string") {
        throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment manager returned an invalid identity");
      }
      return value as unknown as EnvironmentIdentity;
    },
    async ensure(request) {
      const response = await post("ensure", environmentBody(request));
      return await response.json() as ManagedEnvironment;
    },
    async start(request) {
      const response = await post("start", environmentBody(request));
      return await response.json() as ManagedEnvironment;
    },
    async stop(request) {
      const response = await post("stop", environmentBody(request));
      return await response.json() as ManagedEnvironment;
    },
    async restart(request) {
      const response = await post("restart", environmentBody(request));
      return await response.json() as ManagedEnvironment;
    },
    async remove(request) {
      await post("remove", environmentBody(request));
    },
    async execute(request, command, process: EnvironmentProcessRequest = {}): Promise<EnvironmentProcessResult> {
      if (process.signal?.aborted) return { exitCode: null, cancelled: true };
      let response: Response;
      try {
        response = await post("execute", {
          ...environmentBody(request),
          command,
          process: {
            ...(process.cwd === undefined ? {} : { cwd: process.cwd }),
            ...(process.environment === undefined ? {} : { environment: process.environment }),
          },
        }, process.signal);
      } catch (cause) {
        if (process.signal?.aborted) return { exitCode: null, cancelled: true };
        throw cause;
      }
      if (!response.body) throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment manager returned no process stream");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let result: EnvironmentProcessResult | undefined;
      const handleLine = async (line: string) => {
        if (!line) return;
        let event: unknown;
        try { event = JSON.parse(line); } catch (cause) {
          throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment manager returned invalid process data", { cause });
        }
        if (!isRecord(event)) throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment manager returned invalid process data");
        if (event.type === "output" && (event.stream === "stdout" || event.stream === "stderr") && typeof event.data === "string") {
          await process.onOutput?.({ stream: event.stream, data: Buffer.from(event.data, "base64") });
        } else if (event.type === "result" && isRecord(event.result) &&
            (typeof event.result.exitCode === "number" || event.result.exitCode === null) && typeof event.result.cancelled === "boolean") {
          result = {
            ...(typeof event.result.processId === "string" ? { processId: event.result.processId } : {}),
            exitCode: event.result.exitCode,
            cancelled: event.result.cancelled,
          };
        } else if (event.type === "error") {
          throw new EnvironmentManagerError("BACKEND_FAILURE", `Managed process failed (${typeof event.code === "string" ? event.code : "unknown"})`);
        }
      };
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          pending += decoder.decode(part.value, { stream: true });
          let newline = pending.indexOf("\n");
          while (newline >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            await handleLine(line);
            newline = pending.indexOf("\n");
          }
          if (pending.length > 1_048_576) throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment manager process event exceeded the allowed size");
        }
        pending += decoder.decode();
        if (pending) await handleLine(pending);
      } catch (cause) {
        await reader.cancel(cause).catch(() => undefined);
        if (process.signal?.aborted) return { exitCode: null, cancelled: true };
        throw cause;
      }
      if (!result) throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment manager ended process execution without a result");
      return result;
    },
    async startInteractive(request, command, process: EnvironmentInteractiveProcessRequest = {}): Promise<EnvironmentInteractiveStartResult> {
      const response = await post("pty/start", {
        ...environmentBody(request), command,
        process: {
          ...(process.cwd === undefined ? {} : { cwd: process.cwd }),
          ...(process.environment === undefined ? {} : { environment: process.environment }),
          ...(process.clientSessionId === undefined ? {} : { clientSessionId: process.clientSessionId }),
        },
      });
      const value: unknown = await response.json();
      if (!isRecord(value) || typeof value.sessionId !== "string" || !Number.isSafeInteger(value.outputSequence) || (value.outputSequence as number) < 0) {
        throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment manager returned an invalid interactive session");
      }
      return { sessionId: value.sessionId, outputSequence: value.outputSequence as number };
    },
    async writeInteractive(request, sessionId, data): Promise<void> {
      await post("pty/input", { ...environmentBody(request), sessionId, data: Buffer.from(data).toString("base64") });
    },
    async resizeInteractive(request, sessionId, columns, rows): Promise<void> {
      await post("pty/resize", { ...environmentBody(request), sessionId, columns, rows });
    },
    async *attachInteractiveOutput(request, sessionId, afterSequence = 0): AsyncIterable<EnvironmentInteractiveOutputEvent | { readonly type: "exit"; readonly result: EnvironmentProcessResult }> {
      const response = await post("pty/output", { ...environmentBody(request), sessionId, afterSequence });
      if (!response.body) throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment manager returned no interactive output stream");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      const parseLine = (line: string) => {
        if (!line) return undefined;
        let event: unknown;
        try { event = JSON.parse(line); } catch (cause) { throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment manager returned invalid interactive output", { cause }); }
        if (!isRecord(event)) throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment manager returned invalid interactive output");
        if (event.type === "output" && Number.isSafeInteger(event.sequence) && typeof event.data === "string") {
          return { type: "output", sequence: event.sequence as number, data: Buffer.from(event.data, "base64") } as const;
        }
        if (event.type === "exit" && isRecord(event.result) && (typeof event.result.exitCode === "number" || event.result.exitCode === null) && typeof event.result.cancelled === "boolean") {
          return { type: "exit", result: { exitCode: event.result.exitCode, cancelled: event.result.cancelled } } as const;
        }
        if (event.type === "error") throw new EnvironmentManagerError("BACKEND_FAILURE", `Interactive process failed (${typeof event.code === "string" ? event.code : "unknown"})`);
        throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment manager returned an unknown interactive output event");
      };
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          pending += decoder.decode(part.value, { stream: true });
          let newline = pending.indexOf("\n");
          while (newline >= 0) {
            const event = parseLine(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
            if (event) yield event;
            newline = pending.indexOf("\n");
          }
          if (pending.length > 1_048_576) throw new EnvironmentManagerError("BACKEND_FAILURE", "Interactive output event exceeded the allowed size");
        }
        pending += decoder.decode();
        const event = parseLine(pending);
        if (event) yield event;
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    },
    async terminateInteractive(request, sessionId): Promise<void> {
      await post("pty/terminate", { ...environmentBody(request), sessionId });
    },
    async startManagedSession(request, command, process: EnvironmentManagedSessionRequest = {}): Promise<EnvironmentManagedSessionStartResult> {
      const response = await post("stdio/start", {
        ...environmentBody(request), command,
        process: {
          ...(process.cwd === undefined ? {} : { cwd: process.cwd }),
          ...(process.environment === undefined ? {} : { environment: process.environment }),
          ...(process.clientSessionId === undefined ? {} : { clientSessionId: process.clientSessionId }),
        },
      });
      const value: unknown = await response.json();
      if (!isRecord(value) || typeof value.sessionId !== "string" || !Number.isSafeInteger(value.outputSequence) || (value.outputSequence as number) < 0) {
        throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment manager returned an invalid managed session");
      }
      return { sessionId: value.sessionId, outputSequence: value.outputSequence as number };
    },
    async writeManagedSession(request, sessionId, data): Promise<void> {
      await post("stdio/input", { ...environmentBody(request), sessionId, data: Buffer.from(data).toString("base64") });
    },
    async *attachManagedSessionOutput(request, sessionId, afterSequence = 0): AsyncIterable<EnvironmentManagedSessionOutputEvent | { readonly type: "exit"; readonly result: EnvironmentProcessResult }> {
      const response = await post("stdio/output", { ...environmentBody(request), sessionId, afterSequence });
      if (!response.body) throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment manager returned no managed session output stream");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      const parseLine = (line: string) => {
        if (!line) return undefined;
        let event: unknown;
        try { event = JSON.parse(line); } catch (cause) { throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment manager returned invalid managed session output", { cause }); }
        if (!isRecord(event)) throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment manager returned invalid managed session output");
        if (event.type === "output" && Number.isSafeInteger(event.sequence) && (event.stream === "stdout" || event.stream === "stderr") && typeof event.data === "string") {
          return { type: "output", sequence: event.sequence as number, stream: event.stream, data: Buffer.from(event.data, "base64") } as const;
        }
        if (event.type === "exit" && isRecord(event.result) && (typeof event.result.exitCode === "number" || event.result.exitCode === null) && typeof event.result.cancelled === "boolean") {
          return { type: "exit", result: { exitCode: event.result.exitCode, cancelled: event.result.cancelled } } as const;
        }
        if (event.type === "error") throw new EnvironmentManagerError("BACKEND_FAILURE", `Managed session failed (${typeof event.code === "string" ? event.code : "unknown"})`);
        throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment manager returned an unknown managed session event");
      };
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          pending += decoder.decode(part.value, { stream: true });
          let newline = pending.indexOf("\n");
          while (newline >= 0) {
            const event = parseLine(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
            if (event) yield event;
            newline = pending.indexOf("\n");
          }
          if (pending.length > 1_048_576) throw new EnvironmentManagerError("BACKEND_FAILURE", "Managed session output event exceeded the allowed size");
        }
        pending += decoder.decode();
        const event = parseLine(pending);
        if (event) yield event;
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    },
    async terminateManagedSession(request, sessionId): Promise<void> {
      await post("stdio/terminate", { ...environmentBody(request), sessionId });
    },
    async reconcile() {
      const response = await post("reconcile");
      const value: unknown = await response.json();
      if (!isRecord(value) || !Array.isArray(value.results)) throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment manager returned invalid reconciliation data");
      return value.results as EnvironmentReconciliationResult[];
    },
  };
}

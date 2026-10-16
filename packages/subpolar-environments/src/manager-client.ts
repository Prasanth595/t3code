import {
  EnvironmentManagerError,
  type EnvironmentIdentity,
  type EnvironmentManager,
  type EnvironmentProcessRequest,
  type EnvironmentProcessResult,
  type EnvironmentReconciliationResult,
  type EnvironmentRequest,
  type ManagedEnvironment,
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
    async reconcile() {
      const response = await post("reconcile");
      const value: unknown = await response.json();
      if (!isRecord(value) || !Array.isArray(value.results)) throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment manager returned invalid reconciliation data");
      return value.results as EnvironmentReconciliationResult[];
    },
  };
}

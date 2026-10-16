import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

export type EnvironmentStatus = "creating" | "starting" | "ready" | "stopping" | "stopped" | "failed";

export interface EnvironmentRequest {
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly storageRoot: string;
  readonly worktreePath: string;
}

/** Canonical identity passed to a backend; it is derived from verified paths. */
export interface EnvironmentIdentity {
  readonly id: string;
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly storageRoot: string;
  readonly worktreePath: string;
}

export interface ManagedEnvironment extends EnvironmentIdentity {
  readonly backendId: string;
  readonly resourceId: string;
  readonly status: EnvironmentStatus;
}

/**
 * Contract for a manager-owned backend. Implementations must treat `identity.id`
 * as an idempotency key and verify the complete identity before every operation.
 * This package intentionally includes no Docker client or daemon access.
 */
export interface EnvironmentBackend {
  readonly id: string;
  inspect(identity: EnvironmentIdentity): Promise<ManagedEnvironment | null>;
  create(identity: EnvironmentIdentity): Promise<ManagedEnvironment>;
  start(environment: ManagedEnvironment): Promise<ManagedEnvironment>;
  stop(environment: ManagedEnvironment): Promise<ManagedEnvironment>;
  remove(environment: ManagedEnvironment): Promise<void>;
}

export interface EnvironmentProcessOutput {
  readonly stream: "stdout" | "stderr";
  readonly data: Uint8Array;
}

export interface EnvironmentProcessResult {
  readonly processId?: string;
  readonly exitCode: number | null;
  readonly cancelled: boolean;
}

export interface EnvironmentProcessRequest {
  /** Relative to the mounted worktree root; absolute paths are rejected. */
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly onOutput?: (output: EnvironmentProcessOutput) => void | Promise<void>;
}

export interface EnvironmentProcessBackend extends EnvironmentBackend {
  execute(
    environment: ManagedEnvironment,
    command: readonly string[],
    request: EnvironmentProcessRequest,
  ): Promise<EnvironmentProcessResult>;
}

export interface EnvironmentManager {
  identity(request: EnvironmentRequest): Promise<EnvironmentIdentity>;
  ensure(request: EnvironmentRequest): Promise<ManagedEnvironment>;
  start(request: EnvironmentRequest): Promise<ManagedEnvironment>;
  stop(request: EnvironmentRequest): Promise<ManagedEnvironment>;
  remove(request: EnvironmentRequest): Promise<void>;
  execute(request: EnvironmentRequest, command: readonly string[], process?: EnvironmentProcessRequest): Promise<EnvironmentProcessResult>;
  reconcile(): Promise<readonly EnvironmentReconciliationResult[]>;
}

export interface EnvironmentRegistration {
  readonly environment: ManagedEnvironment;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EnvironmentRegistrationStore {
  loadAll(): Promise<readonly EnvironmentRegistration[]>;
  save(environment: ManagedEnvironment, createdAt: string, updatedAt: string): Promise<void>;
  remove(environmentId: string): Promise<void>;
}

export interface EnvironmentReconciliationResult {
  readonly environmentId: string;
  readonly environment?: ManagedEnvironment;
  readonly error?: EnvironmentManagerError;
}

export class EnvironmentManagerError extends Error {
  constructor(
    readonly code: "INVALID_REQUEST" | "WORKTREE_OUTSIDE_ROOT" | "BACKEND_FAILURE" | "OWNERSHIP_MISMATCH" | "ENVIRONMENT_NOT_FOUND",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EnvironmentManagerError";
  }
}

function requiredId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || normalized.includes("\0")) {
    throw new EnvironmentManagerError("INVALID_REQUEST", `${label} must be a non-empty identifier`);
  }
  return normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function stableId(identity: Omit<EnvironmentIdentity, "id">): string {
  const material = JSON.stringify([
    identity.ownerId,
    identity.workspaceId,
    identity.storageRoot,
    identity.worktreePath,
  ]);
  return `env_${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

/**
 * In-process lifecycle coordinator. It provides same-process request
 * coalescing only; durable registrations and cross-process reconciliation are
 * responsibilities of the injected manager backend.
 */
export function createEnvironmentManager(
  backend: EnvironmentBackend,
  registrations?: EnvironmentRegistrationStore,
  now: () => Date = () => new Date(),
): EnvironmentManager {
  if (!backend.id.trim()) throw new EnvironmentManagerError("INVALID_REQUEST", "A backend ID is required");
  const operations = new Map<string, Promise<unknown>>();

  const identity = async (request: EnvironmentRequest): Promise<EnvironmentIdentity> => {
    const ownerId = requiredId(request.ownerId, "ownerId");
    const workspaceId = requiredId(request.workspaceId, "workspaceId");
    if (!path.isAbsolute(request.storageRoot) || !path.isAbsolute(request.worktreePath)) {
      throw new EnvironmentManagerError("INVALID_REQUEST", "Storage root and worktree path must be absolute");
    }

    let storageRoot: string;
    let worktreePath: string;
    try {
      [storageRoot, worktreePath] = await Promise.all([
        realpath(path.resolve(request.storageRoot)),
        realpath(path.resolve(request.worktreePath)),
      ]);
    } catch (cause) {
      throw new EnvironmentManagerError("INVALID_REQUEST", "Storage root and worktree must exist", { cause });
    }
    if (!isWithin(storageRoot, worktreePath)) {
      throw new EnvironmentManagerError("WORKTREE_OUTSIDE_ROOT", "Worktree resolves outside the configured storage root");
    }

    const values = { ownerId, workspaceId, storageRoot, worktreePath };
    return { ...values, id: stableId(values) };
  };

  const withIdentityLock = <A>(id: string, operation: () => Promise<A>): Promise<A> => {
    const prior = operations.get(id);
    if (prior) return prior as Promise<A>;
    const pending = operation().finally(() => {
      if (operations.get(id) === pending) operations.delete(id);
    });
    operations.set(id, pending);
    return pending;
  };

  const backendCall = async <A>(operation: string, call: () => Promise<A>): Promise<A> => {
    try {
      return await call();
    } catch (cause) {
      if (cause instanceof EnvironmentManagerError) throw cause;
      throw new EnvironmentManagerError("BACKEND_FAILURE", `Environment backend failed to ${operation}`, { cause });
    }
  };

  const validateRecord = (expected: EnvironmentIdentity, record: ManagedEnvironment): ManagedEnvironment => {
    if (
      !record || record.id !== expected.id || record.ownerId !== expected.ownerId ||
      record.workspaceId !== expected.workspaceId || record.storageRoot !== expected.storageRoot ||
      record.worktreePath !== expected.worktreePath || record.backendId !== backend.id ||
      typeof record.resourceId !== "string" || record.resourceId.length === 0
    ) {
      throw new EnvironmentManagerError("OWNERSHIP_MISMATCH", "Backend environment identity or ownership does not match the request");
    }
    return record;
  };

  const persist = async (environment: ManagedEnvironment): Promise<ManagedEnvironment> => {
    if (!registrations) return environment;
    const prior = (await registrations.loadAll()).find((entry) => entry.environment.id === environment.id);
    const timestamp = now().toISOString();
    await registrations.save(environment, prior?.createdAt ?? timestamp, timestamp);
    return environment;
  };

  const inspect = async (expected: EnvironmentIdentity) => {
    const found = await backendCall("inspect", () => backend.inspect(expected));
    return found === null ? null : validateRecord(expected, found);
  };

  const ensure: EnvironmentManager["ensure"] = async (request) => {
    const expected = await identity(request);
    return withIdentityLock(expected.id, async () => {
      let current = await inspect(expected);
      if (current === null) {
        current = validateRecord(expected, await backendCall("create", () => backend.create(expected)));
        await persist(current);
      }
      if (current.status === "ready") return persist(current);
      return persist(validateRecord(expected, await backendCall("start", () => backend.start(current!))));
    });
  };

  const start: EnvironmentManager["start"] = async (request) => {
    const expected = await identity(request);
    return withIdentityLock(expected.id, async () => {
      const current = await inspect(expected);
      if (current === null) throw new EnvironmentManagerError("ENVIRONMENT_NOT_FOUND", "Environment has not been created");
      if (current.status === "ready") return persist(current);
      return persist(validateRecord(expected, await backendCall("start", () => backend.start(current))));
    });
  };

  const stop: EnvironmentManager["stop"] = async (request) => {
    const expected = await identity(request);
    return withIdentityLock(expected.id, async () => {
      const current = await inspect(expected);
      if (current === null) throw new EnvironmentManagerError("ENVIRONMENT_NOT_FOUND", "Environment has not been created");
      if (current.status === "stopped") return persist(current);
      return persist(validateRecord(expected, await backendCall("stop", () => backend.stop(current))));
    });
  };

  const remove: EnvironmentManager["remove"] = async (request) => {
    const expected = await identity(request);
    return withIdentityLock(expected.id, async () => {
      const current = await inspect(expected);
      if (current === null) {
        await registrations?.remove(expected.id);
        return;
      }
      await backendCall("remove", () => backend.remove(current));
      await registrations?.remove(expected.id);
    });
  };

  const execute: EnvironmentManager["execute"] = async (request, command, process = {}) => {
    if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || part.length === 0 || part.includes("\0"))) {
      throw new EnvironmentManagerError("INVALID_REQUEST", "Process command must be a non-empty argv array without NUL bytes");
    }
    if (process.signal?.aborted) {
      return { exitCode: null, cancelled: true };
    }
    const processBackend = backend as EnvironmentBackend & Partial<EnvironmentProcessBackend>;
    if (typeof processBackend.execute !== "function") {
      throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment backend does not support managed process execution");
    }
    const environment = await ensure(request);
    if (environment.status !== "ready") {
      throw new EnvironmentManagerError("BACKEND_FAILURE", "Managed environment is not ready for process execution");
    }
    return backendCall("execute process", () => processBackend.execute!(environment, command, process));
  };

  const reconcile: EnvironmentManager["reconcile"] = async () => {
    if (!registrations) return [];
    const saved = await registrations.loadAll();
    return Promise.all(saved.map(async ({ environment }) => {
      try {
        const currentIdentity = await identity(environment);
        if (currentIdentity.id !== environment.id) {
          throw new EnvironmentManagerError("OWNERSHIP_MISMATCH", "Registered environment path no longer resolves to its original identity");
        }
        return { environmentId: environment.id, environment: await ensure(environment) };
      } catch (error) {
        return {
          environmentId: environment.id,
          error: error instanceof EnvironmentManagerError
            ? error
            : new EnvironmentManagerError("BACKEND_FAILURE", "Environment reconciliation failed", { cause: error }),
        };
      }
    }));
  };

  return { identity, ensure, start, stop, remove, execute, reconcile };
}

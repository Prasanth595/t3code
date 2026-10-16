import { createHash, randomUUID } from "node:crypto";
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

export interface EnvironmentInteractiveProcessRequest {
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  /** Stable T3 terminal key used to reuse a live session after gateway reconnect. */
  readonly clientSessionId?: string;
}

/** A live terminal process owned by the manager until it exits or is terminated. */
export interface EnvironmentInteractiveSession {
  write(data: Uint8Array): Promise<void>;
  resize(columns: number, rows: number): Promise<void>;
  readonly output: AsyncIterable<Uint8Array>;
  readonly result: Promise<EnvironmentProcessResult>;
  terminate(): Promise<void>;
}

export interface EnvironmentInteractiveProcessBackend extends EnvironmentBackend {
  startInteractive(
    environment: ManagedEnvironment,
    command: readonly string[],
    request: EnvironmentInteractiveProcessRequest,
  ): Promise<EnvironmentInteractiveSession>;
}

export interface EnvironmentInteractiveStartResult {
  readonly sessionId: string;
  readonly outputSequence: number;
}

export interface EnvironmentInteractiveOutputEvent {
  readonly type: "output";
  readonly sequence: number;
  readonly data: Uint8Array;
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
  startInteractive(request: EnvironmentRequest, command: readonly string[], process?: EnvironmentInteractiveProcessRequest): Promise<EnvironmentInteractiveStartResult>;
  writeInteractive(request: EnvironmentRequest, sessionId: string, data: Uint8Array): Promise<void>;
  resizeInteractive(request: EnvironmentRequest, sessionId: string, columns: number, rows: number): Promise<void>;
  attachInteractiveOutput(request: EnvironmentRequest, sessionId: string, afterSequence?: number): AsyncIterable<EnvironmentInteractiveOutputEvent | { readonly type: "exit"; readonly result: EnvironmentProcessResult }>;
  terminateInteractive(request: EnvironmentRequest, sessionId: string): Promise<void>;
  closeInteractiveSessions?(): Promise<void>;
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
 * In-process lifecycle coordinator. Registrations survive restarts, while
 * interactive sessions and output cursors live in this process. Stable client
 * keys support gateway reconnects while this manager stays alive; graceful
 * shutdown terminates sessions, but a manager crash loses the session handles.
 */
export function createEnvironmentManager(
  backend: EnvironmentBackend,
  registrations?: EnvironmentRegistrationStore,
  now: () => Date = () => new Date(),
): EnvironmentManager {
  if (!backend.id.trim()) throw new EnvironmentManagerError("INVALID_REQUEST", "A backend ID is required");
  const operations = new Map<string, Promise<unknown>>();
  type InteractiveEntry = {
    readonly identity: EnvironmentIdentity;
    readonly session: EnvironmentInteractiveSession;
    readonly sessionId: string;
    readonly clientKey?: string;
    readonly command: readonly string[];
    readonly processOptions: EnvironmentInteractiveProcessRequest;
    events: EnvironmentInteractiveOutputEvent[];
    bufferedBytes: number;
    sequence: number;
    done: boolean;
    attached: boolean;
    wake?: () => void;
    wakeSpace?: () => void;
    result?: EnvironmentProcessResult;
  };
  const interactiveSessions = new Map<string, InteractiveEntry>();
  const interactiveClientKeys = new Map<string, string>();
  const MAX_INTERACTIVE_SESSIONS = 64;
  const MAX_INTERACTIVE_BUFFER_BYTES = 1_048_576;
  const MAX_INTERACTIVE_BUFFER_EVENTS = 4_096;

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

  const terminateSessionsForEnvironment = async (environmentId: string) => {
    const owned = [...interactiveSessions.entries()].filter(([, entry]) => entry.identity.id === environmentId);
    await Promise.all(owned.map(async ([sessionId, entry]) => {
      await backendCall("terminate interactive process", () => entry.session.terminate());
      interactiveSessions.delete(sessionId);
      if (entry.clientKey) interactiveClientKeys.delete(entry.clientKey);
      entry.done = true;
      entry.wake?.();
      entry.wakeSpace?.();
    }));
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
      await terminateSessionsForEnvironment(current.id);
      if (current.status === "stopped") return persist(current);
      return persist(validateRecord(expected, await backendCall("stop", () => backend.stop(current))));
    });
  };

  const remove: EnvironmentManager["remove"] = async (request) => {
    const expected = await identity(request);
    return withIdentityLock(expected.id, async () => {
      const current = await inspect(expected);
      if (current === null) {
        await terminateSessionsForEnvironment(expected.id);
        await registrations?.remove(expected.id);
        return;
      }
      await terminateSessionsForEnvironment(current.id);
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

  const resolveInteractiveSession = async (request: EnvironmentRequest, sessionId: string) => {
    const expected = await identity(request);
    const entry = interactiveSessions.get(sessionId);
    if (!entry) throw new EnvironmentManagerError("ENVIRONMENT_NOT_FOUND", "Interactive process session was not found");
    if (entry.identity.id !== expected.id || entry.identity.ownerId !== expected.ownerId || entry.identity.workspaceId !== expected.workspaceId) {
      throw new EnvironmentManagerError("OWNERSHIP_MISMATCH", "Interactive process session belongs to another environment");
    }
    return entry;
  };

  const startInteractive: EnvironmentManager["startInteractive"] = async (request, command, process = {}) => {
    if (!Array.isArray(command) || command.length === 0 || command.length > 256 || command.some((part) => typeof part !== "string" || !part || part.includes("\0"))) {
      throw new EnvironmentManagerError("INVALID_REQUEST", "Interactive command must be a non-empty argv array without NUL bytes");
    }
    const processBackend = backend as EnvironmentBackend & Partial<EnvironmentInteractiveProcessBackend>;
    if (typeof processBackend.startInteractive !== "function") {
      throw new EnvironmentManagerError("BACKEND_FAILURE", "Environment backend does not support interactive processes");
    }
    const environment = await ensure(request);
    if (environment.status !== "ready") throw new EnvironmentManagerError("BACKEND_FAILURE", "Managed environment is not ready for interactive processes");
    return withIdentityLock(environment.id, async () => {
      const clientSessionId = process.clientSessionId?.trim();
      if (clientSessionId !== undefined && (!clientSessionId || clientSessionId.length > 256 || clientSessionId.includes("\0"))) {
        throw new EnvironmentManagerError("INVALID_REQUEST", "Interactive client session ID is invalid");
      }
      const clientKey = clientSessionId === undefined ? undefined : `${environment.id}:${clientSessionId}`;
      const previousId = clientKey === undefined ? undefined : interactiveClientKeys.get(clientKey);
      const previous = previousId === undefined ? undefined : interactiveSessions.get(previousId);
      if (previous) {
        const priorOptions = previous.processOptions;
        const environmentEntries = (value: Readonly<Record<string, string>> | undefined) => Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right));
        const sameOptions = JSON.stringify([previous.command, priorOptions.cwd ?? ".", environmentEntries(priorOptions.environment)]) ===
          JSON.stringify([command, process.cwd ?? ".", environmentEntries(process.environment)]);
        if (!sameOptions) throw new EnvironmentManagerError("OWNERSHIP_MISMATCH", "Client session key is already bound to a different process");
        return { sessionId: previous.sessionId, outputSequence: previous.sequence };
      }
      if (interactiveSessions.size >= MAX_INTERACTIVE_SESSIONS) {
        const completed = [...interactiveSessions.entries()].find(([, entry]) => entry.done);
        if (!completed) throw new EnvironmentManagerError("BACKEND_FAILURE", "Interactive session capacity has been reached");
        interactiveSessions.delete(completed[0]);
        if (completed[1].clientKey) interactiveClientKeys.delete(completed[1].clientKey);
      }
      const session = await backendCall("start interactive process", () => processBackend.startInteractive!(environment, command, process));
      const sessionId = randomUUID();
      const entry: InteractiveEntry = {
        identity: environment, session, sessionId,
        ...(clientKey === undefined ? {} : { clientKey }),
        command: [...command], processOptions: { ...process },
        events: [], bufferedBytes: 0, sequence: 0, done: false, attached: false,
      };
      interactiveSessions.set(sessionId, entry);
      if (clientKey) interactiveClientKeys.set(clientKey, sessionId);
      void (async () => {
        try {
          for await (const data of session.output) {
            for (let offset = 0; offset < data.byteLength; offset += MAX_INTERACTIVE_BUFFER_BYTES) {
              const chunk = data.slice(offset, offset + MAX_INTERACTIVE_BUFFER_BYTES);
              while (!entry.done && (entry.bufferedBytes + chunk.byteLength > MAX_INTERACTIVE_BUFFER_BYTES || entry.events.length >= MAX_INTERACTIVE_BUFFER_EVENTS)) {
                await new Promise<void>((resolve) => { entry.wakeSpace = resolve; });
              }
              if (entry.done) break;
              entry.events.push({ type: "output", sequence: ++entry.sequence, data: chunk });
              entry.bufferedBytes += chunk.byteLength;
              entry.wake?.();
              entry.wake = undefined;
            }
            if (entry.done) break;
          }
          if (!entry.done) entry.result = await session.result;
        } catch {
          try { await session.terminate(); } catch { /* Release process resources after output transport failure. */ }
          entry.result = { exitCode: null, cancelled: true };
        } finally {
          entry.done = true;
          entry.wake?.();
          entry.wakeSpace?.();
        }
      })();
      return { sessionId, outputSequence: 0 };
    });
  };

  const writeInteractive: EnvironmentManager["writeInteractive"] = async (request, sessionId, data) => {
    if (!(data instanceof Uint8Array) || data.byteLength > 65_536) throw new EnvironmentManagerError("INVALID_REQUEST", "Interactive input must be at most 64 KiB");
    const { session } = await resolveInteractiveSession(request, sessionId);
    await backendCall("write interactive input", () => session.write(data));
  };

  const resizeInteractive: EnvironmentManager["resizeInteractive"] = async (request, sessionId, columns, rows) => {
    if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows) || columns < 1 || rows < 1 || columns > 500 || rows > 500) {
      throw new EnvironmentManagerError("INVALID_REQUEST", "Terminal dimensions must be between 1 and 500 columns and rows");
    }
    const { session } = await resolveInteractiveSession(request, sessionId);
    await backendCall("resize interactive process", () => session.resize(columns, rows));
  };

  const attachInteractiveOutput: EnvironmentManager["attachInteractiveOutput"] = async function* (request, sessionId, afterSequence = 0) {
    const entry = await resolveInteractiveSession(request, sessionId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > entry.sequence) {
      throw new EnvironmentManagerError("INVALID_REQUEST", "Interactive output cursor is invalid");
    }
    if (entry.attached) throw new EnvironmentManagerError("BACKEND_FAILURE", "Interactive output already has an attached reader");
    entry.events = entry.events.filter((event) => event.sequence > afterSequence);
    entry.bufferedBytes = entry.events.reduce((total, event) => total + event.data.byteLength, 0);
    entry.wakeSpace?.();
    entry.wakeSpace = undefined;
    entry.attached = true;
    let cursor = afterSequence;
    try {
      while (true) {
        const next = entry.events.find((event) => event.sequence > cursor);
        if (next) {
          cursor = next.sequence;
          yield next;
          // Retire only after the consumer asks for the next event. If it
          // disconnects between reads, the last delivered chunk stays replayable.
          entry.events = entry.events.filter((event) => event.sequence > cursor);
          entry.bufferedBytes = entry.events.reduce((total, event) => total + event.data.byteLength, 0);
          entry.wakeSpace?.();
          entry.wakeSpace = undefined;
          continue;
        }
        if (entry.done) {
          yield { type: "exit", result: entry.result ?? { exitCode: null, cancelled: true } };
          return;
        }
        await new Promise<void>((resolve) => { entry.wake = resolve; });
      }
    } finally {
      entry.attached = false;
    }
  };

  const terminateInteractive: EnvironmentManager["terminateInteractive"] = async (request, sessionId) => {
    const entry = await resolveInteractiveSession(request, sessionId);
    await backendCall("terminate interactive process", () => entry.session.terminate());
    interactiveSessions.delete(sessionId);
    if (entry.clientKey) interactiveClientKeys.delete(entry.clientKey);
    entry.done = true;
    entry.wake?.();
    entry.wakeSpace?.();
  };

  const closeInteractiveSessions: EnvironmentManager["closeInteractiveSessions"] = async () => {
    const entries = [...interactiveSessions.values()];
    await Promise.all(entries.map(async (entry) => {
      try { await entry.session.terminate(); } catch { /* Continue cleaning up other sessions. */ }
      entry.done = true;
      entry.wake?.();
      entry.wakeSpace?.();
    }));
    interactiveSessions.clear();
    interactiveClientKeys.clear();
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

  return { identity, ensure, start, stop, remove, execute, startInteractive, writeInteractive, resizeInteractive, attachInteractiveOutput, terminateInteractive, closeInteractiveSessions, reconcile };
}

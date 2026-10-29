import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import {
  SandboxCreateRequest,
  SandboxDisplayName,
  SandboxDriverKind,
  SandboxId,
  SandboxIdempotencyKey,
  SandboxInstanceId,
  type Sandbox,
  type SandboxDriverOperation,
  type SandboxDriverSnapshot,
} from "@t3tools/sandbox-core/schema";
import {
  SandboxConfigError,
  SandboxDriverError,
  SandboxNotFoundError,
  SandboxPathEscapesError,
  isSandboxDriverError,
  isSandboxNotFoundError,
  isSandboxPathEscapesError,
  type SandboxOperationError,
} from "@t3tools/sandbox-core/server/errors";
import { defineSandboxDriver, type SandboxInstance } from "@t3tools/sandbox-core/server/driver";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

export const LocalSandboxConfig = Schema.Struct({
  root: Schema.String.check(Schema.isMinLength(1)),
});
export type LocalSandboxConfig = typeof LocalSandboxConfig.Type;

const DRIVER_KIND = SandboxDriverKind.make("local");
const RECORD_FILE = "sandbox.json";

const StoredSandbox = Schema.Struct({
  id: SandboxId,
  instanceId: SandboxInstanceId,
  state: Schema.Literals(["ready", "stopped"]),
  displayName: Schema.optional(SandboxDisplayName),
  idempotencyKey: Schema.optional(SandboxIdempotencyKey),
});
type StoredSandbox = typeof StoredSandbox.Type;

const decodeConfig = Schema.decodeUnknownEffect(LocalSandboxConfig);
const decodeCreateRequest = Schema.decodeUnknownEffect(SandboxCreateRequest);
const decodeSandboxId = Schema.decodeUnknownEffect(SandboxId);
const decodeStored = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredSandbox));
const encodeStored = Schema.encodeEffect(Schema.fromJsonString(StoredSandbox));

const isInside = (path: Path.Path, parent: string, candidate: string): boolean => {
  const relative = path.relative(parent, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export const LocalSandboxDriver = defineSandboxDriver({
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Local",
  },
  decodeConfig,
  open: Effect.fn("LocalSandboxDriver.open")(function* (input: {
    readonly instanceId: SandboxInstance["instanceId"];
    readonly config: LocalSandboxConfig;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const lock = yield* Semaphore.make(1);
    const instanceId = input.instanceId;
    const root = input.config.root;

    if (!path.isAbsolute(root)) {
      return yield* new SandboxConfigError({
        driver: DRIVER_KIND,
        instanceId,
      });
    }

    const driverError = (
      operation: SandboxDriverOperation,
      cause: unknown,
      sandboxId?: Sandbox["id"],
    ) =>
      new SandboxDriverError({
        driver: DRIVER_KIND,
        instanceId,
        operation,
        ...(sandboxId === undefined ? {} : { sandboxId }),
        cause,
      });

    const escapes = (operation: SandboxDriverOperation, sandboxId: Sandbox["id"]) =>
      new SandboxPathEscapesError({
        driver: DRIVER_KIND,
        instanceId,
        sandboxId,
        operation,
      });

    const missing = (sandboxId: Sandbox["id"]) =>
      new SandboxNotFoundError({
        driver: DRIVER_KIND,
        instanceId,
        sandboxId,
      });

    const requireId = (operation: SandboxDriverOperation, sandboxId: Sandbox["id"]) =>
      decodeSandboxId(sandboxId).pipe(Effect.mapError((cause) => driverError(operation, cause)));

    const rootReal = Effect.fnUntraced(function* (operation: SandboxDriverOperation) {
      // Callers already span probe, list, create, get, stop, and start.
      return yield* fs
        .realPath(root)
        .pipe(Effect.mapError((cause) => driverError(operation, cause)));
    });

    const ensureRoot = Effect.fnUntraced(function* (operation: SandboxDriverOperation) {
      const parent = yield* fs
        .stat(path.dirname(root))
        .pipe(Effect.mapError((cause) => driverError(operation, cause)));
      if (parent.type !== "Directory") {
        return yield* driverError(operation, parent.type);
      }
      yield* fs
        .makeDirectory(root, { recursive: true })
        .pipe(Effect.mapError((cause) => driverError(operation, cause)));
      const resolved = yield* rootReal(operation);
      return resolved;
    });

    // A linked record would write outside the sandbox the driver owns.
    const locateRecord = Effect.fnUntraced(function* (
      operation: SandboxDriverOperation,
      sandboxId: Sandbox["id"],
      sandboxReal: string,
    ) {
      const target = yield* resolveSymlinkTarget(path.join(sandboxReal, RECORD_FILE)).pipe(
        Effect.mapError((cause) => driverError(operation, cause, sandboxId)),
      );
      if (!isInside(path, sandboxReal, target)) {
        return yield* escapes(operation, sandboxId);
      }
      return target;
    });

    const sandboxRealPath = Effect.fnUntraced(function* (
      operation: SandboxDriverOperation,
      sandboxId: Sandbox["id"],
      rootResolved: string,
    ) {
      const directory = path.join(rootResolved, sandboxId);
      if (!isInside(path, rootResolved, directory)) {
        return yield* escapes(operation, sandboxId);
      }
      const resolved = yield* fs
        .realPath(directory)
        .pipe(Effect.mapError((cause) => driverError(operation, cause, sandboxId)));
      // A link to the root or a sibling is still lexically inside the root.
      if (path.relative(rootResolved, resolved) !== sandboxId) {
        return yield* escapes(operation, sandboxId);
      }
      return resolved;
    });

    const readStored = Effect.fnUntraced(function* (
      operation: SandboxDriverOperation,
      sandboxId: Sandbox["id"],
      rootResolved: string,
    ) {
      const directory = path.join(rootResolved, sandboxId);
      if (!isInside(path, rootResolved, directory)) {
        return yield* escapes(operation, sandboxId);
      }
      const exists = yield* fs
        .exists(directory)
        .pipe(Effect.mapError((cause) => driverError(operation, cause, sandboxId)));
      if (!exists) return null;
      const sandboxReal = yield* sandboxRealPath(operation, sandboxId, rootResolved);
      const info = yield* fs
        .stat(sandboxReal)
        .pipe(Effect.mapError((cause) => driverError(operation, cause, sandboxId)));
      if (info.type !== "Directory") {
        return yield* driverError(operation, info.type, sandboxId);
      }
      const recordPath = yield* locateRecord(operation, sandboxId, sandboxReal);
      const contents = yield* fs.readFileString(recordPath).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
        Effect.mapError((cause) => driverError(operation, cause, sandboxId)),
      );
      if (contents === null) return null;
      const stored = yield* decodeStored(contents).pipe(
        Effect.mapError((cause) => driverError(operation, cause, sandboxId)),
      );
      if (stored.id !== sandboxId || stored.instanceId !== instanceId) {
        return stored.instanceId === instanceId
          ? yield* driverError(operation, stored.id, sandboxId)
          : null;
      }
      return {
        sandbox: toSandbox(stored, sandboxReal),
        ...(stored.idempotencyKey === undefined ? {} : { idempotencyKey: stored.idempotencyKey }),
      };
    });

    const toSandbox = (stored: StoredSandbox, workspacePath: string): Sandbox => ({
      id: stored.id,
      instanceId: stored.instanceId,
      driver: DRIVER_KIND,
      state: stored.state,
      ...(stored.displayName === undefined ? {} : { displayName: stored.displayName }),
      workspacePath,
      endpoint: null,
    });

    const writeStored = Effect.fnUntraced(function* (
      operation: SandboxDriverOperation,
      sandboxReal: string,
      stored: StoredSandbox,
    ) {
      const contents = yield* encodeStored(stored).pipe(
        Effect.mapError((cause) => driverError(operation, cause, stored.id)),
      );
      const recordPath = yield* locateRecord(operation, stored.id, sandboxReal);
      yield* writeFileStringAtomically({ filePath: recordPath, contents }).pipe(
        Effect.mapError((cause) => driverError(operation, cause, stored.id)),
      );
    });

    const readAll = Effect.fnUntraced(function* (operation: SandboxDriverOperation) {
      const rootExists = yield* fs
        .exists(root)
        .pipe(Effect.mapError((cause) => driverError(operation, cause)));
      if (!rootExists) return [];
      const rootResolved = yield* rootReal(operation);
      const rootInfo = yield* fs
        .stat(rootResolved)
        .pipe(Effect.mapError((cause) => driverError(operation, cause)));
      if (rootInfo.type !== "Directory") {
        return yield* driverError(operation, rootInfo.type);
      }
      const names = yield* fs
        .readDirectory(rootResolved)
        .pipe(Effect.mapError((cause) => driverError(operation, cause)));
      const loaded: Array<{
        readonly sandbox: Sandbox;
        readonly idempotencyKey?: SandboxIdempotencyKey;
      }> = [];
      for (const name of names) {
        const id = yield* decodeSandboxId(name).pipe(Effect.option);
        if (Option.isNone(id)) continue;
        // list stays readable when one record is bad. create must see that failure so a
        // retry cannot miss the idempotency key hiding in it.
        const record = yield* readStored(operation, id.value, rootResolved).pipe(
          Effect.catchIf(
            () => operation === "list",
            () => Effect.succeed(null),
          ),
        );
        if (record !== null) loaded.push(record);
      }
      return loaded;
    });

    const transition = (
      sandboxId: Sandbox["id"],
      state: "ready" | "stopped",
      operation: SandboxDriverOperation,
    ) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const parsed = yield* requireId(operation, sandboxId);
          const rootExists = yield* fs
            .exists(root)
            .pipe(Effect.mapError((cause) => driverError(operation, cause, parsed)));
          if (!rootExists) return yield* missing(parsed);
          const rootResolved = yield* rootReal(operation);
          const current = yield* readStored(operation, parsed, rootResolved);
          if (current === null) return yield* missing(parsed);
          if (current.sandbox.state === state) return current.sandbox;
          const sandboxReal = yield* sandboxRealPath(operation, parsed, rootResolved);
          const stored: StoredSandbox = {
            id: parsed,
            instanceId,
            state,
            ...(current.sandbox.displayName === undefined
              ? {}
              : { displayName: current.sandbox.displayName }),
            ...(current.idempotencyKey === undefined
              ? {}
              : { idempotencyKey: current.idempotencyKey }),
          };
          yield* writeStored(operation, sandboxReal, stored);
          return toSandbox(stored, sandboxReal);
        }),
      );

    const snapshot = (available: boolean): SandboxDriverSnapshot => ({
      driver: DRIVER_KIND,
      instanceId,
      displayName: "Local",
      enabled: true,
      available,
    });

    const probe = Effect.fn("LocalSandboxDriver.probe")(function* () {
      const rootInfo = yield* fs.stat(root).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
      );
      if (rootInfo !== null) return snapshot(rootInfo.type === "Directory");
      const parent = yield* fs.stat(path.dirname(root)).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
      );
      return snapshot(parent !== null && parent.type === "Directory");
    });

    const list = Effect.fn("LocalSandboxDriver.list")(function* () {
      return yield* lock.withPermits(1)(
        readAll("list").pipe(Effect.map((records) => records.map((record) => record.sandbox))),
      );
    });

    const create = Effect.fn("LocalSandboxDriver.create")(function* (
      request: SandboxCreateRequest,
    ) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const operation = "create" satisfies SandboxDriverOperation;
          const parsed = yield* decodeCreateRequest(request).pipe(
            Effect.mapError((cause) => driverError(operation, cause)),
          );
          const rootResolved = yield* ensureRoot(operation);
          if (parsed.idempotencyKey !== undefined) {
            const existing = yield* readAll(operation);
            const matches = existing.filter(
              (record) => record.idempotencyKey === parsed.idempotencyKey,
            );
            const match = matches[0];
            if (matches.length > 1) {
              return yield* driverError(operation, matches.length);
            }
            if (match !== undefined) return match.sandbox;
          }
          const rawId = (yield* crypto.randomUUIDv4()).replaceAll("-", "").toLowerCase();
          const id = yield* decodeSandboxId(`s${rawId}`).pipe(
            Effect.mapError((cause) => driverError(operation, cause)),
          );
          const directory = path.join(rootResolved, id);
          if (!isInside(path, rootResolved, directory)) {
            return yield* escapes(operation, id);
          }
          if (
            yield* fs
              .exists(directory)
              .pipe(Effect.mapError((cause) => driverError(operation, cause, id)))
          ) {
            return yield* driverError(operation, "exists", id);
          }
          yield* fs
            .makeDirectory(directory)
            .pipe(Effect.mapError((cause) => driverError(operation, cause, id)));
          const sandboxReal = yield* sandboxRealPath(operation, id, rootResolved);
          const stored: StoredSandbox = {
            id,
            instanceId,
            state: "ready",
            ...(parsed.displayName === undefined ? {} : { displayName: parsed.displayName }),
            ...(parsed.idempotencyKey === undefined
              ? {}
              : { idempotencyKey: parsed.idempotencyKey }),
          };
          yield* writeStored(operation, sandboxReal, stored).pipe(
            Effect.tapError(() =>
              fs.remove(directory, { recursive: true }).pipe(Effect.ignore({ log: true })),
            ),
          );
          return toSandbox(stored, sandboxReal);
        }),
      );
    });

    const get = Effect.fn("LocalSandboxDriver.get")(function* (sandboxId: Sandbox["id"]) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const operation = "get" satisfies SandboxDriverOperation;
          const parsed = yield* requireId(operation, sandboxId);
          const rootExists = yield* fs
            .exists(root)
            .pipe(Effect.mapError((cause) => driverError(operation, cause, parsed)));
          if (!rootExists) return yield* missing(parsed);
          const rootResolved = yield* rootReal(operation);
          const record = yield* readStored(operation, parsed, rootResolved);
          if (record === null) return yield* missing(parsed);
          return record.sandbox;
        }),
      );
    });

    const stop = Effect.fn("LocalSandboxDriver.stop")(function* (sandboxId: Sandbox["id"]) {
      return yield* transition(sandboxId, "stopped", "stop");
    });

    const start = Effect.fn("LocalSandboxDriver.start")(function* (sandboxId: Sandbox["id"]) {
      return yield* transition(sandboxId, "ready", "start");
    });

    const isOperationError = (cause: unknown): cause is SandboxOperationError =>
      isSandboxDriverError(cause) ||
      isSandboxNotFoundError(cause) ||
      isSandboxPathEscapesError(cause);

    // Helpers such as symlink resolution ask for filesystem services themselves.
    const runHere = <A, E, R>(operation: SandboxDriverOperation, effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((cause): SandboxOperationError =>
          isOperationError(cause) ? cause : driverError(operation, cause),
        ),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: "Local",
      probe: runHere("probe", probe()),
      list: runHere("list", list()),
      create: (request) => runHere("create", create(request)),
      get: (sandboxId) => runHere("get", get(sandboxId)),
      stop: (sandboxId) => runHere("stop", stop(sandboxId)),
      start: (sandboxId) => runHere("start", start(sandboxId)),
    } satisfies SandboxInstance;
  }),
});

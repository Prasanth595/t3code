import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const layerServerConfig = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-store-test-" });

const layerServerSecretStore = () => Layer.provide(ServerSecretStore.layer, layerServerConfig());

const layerPermissionDeniedFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      readFile: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFile",
            pathOrDescriptor: path,
            description: "Permission denied while reading secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerPermissionDeniedSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerPermissionDeniedFileSystem),
  );

const layerRenameFailureFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      rename: (from, to) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "rename",
            pathOrDescriptor: `${String(from)} -> ${String(to)}`,
            description: "Permission denied while persisting secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerRenameFailureSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerRenameFailureFileSystem),
  );

const layerRemoveFailureFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      remove: (path, options) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "remove",
            pathOrDescriptor: String(path),
            description: `Permission denied while removing secret file.${options ? " options-set" : ""}`,
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerRemoveFailureSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerRemoveFailureFileSystem),
  );

it.layer(NodeServices.layer)("ServerSecretStore.layer", (it) => {
  it.effect("returns Option.none when a secret file does not exist", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const secret = yield* secretStore.get("missing-secret");

      assert.isTrue(Option.isNone(secret));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("reuses an existing secret instead of regenerating it", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const first = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      const second = yield* secretStore.getOrCreateRandom("session-signing-key", 32);

      assert.deepEqual(Array.from(second), Array.from(first));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("concurrent creators never read partial bytes and return the complete winner", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const writing = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let firstWrite = true;
      const closed = new Set<string>();
      const synced = new Set<string>();
      const secretStore = yield* ServerSecretStore.make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          link: Effect.fnUntraced(function* (from, to) {
            assert.isTrue(synced.has(from), "published file must be synced");
            assert.isTrue(closed.has(from), "published file must be closed");
            yield* fs.link(from, to);
          }),
          open: (path, options) =>
            Effect.gen(function* () {
              // Registered first so the real handle closes before this finalizer.
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  closed.add(path);
                }),
              );
              return yield* fs.open(path, options);
            }).pipe(
              Effect.map((file) => ({
                ...file,
                sync: file.sync.pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      synced.add(path);
                    }),
                  ),
                ),
                writeAll: Effect.fnUntraced(function* (bytes) {
                  if (firstWrite) {
                    firstWrite = false;
                    yield* file.writeAll(bytes.subarray(0, 2));
                    yield* Deferred.succeed(writing, undefined);
                    yield* Deferred.await(resume);
                    yield* file.writeAll(bytes.subarray(2));
                  } else {
                    yield* file.writeAll(bytes);
                  }
                }),
              })),
            ),
        }),
      );
      const first = yield* secretStore
        .getOrCreateRandom("session-signing-key", 32)
        .pipe(Effect.forkChild);
      yield* Deferred.await(writing);
      const duringWrite = yield* secretStore.get("session-signing-key");
      const second = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      yield* Deferred.succeed(resume, undefined);
      const firstValue = yield* Fiber.join(first);

      assert.isTrue(Option.isNone(duringWrite));
      assert.lengthOf(second, 32);
      assert.deepEqual(firstValue, second);
      assert.deepEqual(Option.getOrThrow(yield* secretStore.get("session-signing-key")), second);
      assert.deepEqual(yield* fs.readDirectory(config.secretsDir), ["session-signing-key.bin"]);
    }).pipe(Effect.provide(layerServerConfig())),
  );

  it.effect.each(["write", "interrupt", "sync"] as const)(
    "recovers after %s during creation without publishing or leaking temporary bytes",
    (failureStage) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const writing = yield* Deferred.make<void>();
        const failure = PlatformError.systemError({
          _tag: "Unknown",
          module: "FileSystem",
          method: failureStage,
          cause: Object.assign(new Error("Injected I/O failure"), { code: "EIO" }),
        });
        const secretStore = yield* ServerSecretStore.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            open: (path, options) =>
              fs.open(path, options).pipe(
                Effect.map((file) => ({
                  ...file,
                  sync: failureStage === "sync" ? Effect.fail(failure) : file.sync,
                  writeAll: Effect.fnUntraced(function* (bytes) {
                    yield* file.writeAll(failureStage === "sync" ? bytes : bytes.subarray(0, 2));
                    if (failureStage === "interrupt") {
                      yield* Deferred.succeed(writing, undefined);
                      return yield* Effect.never;
                    }
                    if (failureStage === "write") return yield* failure;
                  }),
                })),
              ),
          }),
        );
        const value = Uint8Array.from([1, 2, 3, 4]);
        if (failureStage === "interrupt") {
          const writer = yield* secretStore
            .create("session-signing-key", value)
            .pipe(Effect.forkChild);
          yield* Deferred.await(writing);
          yield* Fiber.interrupt(writer);
        } else {
          const error = yield* secretStore.create("session-signing-key", value).pipe(Effect.flip);
          assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
          assert.equal(error.cause, failure);
        }
        assert.isTrue(Option.isNone(yield* secretStore.get("session-signing-key")));
        assert.deepEqual(yield* fs.readDirectory(config.secretsDir), []);

        const recovered = yield* ServerSecretStore.make;
        yield* recovered.create("session-signing-key", value);
        assert.deepEqual(Option.getOrThrow(yield* recovered.get("session-signing-key")), value);
        assert.deepEqual(yield* fs.readDirectory(config.secretsDir), ["session-signing-key.bin"]);
      }).pipe(Effect.provide(layerServerConfig())),
  );

  it.effect.each([
    ["win32", "open", "EPERM", true],
    ["win32", "sync", "EPERM", true],
    ["win32", "sync", "EIO", false],
    ["linux", "sync", "EPERM", false],
    ["linux", "open", "EIO", false],
    ["linux", "sync", "EIO", false],
  ] as const)(
    "directory %s %s %s preserves bytes (success: %s)",
    ([platform, stage, code, succeeds]) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const failure = PlatformError.systemError({
          _tag: code === "EPERM" ? "PermissionDenied" : "Unknown",
          module: "FileSystem",
          method: stage,
          pathOrDescriptor: config.secretsDir,
          cause: Object.assign(new Error("Injected directory failure"), { code }),
        });
        const secretStore = yield* ServerSecretStore.make.pipe(
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            open: (path, options) => {
              if (path !== config.secretsDir) return fs.open(path, options);
              if (stage === "open") return Effect.fail(failure);
              // A regular handle lets the injected sync error run on Windows too,
              // where opening the directory can fail before sync is reached.
              return fs
                .open(`${config.secretsDir}/session-signing-key.bin`, options)
                .pipe(Effect.map((file) => ({ ...file, sync: Effect.fail(failure) })));
            },
          }),
        );
        const value = Uint8Array.from([1, 2, 3, 4]);
        const result = yield* secretStore.create("session-signing-key", value).pipe(Effect.result);
        if (result._tag === "Failure") {
          assert.instanceOf(result.failure, ServerSecretStore.SecretStorePersistError);
          assert.equal(result.failure.cause, failure);
        }
        assert.deepEqual(Option.getOrThrow(yield* secretStore.get("session-signing-key")), value);
        assert.deepEqual(yield* fs.readDirectory(config.secretsDir), ["session-signing-key.bin"]);
        assert.equal(result._tag, succeeds ? "Success" : "Failure");
      }).pipe(Effect.provide(layerServerConfig())),
  );

  it.effect(
    "keeps restrictive permissions and preserves an existing secret on duplicate creation",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const secretStore = yield* ServerSecretStore.make;
        const value = Uint8Array.from([1, 2, 3]);
        yield* secretStore.set("set-key", value);
        yield* secretStore.create("created-key", value);
        const duplicate = yield* secretStore
          .create("created-key", new Uint8Array(32))
          .pipe(Effect.flip);
        assert.isTrue(ServerSecretStore.isSecretAlreadyExistsError(duplicate));
        assert.deepEqual(Option.getOrThrow(yield* secretStore.get("created-key")), value);
        assert.deepEqual((yield* fs.readDirectory(config.secretsDir)).sort(), [
          "created-key.bin",
          "set-key.bin",
        ]);
        if ((yield* HostProcess.Platform) !== "win32") {
          assert.equal((yield* fs.stat(config.secretsDir)).mode & 0o777, 0o700);
          for (const name of ["set-key", "created-key"]) {
            assert.equal((yield* fs.stat(`${config.secretsDir}/${name}.bin`)).mode & 0o777, 0o600);
          }
        }
      }).pipe(Effect.provide(layerServerConfig())),
  );

  it.effect("propagates read failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.getOrCreateRandom("session-signing-key", 32));

      assert.instanceOf(error, ServerSecretStore.SecretStoreReadError);
      assert.include(error.message, "Failed to read secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerPermissionDeniedSecretStore())),
  );

  it.effect("propagates write failures instead of treating them as success", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(
        secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3])),
      );

      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.include(error.message, "Failed to persist secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerRenameFailureSecretStore())),
  );

  it.effect("propagates remove failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.remove("session-signing-key"));

      assert.instanceOf(error, ServerSecretStore.SecretStoreRemoveError);
      assert.include(error.message, "Failed to remove secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerRemoveFailureSecretStore())),
  );
});

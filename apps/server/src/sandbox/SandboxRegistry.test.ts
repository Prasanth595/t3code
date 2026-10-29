import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  SandboxDriverKind,
  SandboxId,
  SandboxInstanceId,
  type Sandbox,
  type SandboxInstanceConfig,
} from "@t3tools/sandbox-core/schema";
import { SandboxDriverError, SandboxNotFoundError } from "@t3tools/sandbox-core/server/errors";
import { LocalSandboxDriver } from "@t3tools/sandbox-local/server/driver";
import { defineSandboxDriver, type SandboxInstance } from "@t3tools/sandbox-core/server/driver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { LOCAL_SANDBOX_INSTANCE_ID } from "./builtInDrivers.ts";
import * as SandboxRegistry from "./SandboxRegistry.ts";

const decodeEmpty = Schema.decodeUnknownEffect(Schema.Struct({}));

const memoryDriver = (kind: string) => {
  let opens = 0;
  const driverKind = SandboxDriverKind.make(kind);
  const driver = defineSandboxDriver({
    driverKind,
    metadata: { displayName: kind },
    decodeConfig: decodeEmpty,
    open: (input) =>
      Effect.sync(() => {
        opens += 1;
        const sandboxes = new Map<Sandbox["id"], Sandbox>();
        let next = 0;
        const instance: SandboxInstance = {
          instanceId: input.instanceId,
          driverKind,
          displayName: kind,
          probe: Effect.succeed({
            driver: driverKind,
            instanceId: input.instanceId,
            displayName: kind,
            enabled: true,
            available: true,
          }),
          list: Effect.sync(() => [...sandboxes.values()]),
          create: (request) =>
            Effect.sync(() => {
              const id = SandboxId.make(`s${next}`);
              next += 1;
              const sandbox: Sandbox = {
                id,
                instanceId: input.instanceId,
                driver: driverKind,
                state: "ready",
                ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
                workspacePath: null,
                endpoint: null,
              };
              sandboxes.set(id, sandbox);
              return sandbox;
            }),
          get: (sandboxId) => {
            const sandbox = sandboxes.get(sandboxId);
            return sandbox === undefined
              ? Effect.fail(
                  new SandboxNotFoundError({
                    driver: driverKind,
                    instanceId: input.instanceId,
                    sandboxId,
                  }),
                )
              : Effect.succeed(sandbox);
          },
          stop: (sandboxId) =>
            Effect.fail(
              new SandboxDriverError({
                driver: driverKind,
                instanceId: input.instanceId,
                operation: "stop",
                sandboxId,
                cause: "unused",
              }),
            ),
          start: (sandboxId) =>
            Effect.fail(
              new SandboxDriverError({
                driver: driverKind,
                instanceId: input.instanceId,
                operation: "start",
                sandboxId,
                cause: "unused",
              }),
            ),
        };
        return instance;
      }),
  });
  return { driver, opens: () => opens };
};

const instance = (instanceId: string, driver: string, enabled: boolean): SandboxInstanceConfig => ({
  instanceId: SandboxInstanceId.make(instanceId),
  driver: SandboxDriverKind.make(driver),
  enabled,
  config: {},
});

describe("SandboxRegistry", () => {
  it.effect("routes each instance to its own sandboxes", () => {
    const memory = memoryDriver("memory");
    return Effect.gen(function* () {
      const registry = yield* SandboxRegistry.SandboxRegistry;
      const created = yield* registry.create({
        instanceId: SandboxInstanceId.make("one"),
        displayName: "A",
      });
      assert.equal(created.displayName, "A");
      assert.equal((yield* registry.list(SandboxInstanceId.make("one"))).length, 1);
      assert.equal((yield* registry.list(SandboxInstanceId.make("two"))).length, 0);
      const missing = yield* registry
        .get({
          instanceId: SandboxInstanceId.make("two"),
          sandboxId: created.id,
        })
        .pipe(Effect.flip);
      assert.equal(missing._tag, "SandboxNotFoundError");
      const unknown = yield* registry.list(SandboxInstanceId.make("missing")).pipe(Effect.flip);
      assert.equal(unknown._tag, "SandboxInstanceNotFoundError");
      assert.equal(memory.opens(), 2);
    }).pipe(
      Effect.provide(
        SandboxRegistry.layerWith({
          drivers: [memory.driver],
          instances: [instance("one", "memory", true), instance("two", "memory", true)],
        }),
      ),
    );
  });

  it.effect("does not open a disabled instance", () => {
    const memory = memoryDriver("memory");
    return Effect.gen(function* () {
      const registry = yield* SandboxRegistry.SandboxRegistry;
      const snapshots = yield* registry.listInstances;
      assert.equal(snapshots[0]?.enabled, false);
      assert.equal(snapshots[0]?.available, false);
      const disabled = yield* registry
        .create({ instanceId: SandboxInstanceId.make("off") })
        .pipe(Effect.flip);
      assert.equal(disabled._tag, "SandboxInstanceDisabledError");
      assert.equal(memory.opens(), 0);
    }).pipe(
      Effect.provide(
        SandboxRegistry.layerWith({
          drivers: [memory.driver],
          instances: [instance("off", "memory", false)],
        }),
      ),
    );
  });

  it.effect("rejects duplicate instances and unknown drivers before opening them", () =>
    Effect.gen(function* () {
      const memory = memoryDriver("memory");
      const duplicate = yield* SandboxRegistry.SandboxRegistry.pipe(
        Effect.provide(
          SandboxRegistry.layerWith({
            drivers: [memory.driver],
            instances: [instance("one", "memory", true), instance("one", "memory", true)],
          }),
        ),
        Effect.flip,
      );
      assert.equal(duplicate._tag, "SandboxInstanceConflictError");

      const unknown = yield* SandboxRegistry.SandboxRegistry.pipe(
        Effect.provide(
          SandboxRegistry.layerWith({
            drivers: [memory.driver],
            instances: [instance("one", "missing", true)],
          }),
        ),
        Effect.flip,
      );
      assert.equal(unknown._tag, "SandboxDriverNotFoundError");
      const duplicateDriver = yield* SandboxRegistry.SandboxRegistry.pipe(
        Effect.provide(
          SandboxRegistry.layerWith({
            drivers: [memory.driver, memory.driver],
            instances: [instance("one", "memory", true)],
          }),
        ),
        Effect.flip,
      );
      assert.equal(duplicateDriver._tag, "SandboxDriverConflictError");
      assert.equal(memory.opens(), 0);
    }),
  );

  it.effect("stays up when a sandbox driver rejects its configuration", () =>
    Effect.gen(function* () {
      const registry = yield* SandboxRegistry.SandboxRegistry;
      const snapshots = yield* registry.listInstances;
      assert.equal(snapshots[0]?.enabled, true);
      assert.equal(snapshots[0]?.available, false);
      const failed = yield* registry
        .create({ instanceId: SandboxInstanceId.make("local") })
        .pipe(Effect.flip);
      assert.equal(failed._tag, "SandboxConfigError");
    }).pipe(
      Effect.provide(
        SandboxRegistry.layerWith({
          drivers: [LocalSandboxDriver],
          instances: [
            {
              instanceId: SandboxInstanceId.make("local"),
              driver: SandboxDriverKind.make("local"),
              enabled: true,
              config: { root: "relative" },
            },
          ],
        }).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
  );

  it.effect("keeps a disabled unknown driver and a dying open off the boot path", () => {
    const dying = defineSandboxDriver({
      driverKind: SandboxDriverKind.make("dying"),
      metadata: { displayName: "Dying" },
      decodeConfig: decodeEmpty,
      open: () => Effect.die("boom"),
    });
    return Effect.gen(function* () {
      const registry = yield* SandboxRegistry.SandboxRegistry;
      const disabled = yield* registry
        .create({ instanceId: SandboxInstanceId.make("off") })
        .pipe(Effect.flip);
      assert.equal(disabled._tag, "SandboxInstanceDisabledError");
      const died = yield* registry
        .create({ instanceId: SandboxInstanceId.make("bad") })
        .pipe(Effect.flip);
      assert.equal(died._tag, "SandboxDriverError");
    }).pipe(
      Effect.provide(
        SandboxRegistry.layerWith({
          drivers: [dying],
          instances: [instance("off", "missing", false), instance("bad", "dying", true)],
        }),
      ),
    );
  });

  it.effect("leaves the built-in local sandbox disabled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const registry = yield* SandboxRegistry.SandboxRegistry;
      const local = (yield* registry.listInstances).find(
        (snapshot) => snapshot.instanceId === LOCAL_SANDBOX_INSTANCE_ID,
      );
      assert.equal(local?.enabled, false);
      assert.equal(local?.available, false);
      const disabled = yield* registry
        .create({ instanceId: LOCAL_SANDBOX_INSTANCE_ID })
        .pipe(Effect.flip);
      assert.equal(disabled._tag, "SandboxInstanceDisabledError");
      assert.equal(yield* fs.exists(path.join(config.baseDir, "sandboxes")), false);
    }).pipe(
      Effect.provide(
        SandboxRegistry.layer.pipe(
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-sandbox-registry-" }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});

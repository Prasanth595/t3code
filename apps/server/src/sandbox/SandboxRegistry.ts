import type { AnySandboxDriver, SandboxInstance } from "@t3tools/sandbox-core/server/driver";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  SandboxConfigError,
  SandboxDriverError,
  SandboxNotFoundError,
  SandboxPathEscapesError,
} from "@t3tools/sandbox-core/server/errors";
import * as Result from "effect/Result";
import {
  SandboxDriverKind,
  SandboxInstanceId,
  type Sandbox,
  type SandboxCreateInput,
  SandboxDisplayName,
  type SandboxDriverSnapshot,
  type SandboxId,
  type SandboxInstanceConfig,
} from "@t3tools/sandbox-core/schema";

import { BUILT_IN_SANDBOX_DRIVERS, builtInSandboxInstances } from "./builtInDrivers.ts";

export class SandboxInstanceNotFoundError extends Schema.TaggedError<SandboxInstanceNotFoundError>()(
  "SandboxInstanceNotFoundError",
  {
    instanceId: SandboxInstanceId,
  },
) {
  override get message(): string {
    return `No sandbox instance '${this.instanceId}' is configured.`;
  }
}

export class SandboxInstanceDisabledError extends Schema.TaggedError<SandboxInstanceDisabledError>()(
  "SandboxInstanceDisabledError",
  {
    instanceId: SandboxInstanceId,
    driver: SandboxDriverKind,
  },
) {
  override get message(): string {
    return `Sandbox instance '${this.instanceId}' is disabled.`;
  }
}

export class SandboxDriverNotFoundError extends Schema.TaggedError<SandboxDriverNotFoundError>()(
  "SandboxDriverNotFoundError",
  {
    driver: SandboxDriverKind,
    instanceId: SandboxInstanceId,
  },
) {
  override get message(): string {
    return `No sandbox driver '${this.driver}' is registered.`;
  }
}

export class SandboxDriverConflictError extends Schema.TaggedError<SandboxDriverConflictError>()(
  "SandboxDriverConflictError",
  {
    driver: SandboxDriverKind,
  },
) {
  override get message(): string {
    return `Sandbox driver '${this.driver}' is registered more than once.`;
  }
}

export class SandboxInstanceConflictError extends Schema.TaggedError<SandboxInstanceConflictError>()(
  "SandboxInstanceConflictError",
  {
    instanceId: SandboxInstanceId,
  },
) {
  override get message(): string {
    return `Sandbox instance '${this.instanceId}' is configured more than once.`;
  }
}

export type SandboxRegistryError =
  | SandboxInstanceNotFoundError
  | SandboxInstanceDisabledError
  | SandboxNotFoundError
  | SandboxDriverError
  | SandboxPathEscapesError
  | SandboxConfigError;

export type SandboxRegistryOpenError =
  | SandboxDriverNotFoundError
  | SandboxDriverConflictError
  | SandboxInstanceConflictError;

interface OpenEntry<R> {
  readonly spec: SandboxInstanceConfig;
  readonly driver: AnySandboxDriver<R> | null;
  readonly instance: SandboxInstance | null;
  readonly openError: SandboxDriverError | SandboxConfigError | null;
}

const openEntries = Effect.fn("SandboxRegistry.open")(function* <R>(input: {
  readonly drivers: ReadonlyArray<AnySandboxDriver<R>>;
  readonly instances: ReadonlyArray<SandboxInstanceConfig>;
}) {
  const byKind = new Map<SandboxInstanceConfig["driver"], AnySandboxDriver<R>>();
  for (const driver of input.drivers) {
    if (byKind.has(driver.driverKind)) {
      return yield* new SandboxDriverConflictError({ driver: driver.driverKind });
    }
    byKind.set(driver.driverKind, driver);
  }
  const seen = new Set<SandboxInstanceId>();
  for (const spec of input.instances) {
    if (seen.has(spec.instanceId)) {
      return yield* new SandboxInstanceConflictError({ instanceId: spec.instanceId });
    }
    seen.add(spec.instanceId);
    if (spec.enabled && !byKind.has(spec.driver)) {
      return yield* new SandboxDriverNotFoundError({
        driver: spec.driver,
        instanceId: spec.instanceId,
      });
    }
  }

  const entries: Array<OpenEntry<R>> = [];
  for (const spec of input.instances) {
    const driver = byKind.get(spec.driver) ?? null;
    if (!spec.enabled) {
      entries.push({ spec, driver, instance: null, openError: null });
      continue;
    }
    if (driver === null) {
      return yield* new SandboxDriverNotFoundError({
        driver: spec.driver,
        instanceId: spec.instanceId,
      });
    }
    const opened = yield* driver
      .openUnknown({
        instanceId: spec.instanceId,
        config: spec.config,
      })
      .pipe(
        Effect.catchCause((cause) => {
          const failed = Cause.findErrorOption(cause);
          if (Option.isSome(failed)) return Effect.fail(failed.value);
          return Effect.fail(
            new SandboxDriverError({
              driver: spec.driver,
              instanceId: spec.instanceId,
              operation: "open",
              cause,
            }),
          );
        }),
        Effect.result,
      );
    if (Result.isFailure(opened)) {
      entries.push({ spec, driver, instance: null, openError: opened.failure });
      continue;
    }
    entries.push({ spec, driver, instance: opened.success, openError: null });
  }
  return entries;
});

export class SandboxRegistry extends Context.Service<
  SandboxRegistry,
  {
    readonly listInstances: Effect.Effect<
      ReadonlyArray<SandboxDriverSnapshot>,
      SandboxRegistryError
    >;
    readonly list: (
      instanceId: SandboxInstanceId,
    ) => Effect.Effect<ReadonlyArray<Sandbox>, SandboxRegistryError>;
    readonly create: (input: SandboxCreateInput) => Effect.Effect<Sandbox, SandboxRegistryError>;
    readonly get: (input: {
      readonly instanceId: SandboxInstanceId;
      readonly sandboxId: SandboxId;
    }) => Effect.Effect<Sandbox, SandboxRegistryError>;
    readonly stop: (input: {
      readonly instanceId: SandboxInstanceId;
      readonly sandboxId: SandboxId;
    }) => Effect.Effect<Sandbox, SandboxRegistryError>;
    readonly start: (input: {
      readonly instanceId: SandboxInstanceId;
      readonly sandboxId: SandboxId;
    }) => Effect.Effect<Sandbox, SandboxRegistryError>;
  }
>()("t3/sandbox/SandboxRegistry") {}

const make = Effect.fn("SandboxRegistry.make")(function* <R>(input: {
  readonly drivers: ReadonlyArray<AnySandboxDriver<R>>;
  readonly instances: ReadonlyArray<SandboxInstanceConfig>;
}) {
  const entries = yield* openEntries(input);
  const byId = new Map(entries.map((entry) => [entry.spec.instanceId, entry]));

  const requireEnabled = Effect.fn("SandboxRegistry.requireEnabled")(function* (
    instanceId: SandboxInstanceId,
  ) {
    const entry = byId.get(instanceId);
    if (entry === undefined) {
      return yield* new SandboxInstanceNotFoundError({ instanceId });
    }
    if (!entry.spec.enabled) {
      return yield* new SandboxInstanceDisabledError({
        instanceId,
        driver: entry.spec.driver,
      });
    }
    if (entry.openError !== null) {
      return yield* entry.openError;
    }
    if (entry.instance === null) {
      return yield* new SandboxInstanceNotFoundError({ instanceId });
    }
    return entry.instance;
  });

  const listInstances = Effect.fn("SandboxRegistry.listInstances")(function* () {
    return yield* Effect.forEach(
      entries,
      (entry) => {
        if (entry.instance === null) {
          return Effect.succeed({
            driver: entry.spec.driver,
            instanceId: entry.spec.instanceId,
            displayName:
              entry.driver?.metadata.displayName ?? SandboxDisplayName.make(entry.spec.driver),
            enabled: entry.spec.enabled,
            available: false,
          } satisfies SandboxDriverSnapshot);
        }
        return entry.instance.probe;
      },
      { concurrency: "unbounded" },
    );
  });

  const list = Effect.fn("SandboxRegistry.list")(function* (instanceId: SandboxInstanceId) {
    const instance = yield* requireEnabled(instanceId);
    return yield* instance.list;
  });

  const create = Effect.fn("SandboxRegistry.create")(function* (input: SandboxCreateInput) {
    const instance = yield* requireEnabled(input.instanceId);
    return yield* instance.create({
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    });
  });

  const get = Effect.fn("SandboxRegistry.get")(function* (input: {
    readonly instanceId: SandboxInstanceId;
    readonly sandboxId: SandboxId;
  }) {
    const instance = yield* requireEnabled(input.instanceId);
    return yield* instance.get(input.sandboxId);
  });

  const stop = Effect.fn("SandboxRegistry.stop")(function* (input: {
    readonly instanceId: SandboxInstanceId;
    readonly sandboxId: SandboxId;
  }) {
    const instance = yield* requireEnabled(input.instanceId);
    return yield* instance.stop(input.sandboxId);
  });

  const start = Effect.fn("SandboxRegistry.start")(function* (input: {
    readonly instanceId: SandboxInstanceId;
    readonly sandboxId: SandboxId;
  }) {
    const instance = yield* requireEnabled(input.instanceId);
    return yield* instance.start(input.sandboxId);
  });

  return SandboxRegistry.of({
    listInstances: listInstances(),
    list,
    create,
    get,
    stop,
    start,
  });
});

export const layerWith = <R>(input: {
  readonly drivers: ReadonlyArray<AnySandboxDriver<R>>;
  readonly instances: ReadonlyArray<SandboxInstanceConfig>;
}) => Layer.effect(SandboxRegistry, make(input));

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const instances = yield* builtInSandboxInstances;
    return layerWith({
      drivers: BUILT_IN_SANDBOX_DRIVERS,
      instances,
    });
  }),
);

import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

import type {
  Sandbox,
  SandboxCreateRequest,
  SandboxDriverKind,
  SandboxDriverSnapshot,
  SandboxId,
  SandboxInstanceId,
} from "../schema.ts";
import { SandboxConfigError, SandboxDriverError, type SandboxOperationError } from "./errors.ts";

export interface OpenSandboxInput<Config> {
  readonly instanceId: SandboxInstanceId;
  readonly config: Config;
}

export interface OpenUnknownSandboxInput {
  readonly instanceId: SandboxInstanceId;
  readonly config: unknown;
}

export interface SandboxInstance {
  readonly instanceId: SandboxInstanceId;
  readonly driverKind: SandboxDriverKind;
  readonly displayName: string;
  readonly probe: Effect.Effect<SandboxDriverSnapshot, SandboxOperationError>;
  readonly list: Effect.Effect<ReadonlyArray<Sandbox>, SandboxOperationError>;
  readonly create: (request: SandboxCreateRequest) => Effect.Effect<Sandbox, SandboxOperationError>;
  readonly get: (sandboxId: SandboxId) => Effect.Effect<Sandbox, SandboxOperationError>;
  readonly stop: (sandboxId: SandboxId) => Effect.Effect<Sandbox, SandboxOperationError>;
  readonly start: (sandboxId: SandboxId) => Effect.Effect<Sandbox, SandboxOperationError>;
}

export interface SandboxDriver<Config, R = never> {
  readonly driverKind: SandboxDriverKind;
  readonly metadata: {
    readonly displayName: string;
  };
  readonly decodeConfig: (input: unknown) => Effect.Effect<Config, Schema.SchemaError, never>;
  readonly open: (
    input: OpenSandboxInput<Config>,
  ) => Effect.Effect<SandboxInstance, SandboxDriverError | SandboxConfigError, R>;
}

export interface AnySandboxDriver<R = never> {
  readonly driverKind: SandboxDriverKind;
  readonly metadata: {
    readonly displayName: string;
  };
  readonly openUnknown: (
    input: OpenUnknownSandboxInput,
  ) => Effect.Effect<SandboxInstance, SandboxDriverError | SandboxConfigError, R>;
}

export const defineSandboxDriver = <Config, R>(
  driver: SandboxDriver<Config, R>,
): SandboxDriver<Config, R> & AnySandboxDriver<R> => ({
  ...driver,
  openUnknown: (input) =>
    driver.decodeConfig(input.config).pipe(
      Effect.mapError(
        (cause) =>
          new SandboxConfigError({
            driver: driver.driverKind,
            instanceId: input.instanceId,
            cause,
          }),
      ),
      Effect.flatMap((config) =>
        driver.open({
          instanceId: input.instanceId,
          config,
        }),
      ),
    ),
});

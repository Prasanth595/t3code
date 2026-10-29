import * as Schema from "effect/Schema";

import {
  SandboxDriverKind,
  SandboxDriverOperation,
  SandboxId,
  SandboxInstanceId,
} from "../schema.ts";

export class SandboxDriverError extends Schema.TaggedError<SandboxDriverError>()(
  "SandboxDriverError",
  {
    driver: SandboxDriverKind,
    instanceId: SandboxInstanceId,
    operation: SandboxDriverOperation,
    sandboxId: Schema.optional(SandboxId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Sandbox driver '${this.driver}' failed during '${this.operation}'.`;
  }
}

export class SandboxNotFoundError extends Schema.TaggedError<SandboxNotFoundError>()(
  "SandboxNotFoundError",
  {
    driver: SandboxDriverKind,
    instanceId: SandboxInstanceId,
    sandboxId: SandboxId,
  },
) {
  override get message(): string {
    return `Sandbox '${this.sandboxId}' was not found.`;
  }
}

export class SandboxConfigError extends Schema.TaggedError<SandboxConfigError>()(
  "SandboxConfigError",
  {
    driver: SandboxDriverKind,
    instanceId: SandboxInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Sandbox instance '${this.instanceId}' rejected its configuration.`;
  }
}

export class SandboxPathEscapesError extends Schema.TaggedError<SandboxPathEscapesError>()(
  "SandboxPathEscapesError",
  {
    driver: SandboxDriverKind,
    instanceId: SandboxInstanceId,
    sandboxId: SandboxId,
    operation: SandboxDriverOperation,
  },
) {
  override get message(): string {
    return `Sandbox '${this.sandboxId}' points outside its root.`;
  }
}

export type SandboxOperationError =
  | SandboxDriverError
  | SandboxNotFoundError
  | SandboxPathEscapesError;

export const isSandboxDriverError = Schema.is(SandboxDriverError);
export const isSandboxNotFoundError = Schema.is(SandboxNotFoundError);
export const isSandboxPathEscapesError = Schema.is(SandboxPathEscapesError);

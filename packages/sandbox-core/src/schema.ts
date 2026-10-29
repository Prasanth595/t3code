import { PortSchema, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const sandboxSlug = TrimmedNonEmptyString.check(
  Schema.isMaxLength(80),
  Schema.isPattern(/^[a-z][a-z0-9_-]*$/),
);

export const SandboxDriverKind = sandboxSlug.pipe(Schema.brand("SandboxDriverKind"));
export type SandboxDriverKind = typeof SandboxDriverKind.Type;

export const SandboxInstanceId = sandboxSlug.pipe(Schema.brand("SandboxInstanceId"));
export type SandboxInstanceId = typeof SandboxInstanceId.Type;

export const SandboxId = sandboxSlug.pipe(Schema.brand("SandboxId"));
export type SandboxId = typeof SandboxId.Type;

export const SandboxDisplayName = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
export type SandboxDisplayName = typeof SandboxDisplayName.Type;

export const SandboxIdempotencyKey = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export type SandboxIdempotencyKey = typeof SandboxIdempotencyKey.Type;

export const SandboxState = Schema.Literals(["starting", "ready", "stopped", "failed"]);
export type SandboxState = typeof SandboxState.Type;

export const SandboxDriverOperation = Schema.Literals([
  "open",
  "probe",
  "list",
  "create",
  "get",
  "stop",
  "start",
]);
export type SandboxDriverOperation = typeof SandboxDriverOperation.Type;

export const SandboxEndpoint = Schema.Struct({
  protocol: TrimmedNonEmptyString.check(
    Schema.isMaxLength(16),
    Schema.isPattern(/^[a-z][a-z0-9+.-]*$/),
  ),
  host: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  port: Schema.optional(PortSchema),
});
export type SandboxEndpoint = typeof SandboxEndpoint.Type;

export const Sandbox = Schema.Struct({
  id: SandboxId,
  instanceId: SandboxInstanceId,
  driver: SandboxDriverKind,
  state: SandboxState,
  displayName: Schema.optional(SandboxDisplayName),
  workspacePath: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))),
  endpoint: Schema.NullOr(SandboxEndpoint),
});
export type Sandbox = typeof Sandbox.Type;

export const SandboxDriverSnapshot = Schema.Struct({
  driver: SandboxDriverKind,
  instanceId: SandboxInstanceId,
  displayName: SandboxDisplayName,
  enabled: Schema.Boolean,
  available: Schema.Boolean,
});
export type SandboxDriverSnapshot = typeof SandboxDriverSnapshot.Type;

export const SandboxCreateRequest = Schema.Struct({
  displayName: Schema.optional(SandboxDisplayName),
  idempotencyKey: Schema.optional(SandboxIdempotencyKey),
});
export type SandboxCreateRequest = typeof SandboxCreateRequest.Type;

export const SandboxCreateInput = Schema.Struct({
  instanceId: SandboxInstanceId,
  displayName: Schema.optional(SandboxDisplayName),
  idempotencyKey: Schema.optional(SandboxIdempotencyKey),
});
export type SandboxCreateInput = typeof SandboxCreateInput.Type;

/** Drivers decode `config` themselves. Unknown drivers keep their envelope verbatim. */
export const SandboxInstanceConfig = Schema.Struct({
  instanceId: SandboxInstanceId,
  driver: SandboxDriverKind,
  enabled: Schema.Boolean,
  config: Schema.Unknown,
});
export type SandboxInstanceConfig = typeof SandboxInstanceConfig.Type;

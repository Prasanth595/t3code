import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Surfaced to the registry, which marks the offending entry as an "unavailable"
 * shadow snapshot rather than crashing the server.
 */
export class ProviderDriverError extends Schema.TaggedError<ProviderDriverError>()(
  "ProviderDriverError",
  {
    driver: ProviderDriverKind,
    instanceId: ProviderInstanceId,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider driver '${this.driver}' failed to create instance '${this.instanceId}': ${this.detail}`;
  }
}

export class ProviderCredentialError extends Schema.TaggedError<ProviderCredentialError>()(
  "ProviderCredentialError",
  {
    operation: Schema.Literals(["get", "set", "remove"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} stored provider credentials.`;
  }
}

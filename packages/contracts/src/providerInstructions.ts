import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const PROVIDER_INSTRUCTIONS_MAX_BYTES = 256 * 1024;

export const ProviderInstructionsFileName = Schema.Literals(["AGENTS.md", "CLAUDE.md"]);
export type ProviderInstructionsFileName = typeof ProviderInstructionsFileName.Type;

/** Without a project, the target is the provider's user-level file on the environment. */
export const ProviderInstructionsReadInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: Schema.optionalKey(ProjectId),
});
export type ProviderInstructionsReadInput = typeof ProviderInstructionsReadInput.Type;

export const ProviderInstructionsReadResult = Schema.Struct({
  fileName: ProviderInstructionsFileName,
  path: TrimmedNonEmptyString,
  /** Text to start editing from. A missing CLAUDE.md starts as an import of an existing AGENTS.md. */
  contents: Schema.String,
  /** Opaque; pass it back to write so a file changed in between is not overwritten. */
  revision: TrimmedNonEmptyString,
  state: Schema.Literals(["missing", "ready", "too_large", "binary"]),
});
export type ProviderInstructionsReadResult = typeof ProviderInstructionsReadResult.Type;

export const ProviderInstructionsWriteInput = Schema.Struct({
  ...ProviderInstructionsReadInput.fields,
  contents: Schema.String,
  revision: TrimmedNonEmptyString,
});
export type ProviderInstructionsWriteInput = typeof ProviderInstructionsWriteInput.Type;

export const ProviderInstructionsWriteResult = Schema.Struct({
  revision: TrimmedNonEmptyString,
  byteLength: NonNegativeInt,
});
export type ProviderInstructionsWriteResult = typeof ProviderInstructionsWriteResult.Type;

const ProviderInstructionsFailure = Schema.Literals([
  "provider_not_found",
  "project_not_found",
  "global_unsupported",
  "outside_workspace",
  "not_file",
  "too_large",
  "binary",
  "operation_failed",
]);

const FAILURE_MESSAGES: Record<typeof ProviderInstructionsFailure.Type, string> = {
  provider_not_found: "This provider is not available on this device.",
  project_not_found: "This project is not available on this device.",
  global_unsupported: "This provider has no user-level instructions file.",
  outside_workspace: "The instructions file links outside the project.",
  not_file: "The instructions path is not a regular file.",
  too_large: "The instructions are too large to save.",
  binary: "The instructions file is not text.",
  operation_failed: "The instructions file could not be accessed.",
};

export class ProviderInstructionsError extends Schema.TaggedError<ProviderInstructionsError>()(
  "ProviderInstructionsError",
  {
    failure: ProviderInstructionsFailure,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return FAILURE_MESSAGES[this.failure];
  }
}

export class ProviderInstructionsConflictError extends Schema.TaggedError<ProviderInstructionsConflictError>()(
  "ProviderInstructionsConflictError",
  {},
) {
  override get message(): string {
    return "The instructions file changed on disk after it was opened.";
  }
}

export const isProviderInstructionsConflictError = Schema.is(ProviderInstructionsConflictError);

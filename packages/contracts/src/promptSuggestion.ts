import * as Schema from "effect/Schema";

import { RunId, ThreadId } from "./baseSchemas.ts";

/** Keyed by run so each settled turn gets one suggestion and later turns cannot reuse it. */
export const PromptSuggestionInput = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
});
export type PromptSuggestionInput = typeof PromptSuggestionInput.Type;

export const PromptSuggestionResult = Schema.Struct({
  /** Null when suggestions are off, the run is not the thread's settled latest, or generation failed. */
  suggestion: Schema.NullOr(Schema.String),
});
export type PromptSuggestionResult = typeof PromptSuggestionResult.Type;

export class PromptSuggestionError extends Schema.TaggedError<PromptSuggestionError>()(
  "PromptSuggestionError",
  {
    threadId: ThreadId,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

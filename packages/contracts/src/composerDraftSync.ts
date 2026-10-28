import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const THREAD_COMPOSER_DRAFT_PREFIX = "thread:";
export const NEW_TASK_COMPOSER_DRAFT_PREFIX = "new-task:";
export const COMPOSER_DRAFT_SYNC_KEY_MAX_LENGTH = 200;
export const COMPOSER_DRAFT_SYNC_PUT_MAX = 32;

const isComposerDraftSyncKey = Schema.makeFilter(
  (value: string) => {
    const id = value.startsWith(THREAD_COMPOSER_DRAFT_PREFIX)
      ? value.slice(THREAD_COMPOSER_DRAFT_PREFIX.length)
      : value.startsWith(NEW_TASK_COMPOSER_DRAFT_PREFIX)
        ? value.slice(NEW_TASK_COMPOSER_DRAFT_PREFIX.length)
        : null;
    return (
      id !== null &&
      id.length > 0 &&
      !id.includes("\n") &&
      !id.includes("\r") &&
      value.length <= COMPOSER_DRAFT_SYNC_KEY_MAX_LENGTH
    );
  },
  { expected: "thread:<id> or new-task:<id>" },
);

export const ComposerDraftSyncKey = TrimmedNonEmptyString.check(isComposerDraftSyncKey);
export type ComposerDraftSyncKey = typeof ComposerDraftSyncKey.Type;

/**
 * Unsent composer text shared by every client of one environment.
 * Attachment bytes stay on the device that added them.
 */
export const SyncedComposerDraft = Schema.Struct({
  key: ComposerDraftSyncKey,
  prompt: Schema.String.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  updatedAt: IsoDateTime,
  deleted: Schema.Boolean,
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type SyncedComposerDraft = typeof SyncedComposerDraft.Type;

export const ComposerDraftSyncSnapshot = Schema.Struct({
  type: Schema.Literal("snapshot"),
  drafts: Schema.Array(SyncedComposerDraft),
});
export type ComposerDraftSyncSnapshot = typeof ComposerDraftSyncSnapshot.Type;

export const ComposerDraftSyncUpsert = Schema.Struct({
  type: Schema.Literal("upsert"),
  draft: SyncedComposerDraft,
});
export type ComposerDraftSyncUpsert = typeof ComposerDraftSyncUpsert.Type;

export const ComposerDraftSyncEvent = Schema.Union([
  ComposerDraftSyncSnapshot,
  ComposerDraftSyncUpsert,
]);
export type ComposerDraftSyncEvent = typeof ComposerDraftSyncEvent.Type;

export const ComposerDraftSyncSubscribeInput = Schema.Struct({});
export type ComposerDraftSyncSubscribeInput = typeof ComposerDraftSyncSubscribeInput.Type;

export const ComposerDraftSyncPutInput = Schema.Struct({
  drafts: Schema.Array(SyncedComposerDraft).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(COMPOSER_DRAFT_SYNC_PUT_MAX),
  ),
});
export type ComposerDraftSyncPutInput = typeof ComposerDraftSyncPutInput.Type;

export const ComposerDraftSyncPutResult = Schema.Struct({
  accepted: Schema.Array(ComposerDraftSyncKey),
});
export type ComposerDraftSyncPutResult = typeof ComposerDraftSyncPutResult.Type;

export class ComposerDraftSyncError extends Schema.TaggedError<ComposerDraftSyncError>()(
  "ComposerDraftSyncError",
  {
    message: Schema.String,
  },
) {}

export interface ComposerDraftSyncLocal {
  readonly prompt: string;
  readonly updatedAt: string | null;
  readonly deleted: boolean;
  readonly projectId?: ProjectId;
  readonly threadId?: ThreadId;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}

export type ComposerDraftSyncDecision =
  | { readonly action: "noop" }
  | { readonly action: "remember"; readonly updatedAt: string }
  | { readonly action: "apply"; readonly draft: SyncedComposerDraft }
  | { readonly action: "push"; readonly draft: SyncedComposerDraft };

function draftBody(draft: {
  readonly prompt: string;
  readonly deleted: boolean;
  readonly projectId?: ProjectId | undefined;
  readonly threadId?: ThreadId | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
}): string {
  return JSON.stringify([
    draft.deleted,
    draft.prompt,
    draft.projectId ?? null,
    draft.threadId ?? null,
    draft.modelSelection ?? null,
    draft.runtimeMode ?? null,
    draft.interactionMode ?? null,
  ]);
}

function toSynced(
  key: ComposerDraftSyncKey,
  source: ComposerDraftSyncLocal,
  updatedAt: string,
): SyncedComposerDraft {
  return {
    key,
    prompt: source.deleted ? "" : source.prompt,
    updatedAt,
    deleted: source.deleted || source.prompt.trim().length === 0,
    ...(source.projectId === undefined ? {} : { projectId: source.projectId }),
    ...(source.threadId === undefined ? {} : { threadId: source.threadId }),
    ...(source.modelSelection === undefined ? {} : { modelSelection: source.modelSelection }),
    ...(source.runtimeMode === undefined ? {} : { runtimeMode: source.runtimeMode }),
    ...(source.interactionMode === undefined ? {} : { interactionMode: source.interactionMode }),
  };
}

/**
 * Last write wins. A draft this device has never stamped keeps the text the
 * user can see, and adopts a remote draft when the local composer is empty.
 */
export function decideComposerDraftSync(input: {
  readonly key: ComposerDraftSyncKey;
  readonly local: ComposerDraftSyncLocal | null;
  readonly remote: SyncedComposerDraft | null;
  readonly now: string;
}): ComposerDraftSyncDecision {
  const { key, local, remote, now } = input;
  if (local === null && remote === null) return { action: "noop" };
  if (local === null && remote !== null) return { action: "apply", draft: remote };
  if (local !== null && remote === null) {
    if (local.deleted || local.prompt.trim().length === 0) return { action: "noop" };
    return { action: "push", draft: toSynced(key, local, local.updatedAt ?? now) };
  }
  if (local === null || remote === null) return { action: "noop" };

  if (draftBody(local) === draftBody(remote)) {
    return local.updatedAt === remote.updatedAt
      ? { action: "noop" }
      : { action: "remember", updatedAt: local.updatedAt ?? remote.updatedAt };
  }

  if (local.updatedAt === null) {
    if (local.deleted || local.prompt.trim().length === 0) return { action: "apply", draft: remote };
    return { action: "push", draft: toSynced(key, local, now) };
  }
  if (local.updatedAt > remote.updatedAt) {
    return { action: "push", draft: toSynced(key, local, local.updatedAt) };
  }
  return { action: "apply", draft: remote };
}

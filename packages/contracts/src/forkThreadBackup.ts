/**
 * Fork: thread backups. A server with the setting `threadBackupMachine` sends the transcript of
 * each changed thread to that machine of the machine map. While the source is offline, a client
 * reads the backup from the machine that holds it and continues the thread there.
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestrationV2ThreadTranscript } from "./orchestrationV2.ts";

export const ForkThreadBackupProject = Schema.Struct({
  title: Schema.String,
  workspaceRoot: Schema.String,
  /** `repositoryGroupingKeyOf` of the project, the same on every machine. */
  repositoryKey: Schema.NullOr(Schema.String),
});
export type ForkThreadBackupProject = typeof ForkThreadBackupProject.Type;

export const ForkThreadBackup = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceLabel: Schema.String,
  project: Schema.NullOr(ForkThreadBackupProject),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  /** The newest items that fit the attachment size limit. */
  transcript: OrchestrationV2ThreadTranscript,
  /** Older items that did not fit. */
  omittedItems: Schema.Number,
});
export type ForkThreadBackup = typeof ForkThreadBackup.Type;

export const ForkThreadBackupGetInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ForkThreadBackupGetInput = typeof ForkThreadBackupGetInput.Type;

/** The HTTP route on the backup machine that a source machine posts to. */
export const FORK_THREAD_BACKUP_ROUTE = "/api/fork/thread-backups";

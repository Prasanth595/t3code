/**
 * The transcript of a thread for continuing it in another thread, possibly on another
 * environment. A connected source answers itself. While it is offline, the transcript comes from
 * this client's cached copy of the thread or from a fork thread backup that another connected
 * environment holds (`threadBackupMachine`), whichever is newer.
 */
import {
  type EnvironmentId,
  type ForkThreadBackup,
  type OrchestrationV2ThreadTranscript,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  repositoryGroupingKeyOf,
  type RepositoryIdentity,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { newestTranscriptItems } from "@t3tools/shared/threadTranscript";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import { request } from "../rpc/client.ts";

export type ThreadContinuationSource =
  | { readonly _tag: "live" }
  | { readonly _tag: "cache" }
  | { readonly _tag: "backup"; readonly heldBy: EnvironmentId; readonly backup: ForkThreadBackup };

export interface ThreadContinuation {
  readonly transcript: OrchestrationV2ThreadTranscript;
  readonly source: ThreadContinuationSource;
  /** Older items that the transcript left out. */
  readonly omittedItems: number;
}

const BACKUP_REQUEST_TIMEOUT = "5 seconds";

const loadCachedTranscript = (environmentId: EnvironmentId, threadId: ThreadId) =>
  Effect.gen(function* () {
    const cache = yield* Effect.serviceOption(Persistence.EnvironmentCacheStore);
    if (Option.isNone(cache)) return null;
    const cached = yield* cache.value
      .loadThread(environmentId, threadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(cached)) return null;
    const { projection } = cached.value;
    const fitted = newestTranscriptItems(
      projection.visibleTurnItems,
      PROVIDER_SEND_TURN_MAX_FILE_BYTES,
    );
    return {
      transcript: {
        threadId: projection.thread.id,
        title: projection.thread.title,
        updatedAt: projection.updatedAt,
        items: fitted.items,
      },
      source: { _tag: "cache" },
      omittedItems: fitted.omittedItems,
    } satisfies ThreadContinuation;
  });

/** Asks every other registered environment for its backup. One that cannot answer counts as none. */
const loadBackupTranscript = (environmentId: EnvironmentId, threadId: ThreadId) =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const entries = yield* SubscriptionRef.get(registry.entries);
    const holders = [...entries.keys()].filter((candidate) => candidate !== environmentId);
    const backups = yield* Effect.forEach(
      holders,
      (heldBy) =>
        registry
          .run(heldBy, request(WS_METHODS.forkThreadBackupGet, { environmentId, threadId }))
          .pipe(
            Effect.timeout(BACKUP_REQUEST_TIMEOUT),
            Effect.map((backup) => (backup === null ? null : { heldBy, backup })),
            Effect.orElseSucceed(() => null),
          ),
      { concurrency: "unbounded" },
    );
    let newest: ThreadContinuation | null = null;
    for (const found of backups) {
      if (found === null) continue;
      if (
        newest === null ||
        DateTime.isGreaterThan(found.backup.transcript.updatedAt, newest.transcript.updatedAt)
      ) {
        newest = {
          transcript: found.backup.transcript,
          source: { _tag: "backup", heldBy: found.heldBy, backup: found.backup },
          omittedItems: found.backup.omittedItems,
        };
      }
    }
    return newest;
  });

/** The newest copy of a thread that this client can read without its source environment. */
export const loadOfflineThreadContinuation = Effect.fn(
  "clientRuntime.state.loadOfflineThreadContinuation",
)(function* (environmentId: EnvironmentId, threadId: ThreadId) {
  const [cached, backup] = yield* Effect.all(
    [loadCachedTranscript(environmentId, threadId), loadBackupTranscript(environmentId, threadId)],
    { concurrency: "unbounded" },
  );
  if (cached === null) return backup;
  if (backup === null) return cached;
  return DateTime.isGreaterThan(backup.transcript.updatedAt, cached.transcript.updatedAt)
    ? backup
    : cached;
});

interface ContinuationProjectCandidate {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
  readonly isScratch?: true;
}

/**
 * The project to continue in: on a reachable environment other than the source, the same
 * repository first, else a project with the same title. Null lets the user pick.
 */
export function continuationProject<Project extends ContinuationProjectCandidate>(input: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly repositoryKey: string | null;
  readonly projectTitle: string | null;
  readonly projects: ReadonlyArray<Project>;
  readonly reachableEnvironmentIds: ReadonlySet<EnvironmentId>;
}): Project | null {
  const candidates = input.projects.filter(
    (project) =>
      project.isScratch !== true &&
      project.environmentId !== input.sourceEnvironmentId &&
      input.reachableEnvironmentIds.has(project.environmentId),
  );
  const sameRepository =
    input.repositoryKey === null
      ? undefined
      : candidates.find(
          (project) =>
            project.repositoryIdentity != null &&
            repositoryGroupingKeyOf(project.repositoryIdentity) === input.repositoryKey,
        );
  return (
    sameRepository ?? candidates.find((project) => project.title === input.projectTitle) ?? null
  );
}

/** The first message of the continuing thread. The user reads and edits it before sending. */
export function continuationPrompt(input: {
  readonly title: string;
  readonly sourceLabel: string;
  readonly branch: string | null;
  readonly omittedItems: number;
}): string {
  const omitted =
    input.omittedItems > 0
      ? ` It holds the newest items; ${input.omittedItems} older ${input.omittedItems === 1 ? "item is" : "items are"} not included.`
      : "";
  const branch =
    input.branch === null
      ? ""
      : ` That thread worked on the branch \`${input.branch}\`. Fetch it if it was pushed, and check which of its changes are here before you change code.`;
  return `Continue the thread "${input.title}" from ${input.sourceLabel}. Its history is attached.${omitted}${branch} Summarize where it stood in a few lines, then continue the work.`;
}

import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";

/**
 * Agent sessions as the factory sees them: softfac's `Sessions` trait
 * (`src/t3.rs`) over T3's services, called in-process instead of over the
 * wire. Everything above this file uses these types, never T3's.
 */

/** Where a run is in its life, as T3 Code names it. */
export const RUN_STATUSES = [
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** The model a thread runs on, as T3 Code names it. */
export interface Model {
  /** The configured provider instance, e.g. `claudeAgent`. */
  readonly instanceId: string;
  /** The model id, e.g. `claude-sonnet-5-5`. */
  readonly model: string;
}

/** Everything `launch` needs. */
export interface LaunchRequest {
  /**
   * Names this command. Sent again after a failure, the same id lets T3 tell a
   * retry from a new launch, so callers derive it from what they are launching
   * (issue and attempt).
   */
  readonly commandId: string;
  /** A T3 project id, from `findProject`. */
  readonly projectId: string;
  readonly title: string;
  /** The ref the thread's worktree starts from. */
  readonly baseRef: string;
  /**
   * Fetch `origin` first and start from `baseRef`'s tip there, not from the
   * clone's local ref: for a resume from a branch an earlier session pushed.
   */
  readonly startFromOrigin: boolean;
  /** The first message, which starts the first run. */
  readonly message: string;
  readonly model: Model;
}

/** What `launch` returns. */
export interface Launched {
  readonly threadId: string;
  /** `null` until T3 Code has prepared the worktree. */
  readonly worktreePath: string | null;
  /** `null` until T3 Code has prepared the worktree. */
  readonly branch: string | null;
}

/** Where a thread works and whether it is archived. */
export interface Thread {
  /** `null` until T3 Code has prepared the worktree. */
  readonly worktreePath: string | null;
  /** `null` until T3 Code has prepared the worktree. */
  readonly branch: string | null;
  readonly archived: boolean;
}

/** What `status` reports about a thread. */
export interface ThreadStatus extends Thread {
  /**
   * The run with the highest ordinal, if the thread has any run yet. A
   * cancelled run that never started is left out, unless every run is one.
   */
  readonly run: RunStatus | null;
  /** The `ordinal` of that same run; `null` when the thread has no run. */
  readonly runOrdinal: number | null;
  /** The text of the last assistant message of that same run; `null` when the run has none. */
  readonly lastAssistantMessage: string | null;
}

export class ThreadNotFoundError extends Schema.TaggedError<ThreadNotFoundError>()(
  "FactoryThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `T3 does not know thread ${this.threadId}.`;
  }
}

export class SessionsError extends Schema.TaggedError<SessionsError>()("FactorySessionsError", {
  operation: Schema.Literals(["find-project", "launch", "status", "thread"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Factory sessions ${this.operation} failed.`;
  }
}

/** The fields `status` and `thread` read from a thread projection. */
export interface ThreadSnapshot {
  readonly thread: ThreadFields;
  readonly runs: ReadonlyArray<{
    /** What each of the run's messages carries as its `runId`. */
    readonly id: string;
    readonly ordinal: number;
    readonly status: RunStatus;
    /** Absent for a run that never started. */
    readonly startedAt?: unknown;
  }>;
  readonly messages: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
    /** The `id` of the run the message belongs to. */
    readonly runId: string | null;
  }>;
}

export interface ThreadFields {
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly archivedAt: unknown;
}

export const threadOf = (thread: ThreadFields): Thread => ({
  worktreePath: thread.worktreePath,
  branch: thread.branch,
  archived: thread.archivedAt !== null && thread.archivedAt !== undefined,
});

/** A message queued behind a working run and cancelled before it started. */
const isCancelledUnstarted = (run: ThreadSnapshot["runs"][number]) =>
  run.status === "cancelled" && (run.startedAt === null || run.startedAt === undefined);

const highestOrdinal = <Run extends ThreadSnapshot["runs"][number]>(runs: ReadonlyArray<Run>) =>
  runs.reduce<Run | undefined>(
    (best, run) => (best === undefined || run.ordinal >= best.ordinal ? run : best),
    undefined,
  );

/**
 * The thread's run: the highest ordinal. A cancelled run that never started is
 * not the thread's run; when every run is one, the highest ordinal among them
 * decides.
 */
export const latestRun = <Run extends ThreadSnapshot["runs"][number]>(
  runs: ReadonlyArray<Run>,
): Run | undefined =>
  highestOrdinal(runs.filter((run) => !isCancelledUnstarted(run))) ?? highestOrdinal(runs);

export const threadStatusOf = (snapshot: ThreadSnapshot): ThreadStatus => {
  const latest = latestRun(snapshot.runs);
  // Only the reported run's own message: a run that ended quietly must not be
  // read as ending with an older run's result line. A message with no run
  // reference is no run's.
  const lastAssistantMessage =
    latest === undefined
      ? null
      : (snapshot.messages.findLast(
          (message) => message.role === "assistant" && message.runId === latest.id,
        )?.text ?? null);
  return {
    run: latest?.status ?? null,
    runOrdinal: latest?.ordinal ?? null,
    lastAssistantMessage,
    ...threadOf(snapshot.thread),
  };
};

export class FactorySessions extends Context.Service<
  FactorySessions,
  {
    /** The id of the live T3 project whose workspace root is exactly `workspaceRoot`. */
    readonly findProject: (workspaceRoot: string) => Effect.Effect<string | null, SessionsError>;
    /**
     * Starts a thread in its own worktree and runs `message` in it. The
     * worktree is prepared asynchronously, so the answer may not carry a
     * branch or path yet; `status` will. The same `commandId` again is the
     * same launch: T3 answers with the thread it made and starts nothing.
     */
    readonly launch: (request: LaunchRequest) => Effect.Effect<Launched, SessionsError>;
    /** The status of the thread's run, the last assistant message and where the thread works. */
    readonly status: (
      threadId: string,
    ) => Effect.Effect<ThreadStatus, ThreadNotFoundError | SessionsError>;
    /**
     * Where the thread works and whether it is archived. Only the thread's own
     * fields are read, so this answers for a thread whose runs or messages
     * `status` cannot read: the stop path uses it, so a session can always be
     * stopped.
     */
    readonly thread: (
      threadId: string,
    ) => Effect.Effect<Thread, ThreadNotFoundError | SessionsError>;
  }
>()("t3/factory/t3/sessions/FactorySessions") {}

const isThreadNotFound = Schema.is(ProjectionStore.ProjectionStoreThreadNotFoundError);

const mapReadError =
  (operation: "status" | "thread", threadId: string) =>
  (cause: ProjectionStore.ProjectionStoreV2Error) =>
    isThreadNotFound(cause)
      ? new ThreadNotFoundError({ threadId })
      : new SessionsError({ operation, cause });

// Ids are T3's branded non-blank strings. A blank one is a caller's mistake
// and fails as the declared error, never as a thrown schema defect.
const decodeCommandId = Schema.decodeUnknownEffect(CommandId);
const decodeProjectId = Schema.decodeUnknownEffect(ProjectId);
const decodeInstanceId = Schema.decodeUnknownEffect(ProviderInstanceId);
const decodeThreadId = Schema.decodeUnknownEffect(ThreadId);

/** A blank thread id names no thread. */
const requireThreadId = (threadId: string) =>
  decodeThreadId(threadId).pipe(Effect.mapError(() => new ThreadNotFoundError({ threadId })));

export const make = Effect.gen(function* () {
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;

  const findProject: FactorySessions["Service"]["findProject"] = (workspaceRoot) =>
    projects.findActiveByWorkspaceRoot(workspaceRoot).pipe(
      Effect.map(Option.match({ onNone: () => null, onSome: (row) => row.projectId as string })),
      Effect.mapError((cause) => new SessionsError({ operation: "find-project", cause })),
    );

  const launch: FactorySessions["Service"]["launch"] = (request) =>
    Effect.gen(function* () {
      const commandId = yield* decodeCommandId(request.commandId);
      const projectId = yield* decodeProjectId(request.projectId);
      const instanceId = yield* decodeInstanceId(request.model.instanceId);
      const result = yield* launches.launch({
        commandId,
        projectId,
        title: request.title,
        modelSelection: { instanceId, model: request.model.model },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: {
          type: "worktree",
          baseRef: request.baseRef,
          startFromOrigin: request.startFromOrigin,
        },
        initialMessage: { text: request.message, attachments: [] },
        createdBy: "user",
        creationSource: "server",
      });
      return {
        threadId: result.threadId as string,
        worktreePath: result.projection.thread.worktreePath,
        branch: result.projection.thread.branch,
      };
    }).pipe(Effect.mapError((cause) => new SessionsError({ operation: "launch", cause })));

  // The factory polls this per session, so it reads only the rows
  // `threadStatusOf` uses, not the whole projection of a long thread.
  const status: FactorySessions["Service"]["status"] = (threadId) =>
    requireThreadId(threadId).pipe(
      Effect.flatMap((id) =>
        projections
          .getThreadRecords(id, ["runs", "messages"], { messageRoles: ["assistant"] })
          .pipe(Effect.map(threadStatusOf), Effect.mapError(mapReadError("status", threadId))),
      ),
    );

  const thread: FactorySessions["Service"]["thread"] = (threadId) =>
    requireThreadId(threadId).pipe(
      Effect.flatMap((id) =>
        projections
          .getThread(id)
          .pipe(Effect.map(threadOf), Effect.mapError(mapReadError("thread", threadId))),
      ),
    );

  return FactorySessions.of({ findProject, launch, status, thread });
});

export const layer = Layer.effect(FactorySessions, make);

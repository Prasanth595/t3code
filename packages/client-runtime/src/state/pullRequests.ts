import {
  WS_METHODS,
  comparePullRequestFreshness,
  PullRequestActivity,
  PullRequestDetail as PullRequestDetailSchema,
  PullRequestPreview,
  PullRequestReviewGuideResult,
  PullRequestListResult,
  PullRequestChecks,
  PullRequestDiffResult,
  PullRequestChangeBreakdown,
  PullRequestFilesViewedResult,
  PullRequestLinkedThreadsResult,
  type EnvironmentId,
  type PullRequestActor,
  type PullRequestActionInput,
  type PullRequestActionResult,
  type PullRequestListEntry,
  type PullRequestListInput,
  type PullRequestListStatsInput,
  type PullRequestListStatsResult,
  type PullRequestDetail,
  type PullRequestDiffInput,
  type PullRequestRef,
  type PullRequestRefreshEvent,
  type PullRequestMergeMethod,
  PullRequestOperationError,
  type PullRequestSummary,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { persistPullRequestStats } from "./pullRequestStatsPersistence.ts";
import { persistQuery, type QueryPersistence } from "./queryPersistence.ts";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
  createEnvironmentQueryAtomFamily,
  queryPersistenceKey,
  type QueryAnswerHandler,
} from "./runtime.ts";
import { createPullRequestRouter } from "./pullRequestRouting.ts";
import * as PullRequestDiffLoader from "./pullRequestDiffHttp.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { subscribePullRequestRefreshEvents } from "../rpc/client.ts";
import { parsePullRequestQuery } from "../pullRequestQuery.ts";
import { reuseUnchanged } from "./serverConfigProjection.ts";

export {
  type PullRequestDiffLoadError,
  PullRequestDiffCredentialRejectedError,
} from "./pullRequestDiffHttp.ts";
export * as PullRequestDiffLoader from "./pullRequestDiffHttp.ts";

/** @public Required to name the error in consumers' inferred pull request results. */
export class EnvironmentHttpConnectionNotReadyError extends Data.TaggedError(
  "EnvironmentHttpConnectionNotReadyError",
)<{ readonly message: string }> {}

const LINKED_PULL_REQUEST_IDLE_TTL_MS = 5_000;

function normalizePullRequestQuery<A>(
  query: (target: { readonly environmentId: EnvironmentId; readonly input: PullRequestRef }) => A,
) {
  return ({
    environmentId,
    input: { projectId, host, repository, number, allowStale, expectedAccountId },
  }: Parameters<typeof query>[0]) =>
    query({
      environmentId,
      input: {
        projectId,
        ...(host === undefined ? {} : { host }),
        repository,
        number,
        ...(allowStale === undefined ? {} : { allowStale }),
        ...(expectedAccountId === undefined ? {} : { expectedAccountId }),
      },
    });
}

function writableQuery<A, E>(source: Atom.Atom<AsyncResult.AsyncResult<A, E>>) {
  return Atom.writable(
    (get) => {
      const result = get(source);
      if (result._tag === "Success" && !result.waiting) return result;
      const previous = get.self<AsyncResult.AsyncResult<A, E>>();
      const value = Option.flatMap(previous, AsyncResult.value);
      if (Option.isNone(value)) return result;
      return result._tag === "Failure"
        ? AsyncResult.failureWithPrevious(result.cause, { previous, waiting: result.waiting })
        : AsyncResult.success<A, E>(value.value, result);
    },
    (context, value: AsyncResult.AsyncResult<A, E>) => context.setSelf(value),
    (refresh) => refresh(source),
  ).pipe(Atom.setIdleTTL(5 * 60_000));
}

function writableQueryFamily<A, E>(
  family: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: PullRequestRef;
  }) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) {
  const writable = Atom.family(writableQuery<A, E>);
  return normalizePullRequestQuery((target) => writable(family(target)));
}

/** Restart pre-mutation reads before patching so they cannot restore stale values. */
function updateCached<A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Writable<AsyncResult.AsyncResult<A, E>>,
  update: (value: A) => A,
  refresh = false,
) {
  if (refresh || registry.get(atom).waiting) registry.refresh(atom);
  registry.update(atom, AsyncResult.map(update));
}

type ActionResultPatch = (
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  reference: PullRequestRef,
  result: PullRequestActionResult,
) => Effect.Effect<void>;

function samePullRequest(reader: PullRequestRef, acted: PullRequestRef) {
  return (
    reader.projectId === acted.projectId &&
    (reader.host === undefined ||
      acted.host === undefined ||
      reader.host.toLowerCase() === acted.host.toLowerCase()) &&
    reader.repository.toLowerCase() === acted.repository.toLowerCase() &&
    reader.number === acted.number &&
    reader.expectedAccountId === acted.expectedAccountId
  );
}

/** Older than what is shown, or a merged pull request reported open again. */
function isStaleResult(
  shown: {
    readonly state: string;
    readonly updatedAt?: string | undefined;
    readonly observedAt?: number | undefined;
  },
  result: PullRequestActionResult,
) {
  return (
    (shown.state === "merged" && result.state !== "merged") ||
    comparePullRequestFreshness(shown, result) < 0
  );
}

function listAcceptsResult(input: PullRequestListInput, result: PullRequestActionResult) {
  const draft = parsePullRequestQuery(input.query ?? "").filters.draft ?? input.filters?.draft;
  return (
    (input.state === "all" || input.state === result.state) &&
    (draft !== "only" || result.isDraft) &&
    (draft !== "hide" || !result.isDraft)
  );
}

/** `refresh` when the result adds the pull request to a listing, which only a read can place. */
function patchListWithResult(
  input: PullRequestListInput,
  value: PullRequestListResult,
  reference: PullRequestRef,
  result: PullRequestActionResult,
): PullRequestListResult | "refresh" {
  // Rows carry no account scope, so a result read through another account leaves them alone.
  if (reference.expectedAccountId !== undefined) return value;
  let found = false;
  const entries = value.entries.flatMap((entry): PullRequestListEntry[] => {
    if (!samePullRequest(entry, reference)) return [entry];
    found = true;
    if (isStaleResult(entry, result)) return [entry];
    if (!listAcceptsResult(input, result)) return [];
    const { state, isDraft, updatedAt, observedAt } = result;
    return [{ ...entry, state, isDraft, updatedAt, observedAt }];
  });
  if (!found) {
    const inScope =
      input.cursors === undefined &&
      (input.projectId === undefined || input.projectId === reference.projectId) &&
      (input.projectIds === undefined || input.projectIds.includes(reference.projectId));
    return inScope && listAcceptsResult(input, result) ? "refresh" : value;
  }
  return {
    ...value,
    entries: entries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
  };
}

/**
 * The query atom for one target, writable so an action result can replace what it shows. The
 * patch is saved and announced the way an answer would be, so cold starts and snapshots see it.
 */
function actionPatchedQuery<Input, A, E>(
  patches: WeakMap<object, ActionResultPatch>,
  source: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: Input;
  }) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  options: {
    readonly label: string;
    readonly persistence: QueryPersistence<A>;
    readonly onAnswer?: QueryAnswerHandler<Input, A> | undefined;
    readonly patch: (
      input: Input,
      value: A,
      reference: PullRequestRef,
      result: PullRequestActionResult,
    ) => A | "refresh";
  },
) {
  const writable = Atom.family(writableQuery<A, E>);
  return (target: { readonly environmentId: EnvironmentId; readonly input: Input }) => {
    const atom = writable(source(target));
    if (patches.has(atom)) return atom;
    patches.set(
      atom,
      Effect.fnUntraced(function* (registry, environmentId, reference, result) {
        if (environmentId !== target.environmentId) return;
        const shown = Option.flatMap(
          registry.getNodes().get(atom)?.valueOption() ?? Option.none(),
          (current: AsyncResult.AsyncResult<A, E>) => AsyncResult.value(current),
        );
        if (Option.isNone(shown)) return;
        const patched = options.patch(target.input, shown.value, reference, result);
        if (patched === "refresh") return registry.refresh(atom);
        const next = reuseUnchanged(shown.value, patched);
        if (next === shown.value) return;
        yield* options.onAnswer?.(target, next, registry) ?? Effect.void;
        updateCached(registry, atom, () => next);
        yield* options.persistence.save(
          environmentId,
          queryPersistenceKey(options.label, target.input),
          next,
        );
      }),
    );
    return atom;
  };
}

/** Refresh events, with the state a pull request action left when the server reports it. */
function createPullRequestRefreshEventAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  onResult?: ActionResultPatch,
) {
  return createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "environment-data:pull-requests:turn-refreshes",
    subscribe: (_input: {}) =>
      subscribePullRequestRefreshEvents().pipe(
        Stream.tap(({ reference, result }) =>
          onResult === undefined || reference === undefined || result === undefined
            ? Effect.void
            : Effect.gen(function* () {
                const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
                const registry = yield* AtomRegistry.AtomRegistry;
                yield* onResult(registry, supervisor.target.environmentId, reference, result);
              }),
        ),
      ),
  });
}

function refreshRevisions<E>(
  events: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: {};
  }) => Atom.Atom<AsyncResult.AsyncResult<PullRequestRefreshEvent, E>>,
) {
  const revisions = Atom.family((source: ReturnType<typeof events>) =>
    Atom.map(
      source,
      AsyncResult.map((event) => event.revision),
    ),
  );
  return (target: Parameters<typeof events>[0]) => revisions(events(target));
}

function createPullRequestRefreshAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return refreshRevisions(createPullRequestRefreshEventAtomFamily(runtime));
}

export function createLinkedPullRequestSummaryAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  refreshes = createPullRequestRefreshAtomFamily(runtime),
  onAnswer?: QueryAnswerHandler<PullRequestRef, PullRequestSummary>,
) {
  const routedRequest = createPullRequestRouter();
  return createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:pull-requests:linked-summary",
    tag: WS_METHODS.pullRequestsSummary,
    execute: (input) => routedRequest(WS_METHODS.pullRequestsSummary, input),
    staleTimeMs: 60_000,
    refreshIntervalMs: 60_000,
    idleTtlMs: LINKED_PULL_REQUEST_IDLE_TTL_MS,
    refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    isFinal: (summary) => summary.state === "merged",
    ...(onAnswer === undefined ? {} : { onAnswer }),
  });
}

/** Lets a client record what each answer says where it lands, rather than watching the data. */
export interface PullRequestAnswerHandlers {
  readonly list?: QueryAnswerHandler<PullRequestListInput, PullRequestListResult>;
  readonly listStats?: QueryAnswerHandler<PullRequestListStatsInput, PullRequestListStatsResult>;
  readonly detail?: QueryAnswerHandler<PullRequestRef, PullRequestDetail>;
  readonly checks?: QueryAnswerHandler<PullRequestRef, PullRequestChecks | null>;
  readonly reviewGuide?: QueryAnswerHandler<PullRequestRef, PullRequestReviewGuideResult>;
  /** An action's confirmed state, once per result, after the loaded readers show it. */
  readonly actionResult?: QueryAnswerHandler<PullRequestRef, PullRequestActionResult>;
}

export function createPullRequestStackAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  refreshes = createPullRequestRefreshAtomFamily(runtime),
) {
  const routedRequest = createPullRequestRouter();
  return createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:pull-requests:stack",
    tag: WS_METHODS.pullRequestsStack,
    execute: (input) => routedRequest(WS_METHODS.pullRequestsStack, input),
    staleTimeMs: 60_000,
    idleTtlMs: LINKED_PULL_REQUEST_IDLE_TTL_MS,
    refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
  });
}

export function pullRequestDetailToVcsStatus(
  detail: PullRequestDetail | PullRequestSummary,
): NonNullable<VcsStatusResult["pr"]> {
  return {
    number: detail.number,
    title: detail.title,
    url: detail.url,
    baseRef: detail.baseBranch,
    headRef: detail.headBranch,
    state: detail.state,
    ...(detail.isDraft === true ? { isDraft: true } : {}),
    updatedAt: detail.updatedAt,
  };
}

export function createPullRequestEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | PullRequestDiffLoader.PullRequestDiffLoader | R,
    E
  >,
  onAnswer: PullRequestAnswerHandlers = {},
) {
  const actionPatches = new WeakMap<object, ActionResultPatch>();
  const applyActionResult = Effect.fn("PullRequests.applyActionResult")(function* (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    reference: PullRequestRef,
    result: PullRequestActionResult,
  ) {
    for (const atom of registry.getNodes().keys()) {
      const patch = typeof atom === "string" ? undefined : actionPatches.get(atom);
      if (patch !== undefined) yield* patch(registry, environmentId, reference, result);
    }
    if (reference.expectedAccountId === undefined) {
      yield* (
        onAnswer.actionResult?.({ environmentId, input: reference }, result, registry) ??
          Effect.void
      );
    }
  });
  const refreshEvents = createPullRequestRefreshEventAtomFamily(runtime, applyActionResult);
  const refreshes = refreshRevisions(refreshEvents);
  // Readers an action result patches re-read only on events that carry none.
  const invalidations = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const events = get(refreshEvents({ environmentId, input: {} }));
      const previous = get.self<typeof revisions>();
      const revisions = AsyncResult.map(events, (event) => event.revision);
      return Option.isSome(previous) &&
        Option.exists(AsyncResult.value(events), (event) => event.result !== undefined)
        ? previous.value
        : revisions;
    }),
  );
  const commandScheduler = createAtomCommandScheduler();
  const routedRequest = createPullRequestRouter();
  const serialPerEnvironment = {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;
  const activity = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:activity",
      persistence: persistQuery(PullRequestActivity),
      tag: WS_METHODS.pullRequestsActivity,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsActivity, input),
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
  );
  const detailPersistence = persistQuery(PullRequestDetailSchema);
  const detail = normalizePullRequestQuery(
    actionPatchedQuery(
      actionPatches,
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:pull-requests:detail",
        persistence: detailPersistence,
        tag: WS_METHODS.pullRequestsDetail,
        execute: (input) => routedRequest(WS_METHODS.pullRequestsDetail, input),
        staleTimeMs: 60_000,
        refreshTrigger: ({ environmentId }) => invalidations(environmentId),
        ...(onAnswer.detail === undefined ? {} : { onAnswer: onAnswer.detail }),
      }),
      {
        label: "environment-data:pull-requests:detail",
        persistence: detailPersistence,
        onAnswer: onAnswer.detail,
        patch: (input, value, reference, result) => {
          if (!samePullRequest(input, reference) || isStaleResult(value, result)) return value;
          // Reopening or a new head changes branch data and permissions the result lacks.
          if (
            (value.state === "closed" && result.state === "open") ||
            (result.headSha !== undefined && result.headSha !== value.headSha)
          )
            return "refresh";
          const { observedAt: _observedAt, ...state } = result;
          return { ...value, ...state, autoMergeMethod: result.autoMergeMethod };
        },
      },
    ),
  );
  const patchPreview = (
    input: PullRequestRef,
    value: PullRequestPreview,
    reference: PullRequestRef,
    result: PullRequestActionResult,
  ) =>
    samePullRequest(input, reference) && (value.state !== "merged" || result.state === "merged")
      ? { ...value, state: result.state, isDraft: result.isDraft }
      : value;
  const previewPersistence = persistQuery(PullRequestPreview);
  const previewQuery = (label: string) =>
    normalizePullRequestQuery(
      actionPatchedQuery(
        actionPatches,
        createEnvironmentRpcQueryAtomFamily(runtime, {
          label,
          persistence: previewPersistence,
          tag: WS_METHODS.pullRequestsPreview,
          execute: (input) => routedRequest(WS_METHODS.pullRequestsPreview, input),
          staleTimeMs: 60_000,
          refreshTrigger: ({ environmentId }) => invalidations(environmentId),
        }),
        { label, persistence: previewPersistence, patch: patchPreview },
      ),
    );
  const preview = previewQuery("environment-data:pull-requests:preview");
  // Hover cards read their own atoms, so a pending or failed hover read never decides where a
  // click on the same link goes.
  const previewCard = previewQuery("environment-data:pull-requests:preview-card");
  const labelCandidates = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:label-candidates",
      tag: WS_METHODS.pullRequestsLabelCandidates,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsLabelCandidates, input),
      staleTimeMs: 60_000,
    }),
  );
  const reviewGuide = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:review-guide",
      persistence: persistQuery(PullRequestReviewGuideResult),
      tag: WS_METHODS.pullRequestsReviewGuide,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsReviewGuide, input),
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
      ...(onAnswer.reviewGuide === undefined ? {} : { onAnswer: onAnswer.reviewGuide }),
    }),
  );
  const reviewerCandidates = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:reviewer-candidates",
      tag: WS_METHODS.pullRequestsReviewerCandidates,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsReviewerCandidates, input),
      staleTimeMs: 60_000,
    }),
  );
  const loadDiff = Effect.fn("PullRequests.loadDiff")(function* (input: PullRequestDiffInput) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const loader = yield* PullRequestDiffLoader.PullRequestDiffLoader;
    const prepared = yield* SubscriptionRef.get(supervisor.prepared);
    if (Option.isNone(prepared)) {
      return yield* new EnvironmentHttpConnectionNotReadyError({
        message: "The environment HTTP connection is not ready.",
      });
    }
    return yield* loader.load(prepared.value, input);
  });

  const runAction = Effect.fn("PullRequests.runAction")(function* (
    input: PullRequestActionInput & {
      readonly resolveMergeMethod?: (detail: PullRequestDetail) => PullRequestMergeMethod;
    },
  ) {
    const { resolveMergeMethod, ...actionInput } = input;
    let preparedInput = actionInput;
    if (actionInput.action === "merge" && resolveMergeMethod !== undefined) {
      const { projectId, host, repository, number } = actionInput;
      const reference = { projectId, host, repository, number, allowStale: false };
      const detail = yield* routedRequest(WS_METHODS.pullRequestsDetail, reference);
      if (
        detail.state !== "open" ||
        detail.isDraft ||
        !detail.capabilities.actions.includes("merge") ||
        !detail.viewerPermissions.actions.includes("merge")
      ) {
        return yield* new PullRequestOperationError({
          operation: "runAction",
          detail: "This pull request cannot be merged.",
        });
      }
      if (detail.capabilities.stackActions) {
        const stack = yield* routedRequest(WS_METHODS.pullRequestsStack, reference);
        if (stack !== null) {
          return yield* new PullRequestOperationError({
            operation: "runAction",
            detail: "Open this pull request to merge its stack.",
          });
        }
      }
      const mergeMethod = yield* Effect.try({
        try: () => resolveMergeMethod(detail),
        catch: (cause) =>
          new PullRequestOperationError({
            operation: "runAction",
            detail: cause instanceof Error ? cause.message : "Could not choose a merge method.",
          }),
      });
      preparedInput = { ...actionInput, mergeMethod };
    }
    return yield* routedRequest(WS_METHODS.pullRequestsRunActionWithResult, preparedInput);
  });
  const listPersistence = persistQuery(PullRequestListResult);

  return {
    refreshes,
    invalidations: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      invalidations(environmentId),
    linkedThreads: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:linked-threads",
      persistence: persistQuery(PullRequestLinkedThreadsResult),
      tag: WS_METHODS.pullRequestsLinkedThreads,
      staleTimeMs: 0,
      refreshIntervalMs: 10_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
    // For callers that open a thread from the answer: a persisted one reads as final before
    // the connection is known, and a kept one can predate the thread.
    linkedThreadsUncached: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:linked-threads-uncached",
      tag: WS_METHODS.pullRequestsLinkedThreads,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    list: actionPatchedQuery(
      actionPatches,
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:pull-requests:list",
        persistence: listPersistence,
        tag: WS_METHODS.pullRequestsList,
        staleTimeMs: 30_000,
        refreshTrigger: ({ environmentId, input }) =>
          input.cursors === undefined ? invalidations(environmentId) : undefined,
        ...(onAnswer.list === undefined ? {} : { onAnswer: onAnswer.list }),
      }),
      {
        label: "environment-data:pull-requests:list",
        persistence: listPersistence,
        onAnswer: onAnswer.list,
        patch: patchListWithResult,
      },
    ),
    /**
     * Its own query because the listing is quicker without them — measured over twelve
     * repositories, ~4.0s against ~7.1s — so the rows arrive first and their stats a moment
     * later.
     */
    listStats: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:list-stats",
      persistence: persistPullRequestStats(),
      tag: WS_METHODS.pullRequestsListStats,
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
      ...(onAnswer.listStats === undefined ? {} : { onAnswer: onAnswer.listStats }),
    }),
    filterOptions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:filter-options",
      tag: WS_METHODS.pullRequestsFilterOptions,
      staleTimeMs: 5 * 60_000,
    }),
    detail,
    preview,
    previewCard,
    checks: normalizePullRequestQuery(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:pull-requests:checks",
        persistence: persistQuery(Schema.NullOr(PullRequestChecks)),
        tag: WS_METHODS.pullRequestsChecks,
        execute: (input) => routedRequest(WS_METHODS.pullRequestsChecks, input),
        staleTimeMs: 45_000,
        refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
        ...(onAnswer.checks === undefined ? {} : { onAnswer: onAnswer.checks }),
      }),
    ),
    activity,
    threadComments: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:thread-comments",
      tag: WS_METHODS.pullRequestsThreadComments,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsThreadComments, input),
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.cursor]),
      },
    }),
    diff: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:diff",
      persistence: persistQuery(PullRequestDiffResult),
      staleTimeMs: 60_000,
      execute: loadDiff,
    }),
    diffFileContents: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:diff-file-contents",
      tag: WS_METHODS.pullRequestsDiffFileContents,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsDiffFileContents, input),
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.projectId,
            input.host?.toLowerCase() ?? null,
            input.repository,
            input.number,
            input.commit ?? null,
            input.changeType,
            input.oldPath,
            input.newPath,
          ]),
      },
    }),
    filesViewed: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:files-viewed",
      persistence: persistQuery(PullRequestFilesViewedResult),
      tag: WS_METHODS.pullRequestsFilesViewed,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsFilesViewed, input),
      staleTimeMs: 15_000,
    }),
    changeBreakdown: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:change-breakdown",
      persistence: persistQuery(PullRequestChangeBreakdown),
      tag: WS_METHODS.pullRequestsChangeBreakdown,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsChangeBreakdown, input),
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
    /**
     * One write in flight per change request: the host applies these in order, and a reader
     * ticking down a file list faster than the round trip would otherwise race their own presses.
     */
    setFilesViewed: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:set-files-viewed",
      tag: WS_METHODS.pullRequestsSetFilesViewed,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsSetFilesViewed, input),
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.repository, input.number]),
      },
    }),
    runAction: createEnvironmentRpcCommand(runtime, {
      tag: WS_METHODS.pullRequestsRunActionWithResult,
      label: "environment-data:pull-requests:run-action",
      // Preparation belongs to the write's lane. Refreshable queries would restart it after
      // every preceding action, and preparing outside the lane could reorder the clicks.
      execute: runAction,
      onSuccess: ({ environmentId, input }, registry, result) => {
        if (result !== null) {
          const { projectId, host, repository, number, expectedAccountId } = input;
          const reference = {
            projectId,
            ...(host === undefined ? {} : { host }),
            repository,
            number,
            ...(expectedAccountId === undefined ? {} : { expectedAccountId }),
          };
          return applyActionResult(registry, environmentId, reference, result);
        }
        return Effect.sync(() => {
          registry.refresh(preview({ environmentId, input }));
          registry.refresh(previewCard({ environmentId, input }));
        });
      },
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:update",
      tag: WS_METHODS.pullRequestsUpdate,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsUpdate, input),
      onSuccess: (target, registry) => Effect.sync(() => registry.refresh(preview(target))),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    comment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:comment",
      tag: WS_METHODS.pullRequestsComment,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsComment, input),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    updateComment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:update-comment",
      tag: WS_METHODS.pullRequestsUpdateComment,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsUpdateComment, input),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: ({ environmentId, input: { projectId, host, repository, number } }, registry) =>
        Effect.sync(() =>
          registry.refresh(
            activity({
              environmentId,
              input: { projectId, ...(host === undefined ? {} : { host }), repository, number },
            }),
          ),
        ),
    }),
    submitReview: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:submit-review",
      tag: WS_METHODS.pullRequestsSubmitReview,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsSubmitReview, input),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    replyToThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:reply-to-thread",
      tag: WS_METHODS.pullRequestsReplyToThread,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsReplyToThread, input),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    reviewerCandidates,
    requestReviewers: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:request-reviewers",
      tag: WS_METHODS.pullRequestsRequestReviewers,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsRequestReviewers, input),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          const { reviewers, requested } = target.input;
          const candidatesAtom = reviewerCandidates(target);
          const candidates = AsyncResult.getOrElse(registry.get(candidatesAtom), () => null);
          const selected =
            candidates?.candidates.filter((candidate) =>
              reviewers.some(
                (reviewer) => reviewer.id === candidate.id && reviewer.kind === candidate.kind,
              ),
            ) ?? [];
          const missingIdentities = selected.length < reviewers.length;
          updateCached(registry, candidatesAtom, (value) => ({
            ...value,
            candidates: value.candidates.map((candidate) =>
              selected.includes(candidate) ? { ...candidate, isRequested: requested } : candidate,
            ),
          }));
          const selectedLogins = new Set(
            selected.map((candidate) => candidate.login.toLowerCase()),
          );
          const updateReviewers = (
            actors: ReadonlyArray<PullRequestActor>,
            keep = (_actor: PullRequestActor) => false,
          ) =>
            requested
              ? [
                  ...actors,
                  ...selected
                    .filter(
                      (candidate) =>
                        !actors.some(
                          (actor) => actor.login.toLowerCase() === candidate.login.toLowerCase(),
                        ),
                    )
                    .map(({ login, name, avatarUrl }) => ({ login, name, avatarUrl })),
                ]
              : actors.filter(
                  (actor) => !selectedLogins.has(actor.login.toLowerCase()) || keep(actor),
                );
          updateCached(
            registry,
            detail(target),
            (value) => ({
              ...value,
              reviewers: updateReviewers(value.reviewers),
            }),
            missingIdentities,
          );
          updateCached(
            registry,
            activity(target),
            (value) => ({
              ...value,
              reviewers:
                value.reviewers === undefined
                  ? undefined
                  : updateReviewers(value.reviewers, (actor) =>
                      value.comments.some(
                        (comment) =>
                          (comment.kind === "review" || comment.kind === "review-comment") &&
                          comment.author?.login.toLowerCase() === actor.login.toLowerCase(),
                      ),
                    ),
            }),
            missingIdentities,
          );
        }),
    }),
    reviewGuide,
    generateReviewGuide: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:generate-review-guide",
      tag: WS_METHODS.pullRequestsGenerateReviewGuide,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsGenerateReviewGuide, input),
      onSuccess: (target, registry, result) =>
        Effect.sync(() => {
          updateCached(registry, reviewGuide(target), () => result, true);
        }),
    }),
    labelCandidates,
    setLabels: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:set-labels",
      tag: WS_METHODS.pullRequestsSetLabels,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsSetLabels, input),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          const { labels, applied } = target.input;
          const candidatesAtom = labelCandidates(target);
          const candidates = AsyncResult.getOrElse(registry.get(candidatesAtom), () => null);
          const names = new Set(labels);
          updateCached(registry, candidatesAtom, (value) => ({
            ...value,
            candidates: value.candidates.map((candidate) =>
              names.has(candidate.name) ? { ...candidate, isApplied: applied } : candidate,
            ),
          }));
          updateCached(registry, detail(target), (value) => ({
            ...value,
            labels: applied
              ? [
                  ...value.labels,
                  ...labels
                    .filter((name) => !value.labels.some((label) => label.name === name))
                    .map((name) => ({
                      name,
                      color:
                        candidates?.candidates.find((candidate) => candidate.name === name)
                          ?.color ?? null,
                    })),
                ]
              : value.labels.filter((label) => !names.has(label.name)),
          }));
        }),
    }),
    setThreadResolution: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:set-thread-resolution",
      tag: WS_METHODS.pullRequestsSetThreadResolution,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsSetThreadResolution, input),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    setReaction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:set-reaction",
      tag: WS_METHODS.pullRequestsSetReaction,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsSetReaction, input),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    /**
     * A separate request rather than a flag on a read, so only a person's refresh spends
     * host requests while every silent re-read shares the cache.
     */
    invalidate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:invalidate",
      tag: WS_METHODS.pullRequestsInvalidate,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsInvalidate, input),
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          if (input.reference !== undefined) {
            registry.refresh(preview({ environmentId, input: input.reference }));
            registry.refresh(previewCard({ environmentId, input: input.reference }));
          }
        }),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
  };
}

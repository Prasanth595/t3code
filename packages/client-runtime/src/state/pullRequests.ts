import {
  WS_METHODS,
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
  type PullRequestRefreshEvent,
  type PullRequestListInput,
  type PullRequestListStatsInput,
  type PullRequestListStatsResult,
  type PullRequestDetail,
  type PullRequestDiffInput,
  type PullRequestRef,
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
import { persistQuery } from "./queryPersistence.ts";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentQueryAtomFamily,
  followStreamInEnvironment,
  type QueryAnswerHandler,
} from "./runtime.ts";
import { createPullRequestRouter } from "./pullRequestRouting.ts";
import * as PullRequestDiffLoader from "./pullRequestDiffHttp.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  subscribe,
  type EnvironmentRpcSuccess,
  type EnvironmentRpcFailure,
  type EnvironmentRpcUnavailableError,
} from "../rpc/client.ts";
import { parsePullRequestQuery } from "../pullRequestQuery.ts";
import { reuseUnchanged } from "./serverConfigProjection.ts";

type ActionRead<
  T extends
    | typeof WS_METHODS.pullRequestsDetail
    | typeof WS_METHODS.pullRequestsPreview
    | typeof WS_METHODS.pullRequestsList,
> = Effect.Effect<
  EnvironmentRpcSuccess<T>,
  EnvironmentRpcFailure<T> | EnvironmentRpcUnavailableError,
  EnvironmentSupervisor.EnvironmentSupervisor | EnvironmentRegistry | AtomRegistry.AtomRegistry
>;

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
const encodeActionCacheKey = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Null]))),
);

type PullRequestRefreshFamily = ((target: {
  readonly environmentId: EnvironmentId;
  readonly input: {};
}) => Atom.Atom<unknown>) & {
  readonly forReference?: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: PullRequestRef;
  }) => Atom.Atom<unknown>;
};

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
  const writable = Atom.family((source: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
    writableQuery(source),
  );
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

function createPullRequestRefreshEventAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  onEvent?: (
    environmentId: EnvironmentId,
    event: PullRequestRefreshEvent,
    session: RpcSession,
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.Effect<void>,
) {
  const family = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom((get) =>
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              SubscriptionRef.changes(supervisor.session).pipe(
                Stream.switchMap((session) =>
                  Option.isNone(session)
                    ? Stream.empty
                    : Stream.unwrap(
                        session.value.initialConfig.pipe(
                          Effect.map((config) =>
                            (config.environment.capabilities.pullRequestActionResults === true
                              ? subscribe(WS_METHODS.pullRequestsSubscribeRefreshEvents, {})
                              : subscribe(WS_METHODS.pullRequestsSubscribeRefreshes, {}).pipe(
                                  Stream.map((revision) => ({ revision })),
                                )
                            ).pipe(
                              Stream.tap((event) =>
                                SubscriptionRef.get(supervisor.session).pipe(
                                  Effect.flatMap((current) =>
                                    Option.isSome(current) && current.value === session.value
                                      ? (onEvent?.(
                                          environmentId,
                                          event,
                                          session.value,
                                          get.registry,
                                        ) ?? Effect.void)
                                      : Effect.void,
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  return ({ environmentId }: { readonly environmentId: EnvironmentId; readonly input: {} }) =>
    family(environmentId);
}

function createPullRequestRefreshAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const events = createPullRequestRefreshEventAtomFamily(runtime);
  const revisions = Atom.family((source: ReturnType<typeof events>) =>
    Atom.map(
      source,
      AsyncResult.map((event) => event.revision),
    ),
  );
  return (target: Parameters<typeof events>[0]) => revisions(events(target));
}

export function createLinkedPullRequestSummaryAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  refreshes: PullRequestRefreshFamily = createPullRequestRefreshAtomFamily(runtime),
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
    refreshTrigger: (target) =>
      refreshes.forReference?.(target) ??
      refreshes({ environmentId: target.environmentId, input: {} }),
    isFinal: (summary) => summary.state === "merged",
    ...(onAnswer === undefined ? {} : { onAnswer }),
  });
}

/** Lets a client record what each answer says where it lands, rather than watching the data. */
type ActionQueryAnswerHandler<Input, A> = (
  ...args: [...Parameters<QueryAnswerHandler<Input, A>>, freshRead: A | null]
) => Effect.Effect<void>;

export interface PullRequestAnswerHandlers {
  readonly list?: QueryAnswerHandler<PullRequestListInput, PullRequestListResult>;
  readonly listStats?: QueryAnswerHandler<PullRequestListStatsInput, PullRequestListStatsResult>;
  readonly detail?: ActionQueryAnswerHandler<PullRequestRef, PullRequestDetail>;
  readonly checks?: QueryAnswerHandler<PullRequestRef, PullRequestChecks | null>;
  readonly reviewGuide?: QueryAnswerHandler<PullRequestRef, PullRequestReviewGuideResult>;
  readonly actionResult?: QueryAnswerHandler<PullRequestRef, PullRequestActionResult>;
}

export function createPullRequestStackAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  refreshes: PullRequestRefreshFamily = createPullRequestRefreshAtomFamily(runtime),
) {
  const routedRequest = createPullRequestRouter();
  return createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:pull-requests:stack",
    tag: WS_METHODS.pullRequestsStack,
    execute: (input) => routedRequest(WS_METHODS.pullRequestsStack, input),
    staleTimeMs: 60_000,
    idleTtlMs: LINKED_PULL_REQUEST_IDLE_TTL_MS,
    refreshTrigger: (target) =>
      refreshes.forReference?.(target) ??
      refreshes({ environmentId: target.environmentId, input: {} }),
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

function sameActionReference(left: PullRequestRef, right: PullRequestRef) {
  return (
    left.projectId === right.projectId &&
    (left.host === undefined ||
      right.host === undefined ||
      left.host.toLowerCase() === right.host.toLowerCase()) &&
    left.repository.toLowerCase() === right.repository.toLowerCase() &&
    left.number === right.number &&
    left.expectedAccountId === right.expectedAccountId
  );
}

function patchActionList(
  value: PullRequestListResult,
  input: PullRequestListInput,
  reference: PullRequestRef,
  result: PullRequestActionResult,
) {
  if (reference.expectedAccountId !== undefined) return value;
  let changed = false;
  const draft = parsePullRequestQuery(input.query ?? "").filters.draft ?? input.filters?.draft;
  const entries = value.entries.flatMap((entry) => {
    if (
      !sameActionReference(entry, reference) ||
      (entry.state === "merged" && result.state !== "merged") ||
      (entry.observedAt ?? -Infinity) > result.observedAt
    )
      return [entry];
    changed = true;
    if (
      (input.state !== "all" && input.state !== result.state) ||
      (draft === "only" && !result.isDraft) ||
      (draft === "hide" && result.isDraft)
    )
      return [];
    return [
      {
        ...entry,
        state: result.state,
        isDraft: result.isDraft,
        updatedAt: result.updatedAt,
        observedAt: result.observedAt,
      },
    ];
  });
  return changed
    ? {
        ...value,
        entries: entries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
      }
    : value;
}

function actionListNeedsRefresh(
  value: PullRequestListResult,
  input: PullRequestListInput,
  reference: PullRequestRef,
  result: PullRequestActionResult,
) {
  if (
    input.cursors !== undefined ||
    (input.projectId !== undefined && input.projectId !== reference.projectId) ||
    (input.projectIds !== undefined && !input.projectIds.includes(reference.projectId)) ||
    (input.host !== undefined &&
      reference.host !== undefined &&
      input.host.toLowerCase() !== reference.host.toLowerCase())
  )
    return false;
  const draft = parsePullRequestQuery(input.query ?? "").filters.draft ?? input.filters?.draft;
  const matches =
    (input.state === "all" || input.state === result.state) &&
    (draft !== "only" || result.isDraft) &&
    (draft !== "hide" || !result.isDraft);
  const present = value.entries.some((entry) => sameActionReference(entry, reference));
  return present ? !matches : matches;
}

export function createPullRequestEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | PullRequestDiffLoader.PullRequestDiffLoader | R,
    E
  >,
  onAnswer: PullRequestAnswerHandlers = {},
) {
  type CachedActionQuery = {
    readonly environmentId: EnvironmentId;
    readonly session: RpcSession;
    readonly patch: (
      reference: PullRequestRef,
      result: PullRequestActionResult,
    ) => Effect.Effect<void>;
    readonly exists: () => boolean;
  };
  type ConfirmedAction = {
    readonly environmentId: EnvironmentId;
    readonly reference: PullRequestRef;
    readonly result: PullRequestActionResult;
    readonly epoch: number;
    readonly refreshStats: boolean;
  };
  const cachedQueries = new WeakMap<AtomRegistry.AtomRegistry, Map<object, CachedActionQuery>>();
  const confirmedActions = new WeakMap<
    AtomRegistry.AtomRegistry,
    WeakMap<RpcSession, Map<string, ConfirmedAction>>
  >();
  const actionSessions = new WeakMap<
    PullRequestActionResult,
    {
      readonly session: RpcSession;
      readonly isCurrent: Effect.Effect<boolean>;
    }
  >();
  const actionRefresh = Atom.make<ConfirmedAction | null>(null);
  let actionEpoch = 0;
  const actionsFor = (registry: AtomRegistry.AtomRegistry, session: RpcSession) => {
    const sessions =
      confirmedActions.get(registry) ?? new WeakMap<RpcSession, Map<string, ConfirmedAction>>();
    confirmedActions.set(registry, sessions);
    const actions = sessions.get(session) ?? new Map<string, ConfirmedAction>();
    sessions.set(session, actions);
    return actions;
  };
  const applyActionResult = Effect.fn("PullRequests.applyActionResult")(function* (
    target: { readonly environmentId: EnvironmentId; readonly input: PullRequestRef },
    result: PullRequestActionResult,
    session: RpcSession,
    registry: AtomRegistry.AtomRegistry,
  ) {
    const actions = actionsFor(registry, session);
    const reference = normalizePullRequestQuery((target) => target.input)(target);
    const key = yield* encodeActionCacheKey([
      target.environmentId,
      reference.projectId,
      reference.host?.toLowerCase() ?? null,
      reference.repository.toLowerCase(),
      reference.number,
      reference.expectedAccountId ?? null,
    ]).pipe(Effect.orDie);
    const matches = Array.from(actions.entries()).filter(
      ([, action]) =>
        action.environmentId === target.environmentId &&
        sameActionReference(action.reference, reference),
    );
    const previous = matches.reduce<ConfirmedAction | undefined>(
      (latest, [, action]) =>
        latest === undefined || action.result.observedAt > latest.result.observedAt
          ? action
          : latest,
      undefined,
    );
    if (
      previous !== undefined &&
      ((previous.result.state === "merged" && result.state !== "merged") ||
        previous.result.observedAt > result.observedAt ||
        reuseUnchanged(previous.result, result) === previous.result)
    )
      return;
    const confirmed = {
      environmentId: target.environmentId,
      reference,
      result,
      epoch: ++actionEpoch,
      refreshStats: result.headSha === undefined || result.headSha !== previous?.result.headSha,
    };
    for (const [alias] of matches) actions.delete(alias);
    actions.set(key, confirmed);
    const oldest = actions.keys().next().value;
    if (actions.size > 256 && oldest !== undefined) actions.delete(oldest);
    for (const [atom, cached] of cachedQueries.get(registry) ?? []) {
      if (!cached.exists()) {
        cachedQueries.get(registry)?.delete(atom);
      } else if (cached.environmentId === target.environmentId && cached.session === session) {
        yield* cached.patch(reference, result);
      }
    }
    registry.set(actionRefresh, confirmed);
    yield* (
      onAnswer.actionResult?.({ ...target, input: reference }, result, registry) ?? Effect.void
    );
  });
  const events = createPullRequestRefreshEventAtomFamily(
    runtime,
    (environmentId, event, session, registry) =>
      event.reference !== undefined && event.result !== undefined
        ? applyActionResult(
            { environmentId, input: event.reference },
            event.result,
            session,
            registry,
          )
        : Effect.void,
  );
  const revisions = Atom.family((source: ReturnType<typeof events>) =>
    Atom.map(
      source,
      AsyncResult.map((event) => event.revision),
    ),
  );
  const fieldRefreshes = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const event = Option.getOrNull(AsyncResult.value(get(events({ environmentId, input: {} }))));
      return event?.result === undefined
        ? event?.revision
        : Option.getOrUndefined(get.self<number | undefined>());
    }),
  );
  const scopedRefreshFamily = Atom.family((key: string) => {
    const [environmentId, input] = JSON.parse(key) as [EnvironmentId, PullRequestRef];
    return Atom.make((get) => {
      const event = Option.getOrNull(AsyncResult.value(get(events({ environmentId, input: {} }))));
      const action = get(actionRefresh);
      const previous = Option.getOrUndefined(
        get.self<{ revision: number | undefined; epoch: number | undefined }>(),
      );
      const revision =
        event?.result === undefined &&
        (event?.reference === undefined || sameActionReference(input, event.reference))
          ? event?.revision
          : previous?.revision;
      const epoch =
        action?.environmentId === environmentId && sameActionReference(input, action.reference)
          ? action.epoch
          : previous?.epoch;
      return previous?.revision === revision && previous?.epoch === epoch
        ? previous
        : { revision, epoch };
    });
  });
  const scopedRefreshes = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: PullRequestRef;
  }) => scopedRefreshFamily(JSON.stringify([target.environmentId, target.input]));
  const invalidationRevisions = Atom.family((environmentId: EnvironmentId) =>
    Atom.map(fieldRefreshes(environmentId), (revision) => AsyncResult.success(revision ?? 0)),
  );
  const refreshes = Object.assign(
    (target: Parameters<typeof events>[0]) => revisions(events(target)),
    {
      forReference: scopedRefreshes,
      invalidations: (target: Parameters<typeof events>[0]) =>
        invalidationRevisions(target.environmentId),
    },
  );
  const readActionQuery = Effect.fn("PullRequests.readActionQuery")(function* <
    Input,
    A,
    ERead,
    RRead,
    EAtom,
  >(
    input: Input,
    read: Effect.Effect<A, ERead, RRead>,
    atomFor: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: Input;
    }) => Atom.Writable<AsyncResult.AsyncResult<A, EAtom>>,
    patch: (value: A, reference: PullRequestRef, result: PullRequestActionResult) => A,
    needsRefresh: (
      value: A,
      reference: PullRequestRef,
      result: PullRequestActionResult,
    ) => boolean = () => false,
    onQueryAnswer?: ActionQueryAnswerHandler<Input, A>,
  ) {
    const registry = yield* AtomRegistry.AtomRegistry;
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const session = yield* SubscriptionRef.get(supervisor.session);
    const epoch = actionEpoch;
    if (Option.isNone(session)) return yield* read;
    const atom = atomFor({ environmentId: supervisor.target.environmentId, input });
    const queries = cachedQueries.get(registry) ?? new Map<object, CachedActionQuery>();
    cachedQueries.set(registry, queries);
    for (const [key, cached] of queries) if (!cached.exists()) queries.delete(key);
    queries.set(atom, {
      environmentId: supervisor.target.environmentId,
      session: session.value,
      exists: () => registry.getNodes().has(atom),
      patch: Effect.fn("PullRequests.patchActionQuery")(function* (reference, result) {
        const current: AsyncResult.AsyncResult<A, EAtom> | undefined = Option.getOrUndefined(
          registry.getNodes().get(atom)?.valueOption() ?? Option.none(),
        );
        if (current === undefined) return;
        const value = AsyncResult.value(current);
        if (Option.isNone(value)) return;
        const next = patch(value.value, reference, result);
        if (next !== value.value) {
          yield* (
            onQueryAnswer?.(
              { environmentId: supervisor.target.environmentId, input },
              next,
              registry,
              null,
            ) ?? Effect.void
          );
          registry.set(atom, AsyncResult.map(() => next)(current));
        }
        if (needsRefresh(value.value, reference, result)) registry.refresh(atom);
      }),
    });
    const freshRead = yield* read;
    let value = freshRead;
    let refreshNeeded = false;
    for (const confirmed of actionsFor(registry, session.value).values()) {
      if (confirmed.environmentId !== supervisor.target.environmentId) continue;
      if (
        epoch < confirmed.epoch ||
        (typeof value === "object" &&
          value !== null &&
          ("entries" in value ||
            ("observedAt" in value &&
              (typeof value.observedAt !== "number" ||
                value.observedAt < confirmed.result.observedAt))))
      ) {
        if (epoch < confirmed.epoch && needsRefresh(value, confirmed.reference, confirmed.result)) {
          refreshNeeded = true;
        }
        value = patch(value, confirmed.reference, confirmed.result);
      }
    }
    yield* (
      onQueryAnswer?.(
        { environmentId: supervisor.target.environmentId, input },
        value,
        registry,
        freshRead,
      ) ?? Effect.void
    );
    if (refreshNeeded) registry.refresh(atom);
    return value;
  });
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
      refreshTrigger: scopedRefreshes,
    }),
  );
  const detail = writableQueryFamily(
    createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:detail",
      persistence: persistQuery(PullRequestDetailSchema),
      execute: (input: PullRequestRef): ActionRead<typeof WS_METHODS.pullRequestsDetail> =>
        readActionQuery(
          input,
          routedRequest(WS_METHODS.pullRequestsDetail, input),
          detail,
          (value, reference, result) =>
            sameActionReference(input, reference) &&
            (value.state !== "merged" || result.state === "merged") &&
            (value.observedAt ?? -Infinity) <= result.observedAt
              ? { ...value, ...result, autoMergeMethod: result.autoMergeMethod }
              : value,
          (value, reference, result) =>
            sameActionReference(input, reference) &&
            result.headSha !== undefined &&
            value.headSha !== result.headSha,
          onAnswer.detail,
        ),
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => fieldRefreshes(environmentId),
    }),
  );
  const preview = writableQueryFamily(
    createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:preview",
      persistence: persistQuery(PullRequestPreview),
      execute: (input: PullRequestRef): ActionRead<typeof WS_METHODS.pullRequestsPreview> =>
        readActionQuery(
          input,
          routedRequest(WS_METHODS.pullRequestsPreview, input),
          preview,
          (value, reference, result) =>
            sameActionReference(input, reference) &&
            (value.state !== "merged" || result.state === "merged")
              ? { ...value, state: result.state, isDraft: result.isDraft }
              : value,
        ),
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => fieldRefreshes(environmentId),
    }),
  );
  // Hover cards read their own atoms, so a pending or failed hover read never decides where a
  // click on the same link goes.
  const previewCard = writableQueryFamily(
    createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:preview-card",
      persistence: persistQuery(PullRequestPreview),
      execute: (input: PullRequestRef): ActionRead<typeof WS_METHODS.pullRequestsPreview> =>
        readActionQuery(
          input,
          routedRequest(WS_METHODS.pullRequestsPreview, input),
          previewCard,
          (value, reference, result) =>
            sameActionReference(input, reference) &&
            (value.state !== "merged" || result.state === "merged")
              ? { ...value, state: result.state, isDraft: result.isDraft }
              : value,
        ),
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => fieldRefreshes(environmentId),
    }),
  );
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
      refreshTrigger: ({ environmentId }) => fieldRefreshes(environmentId),
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

  const listSource = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:pull-requests:list",
    persistence: persistQuery(PullRequestListResult),
    execute: (input: PullRequestListInput): ActionRead<typeof WS_METHODS.pullRequestsList> =>
      readActionQuery(
        input,
        routedRequest(WS_METHODS.pullRequestsList, input),
        list,
        (value, reference, result) => patchActionList(value, input, reference, result),
        (value, reference, result) => actionListNeedsRefresh(value, input, reference, result),
      ),
    staleTimeMs: 30_000,
    refreshTrigger: ({ environmentId, input }) =>
      input.cursors === undefined ? fieldRefreshes(environmentId) : undefined,
    ...(onAnswer.list === undefined ? {} : { onAnswer: onAnswer.list }),
  });
  const writableLists = Atom.family((source: ReturnType<typeof listSource>) =>
    writableQuery(source),
  );
  const list = (target: Parameters<typeof listSource>[0]) => writableLists(listSource(target));

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
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const session = yield* SubscriptionRef.get(supervisor.session);
    const result = yield* routedRequest(WS_METHODS.pullRequestsRunActionWithResult, preparedInput);
    if (result !== null && Option.isSome(session)) {
      const isCurrent = SubscriptionRef.get(supervisor.session).pipe(
        Effect.map((current) => Option.isSome(current) && current.value === session.value),
      );
      if (!(yield* isCurrent)) return null;
      actionSessions.set(result, { session: session.value, isCurrent });
    }
    return result;
  });

  return {
    refreshes,
    linkedThreads: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:linked-threads",
      persistence: persistQuery(PullRequestLinkedThreadsResult),
      tag: WS_METHODS.pullRequestsLinkedThreads,
      staleTimeMs: 0,
      refreshIntervalMs: 10_000,
      refreshTrigger: scopedRefreshes,
    }),
    // For callers that open a thread from the answer: a persisted one reads as final before
    // the connection is known, and a kept one can predate the thread.
    linkedThreadsUncached: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:linked-threads-uncached",
      tag: WS_METHODS.pullRequestsLinkedThreads,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    list,
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
      refreshTrigger: ({ environmentId, input }) =>
        Atom.make((get) => {
          const revision = get(fieldRefreshes(environmentId));
          const action = get(actionRefresh);
          const previous = Option.getOrUndefined(
            get.self<{ revision: number | undefined; epoch: number | undefined }>(),
          );
          const epoch =
            action?.environmentId === environmentId &&
            action.refreshStats &&
            input.refs.some((reference) =>
              sameActionReference(
                { ...reference, expectedAccountId: undefined },
                { ...action.reference, expectedAccountId: undefined },
              ),
            )
              ? action.epoch
              : previous?.epoch;
          return previous?.revision === revision && previous?.epoch === epoch
            ? previous
            : { revision, epoch };
        }),
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
        refreshTrigger: scopedRefreshes,
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
      refreshTrigger: scopedRefreshes,
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
          const source = actionSessions.get(result);
          return source === undefined
            ? Effect.void
            : source.isCurrent.pipe(
                Effect.flatMap((current) =>
                  current
                    ? applyActionResult({ environmentId, input }, result, source.session, registry)
                    : Effect.void,
                ),
              );
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

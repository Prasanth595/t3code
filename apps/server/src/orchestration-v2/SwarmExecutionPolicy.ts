import {
  RunId,
  ThreadId,
  type ModelSelection,
  type NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ExecutionScope,
  type OrchestrationV2ExecutionCause,
  type OrchestrationV2ExecutionDelivery,
  type OrchestrationV2RunCauseSource,
  type OrchestrationV2Swarm,
  type OrchestrationV2NativeCause,
  type OrchestrationV2NativeRunCauseSource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as ProjectionStore from "./ProjectionStore.ts";
import {
  exceededDispatchModeLimit,
  minimumDispatchModes,
  type DispatchModes,
} from "./DispatchModeLimit.ts";

export class SwarmAdmissionLost extends Schema.TaggedError<SwarmAdmissionLost>()(
  "SwarmAdmissionLost",
  {
    threadId: ThreadId,
    runId: Schema.NullOr(RunId),
  },
) {
  override get message(): string {
    return "The exact execution no longer authorizes this work.";
  }
}

const prepared = Symbol("PreparedRunExecution");
export interface PreparedRunExecution {
  readonly [prepared]: true;
  readonly executionScope: OrchestrationV2ExecutionScope;
  readonly executionCause: OrchestrationV2ExecutionCause;
  readonly executionDelivery: OrchestrationV2ExecutionDelivery;
  readonly delegatedTaskId: NodeId | null;
  readonly modelSelection: ModelSelection | null;
}

type Store = ProjectionStore.ProjectionStoreV2["Service"];
type SwarmScope = Extract<OrchestrationV2ExecutionScope, { kind: "swarm" }>;
type CausalReason = Extract<OrchestrationV2ExecutionCause, { kind: "causal" }>["reason"];
type Preparation =
  | { readonly kind: "ordinary"; readonly taskId: NodeId | null }
  | {
      readonly kind: "continuation";
      readonly destination: OrchestrationV2AppThread;
      readonly sources: ReadonlyArray<OrchestrationV2RunCauseSource>;
      readonly reason: CausalReason;
      readonly delivery: OrchestrationV2ExecutionDelivery;
    }
  | {
      readonly kind: "native";
      readonly destination: OrchestrationV2AppThread;
      readonly cause: OrchestrationV2NativeCause;
      readonly delivery: OrchestrationV2ExecutionDelivery;
    }
  | {
      readonly kind: "scoped";
      readonly group: OrchestrationV2Swarm;
      readonly source: OrchestrationV2RunCauseSource;
      readonly destination: OrchestrationV2AppThread;
      readonly memberThreadId: ThreadId;
      readonly modes: DispatchModes;
      readonly limit: DispatchModes | undefined;
      readonly taskId: NodeId | null;
      readonly reason: "peer" | "delegation";
    }
  | {
      readonly kind: "delegation";
      readonly destination: OrchestrationV2AppThread;
      readonly source: OrchestrationV2RunCauseSource;
      readonly modes: DispatchModes;
      readonly limit: DispatchModes | undefined;
      readonly taskId: NodeId;
    };

const makePrepared = (
  input: Omit<PreparedRunExecution, typeof prepared>,
): PreparedRunExecution => ({ ...input, [prepared]: true });
const ordinary = (taskId: NodeId | null): PreparedRunExecution =>
  makePrepared({
    executionScope: { kind: "ordinary" },
    executionCause: { kind: "independent" },
    executionDelivery: { kind: "message_text" },
    delegatedTaskId: taskId,
    modelSelection: null,
  });
const available = (thread: OrchestrationV2AppThread) =>
  thread.archivedAt === null && thread.deletedAt === null;

const loadSource = (store: Store, source: OrchestrationV2RunCauseSource) =>
  Effect.gen(function* () {
    const projection = yield* store.getThreadRecords(
      source.threadId,
      ["runs", "attempts", "turnItems"],
      {
        runIds: [source.runId],
        turnItemRunIds: [source.runId],
        turnItemTypes: ["run_interrupt_request"],
      },
    );
    const run = projection.runs.find((run) => run.id === source.runId);
    const attempt = projection.attempts.find((attempt) => attempt.id === source.attemptId);
    const exact =
      run !== undefined &&
      run.threadId === source.threadId &&
      run.activeAttemptId === source.attemptId &&
      run.status !== "rolled_back";
    const nativeExact =
      source.kind !== "native" ||
      (attempt !== undefined &&
        attempt.runId === run?.id &&
        attempt.providerInstanceId === source.providerInstanceId &&
        attempt.providerThreadId === source.providerThreadId &&
        attempt.nativeThreadId === source.nativeThreadId &&
        attempt.nativeAcceptance?.incarnation === source.incarnation &&
        attempt.submittedPolicy !== undefined &&
        attempt.providerTurnId !== null);
    if (!exact || !nativeExact || !available(projection.thread))
      return yield* new SwarmAdmissionLost({ threadId: source.threadId, runId: source.runId });
    return { thread: projection.thread, run, attempt, stopped: projection.turnItems.length !== 0 };
  });

const ancestry = (store: Store, thread: OrchestrationV2AppThread) =>
  Effect.gen(function* () {
    const threads: Array<OrchestrationV2AppThread> = [];
    const visited = new Set<ThreadId>();
    let current: OrchestrationV2AppThread | undefined = thread;
    while (current !== undefined) {
      if (visited.has(current.id) || !available(current)) return null;
      visited.add(current.id);
      threads.push(current);
      current =
        current.lineage.relationshipToParent === "subagent" &&
        current.lineage.parentThreadId !== null
          ? yield* store.getThread(current.lineage.parentThreadId)
          : undefined;
    }
    return threads;
  });

const scopeAllowed = (
  store: Store,
  thread: OrchestrationV2AppThread,
  scope: OrchestrationV2ExecutionScope,
  actual: DispatchModes,
) =>
  Effect.gen(function* () {
    if (scope.kind === "ordinary") return true;
    if (scope.kind === "denied") return false;
    const group = yield* store.getSwarm(scope.swarmId);
    if (
      group === undefined ||
      group.lifecycle.state !== "open" ||
      group.creationCommandId !== scope.creationCommandId ||
      group.ownerThreadId !== scope.ownerThreadId
    )
      return false;
    const path = yield* ancestry(store, thread);
    if (path === null || !path.some((ancestor) => ancestor.id === scope.memberThreadId))
      return false;
    if (
      exceededDispatchModeLimit(scope.submissionCeiling, actual) !== undefined ||
      path.some((ancestor) => exceededDispatchModeLimit(ancestor, actual) !== undefined)
    )
      return false;
    if (exceededDispatchModeLimit(scope.submissionCeiling, thread) !== undefined) return false;
    const dependencies = new Set(scope.revocationDependencies);
    if (
      dependencies.size !== scope.revocationDependencies.length ||
      !dependencies.has(scope.memberThreadId)
    )
      return false;
    for (const dependency of dependencies) {
      const member = group.members.find((member) => member.threadId === dependency);
      if (member?.admission.state !== "admitted") return false;
      if (!available(yield* store.getThread(dependency))) return false;
    }
    const guards = new Set<ThreadId>();
    for (const guard of scope.configurationGuards) {
      if (
        guards.has(guard.threadId) ||
        (guard.threadId !== scope.ownerThreadId &&
          !group.members.some((member) => member.threadId === guard.threadId))
      )
        return false;
      guards.add(guard.threadId);
      const current = yield* store.getThread(guard.threadId);
      if (
        !available(current) ||
        exceededDispatchModeLimit(guard.ceiling, current) !== undefined ||
        exceededDispatchModeLimit(current, actual) !== undefined
      )
        return false;
    }
    return guards.has(scope.ownerThreadId) && dependencies.has(scope.memberThreadId);
  });

const ordinaryProcessAllowed = (store: Store, process: OrchestrationV2NativeRunCauseSource) =>
  Effect.gen(function* () {
    const source = yield* loadSource(store, process);
    if (
      source.run.executionScope.kind !== "ordinary" ||
      source.stopped ||
      source.attempt?.nativeAcceptance?.onlyOrdinary !== true
    )
      return false;
    const projection = yield* store.getThreadRecords(process.threadId, ["providerThreads"]);
    const current = projection.providerThreads.find(
      (thread) => thread.id === process.providerThreadId,
    );
    return (
      current?.nativeAcceptance?.incarnation === process.incarnation &&
      current.nativeAcceptance.onlyOrdinary &&
      current.nativeAcceptance.policyAttemptId === process.attemptId &&
      current.nativeThreadRef?.nativeId === process.nativeThreadId &&
      current.providerSessionId === source.attempt?.submissionProviderSessionId
    );
  });

const bufferedProcessAllowed = (store: Store, process: OrchestrationV2NativeRunCauseSource) =>
  Effect.gen(function* () {
    const source = yield* loadSource(store, process);
    const projection = yield* store.getThreadRecords(process.threadId, ["providerThreads"]);
    const current = projection.providerThreads.find(
      (thread) => thread.id === process.providerThreadId,
    );
    return (
      source.attempt?.submittedPolicy !== undefined &&
      current?.nativeAcceptance?.incarnation === process.incarnation &&
      current.nativeAcceptance.policyAttemptId === process.attemptId &&
      current.nativeThreadRef?.nativeId === process.nativeThreadId &&
      current.providerSessionId === source.attempt.submissionProviderSessionId
    );
  });

const mergeScopes = (scopes: ReadonlyArray<SwarmScope>): SwarmScope | null => {
  const first = scopes[0];
  if (first === undefined) return null;
  if (
    scopes.some(
      (scope) =>
        scope.swarmId !== first.swarmId ||
        scope.creationCommandId !== first.creationCommandId ||
        scope.ownerThreadId !== first.ownerThreadId ||
        scope.memberThreadId !== first.memberThreadId,
    )
  )
    return null;
  const guards = new Map<ThreadId, DispatchModes>();
  for (const scope of scopes)
    for (const guard of scope.configurationGuards)
      guards.set(
        guard.threadId,
        minimumDispatchModes(guards.get(guard.threadId) ?? guard.ceiling, guard.ceiling),
      );
  return {
    ...first,
    submissionCeiling: minimumDispatchModes(...scopes.map((scope) => scope.submissionCeiling)),
    revocationDependencies: [
      ...new Set(scopes.flatMap((scope) => scope.revocationDependencies)),
    ].sort(),
    configurationGuards: [...guards]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([threadId, ceiling]) => ({ threadId, ceiling })),
  };
};

export const prepareWork = (
  store: Store,
  input: Preparation,
): Effect.Effect<
  PreparedRunExecution,
  ProjectionStore.ProjectionStoreV2Error | SwarmAdmissionLost
> =>
  Effect.gen(function* () {
    if (input.kind === "ordinary") return ordinary(input.taskId);
    const refuse = () => new SwarmAdmissionLost({ threadId: input.destination.id, runId: null });
    if (
      (input.kind === "continuation" || input.kind === "native") &&
      input.delivery.kind === "adapter_buffered" &&
      !(yield* bufferedProcessAllowed(store, input.delivery.process))
    )
      return yield* refuse();
    if (input.kind === "native" && input.cause.kind === "incomplete") {
      if (
        input.cause.ordinaryProcess === null ||
        !(yield* ordinaryProcessAllowed(store, input.cause.ordinaryProcess))
      )
        return yield* refuse();
      for (const reference of input.cause.knownSources)
        if ((yield* loadSource(store, reference)).run.executionScope.kind !== "ordinary")
          return yield* refuse();
      const process = yield* loadSource(store, input.cause.ordinaryProcess);
      return makePrepared({
        ...ordinary(null),
        executionCause: { kind: "native_unowned", process: input.cause.ordinaryProcess },
        executionDelivery: input.delivery,
        modelSelection:
          input.delivery.kind === "adapter_buffered" ? process.run.modelSelection : null,
      });
    }
    const references: ReadonlyArray<OrchestrationV2RunCauseSource> =
      input.kind === "continuation"
        ? input.sources
        : input.kind === "native"
          ? input.cause.kind === "complete"
            ? input.cause.sources
            : []
          : [input.source];
    if (references.length === 0) return yield* refuse();
    const sources = yield* Effect.forEach(references, (reference) => loadSource(store, reference));
    const source = sources[0];
    if (source === undefined) return yield* refuse();
    const scopes: Array<SwarmScope> = [];
    for (const captured of sources) {
      if (
        captured.run.executionScope.kind === "denied" ||
        (captured.stopped && !(input.kind === "continuation" && input.reason === "manual"))
      )
        return yield* refuse();
      if (captured.run.executionScope.kind === "swarm") {
        if (
          captured.attempt?.submittedPolicy === undefined ||
          !(yield* scopeAllowed(
            store,
            captured.thread,
            captured.run.executionScope,
            captured.attempt.submittedPolicy,
          ))
        )
          return yield* refuse();
        scopes.push(captured.run.executionScope);
      }
    }
    if (input.kind === "continuation" || input.kind === "native") {
      const bindings = sources.map(({ thread, run }) =>
        run.delegatedTaskId === undefined
          ? thread.forkedFrom?.type === "node"
            ? thread.forkedFrom.nodeId
            : null
          : run.delegatedTaskId,
      );
      if (
        sources.some(
          ({ run, thread }, index) =>
            thread.id !== input.destination.id ||
            bindings[index] !== bindings[0] ||
            (run.executionScope.kind === "ordinary" && scopes.length !== 0),
        )
      )
        return yield* refuse();
      const merged = mergeScopes(scopes);
      if (scopes.length !== 0 && merged === null) return yield* refuse();
      const delivery = input.delivery;
      let actualModel: ModelSelection | null = null;
      if (delivery.kind === "adapter_buffered") {
        const process = yield* loadSource(store, delivery.process);
        if (
          delivery.modelSelection.instanceId !== process.run.modelSelection.instanceId ||
          delivery.modelSelection.model !== process.run.modelSelection.model
        )
          return yield* refuse();
        if (
          merged !== null &&
          (process.attempt?.submittedPolicy === undefined ||
            exceededDispatchModeLimit(merged.submissionCeiling, process.attempt.submittedPolicy) !==
              undefined)
        )
          return yield* refuse();
        actualModel = process.run.modelSelection;
      }
      return makePrepared({
        executionScope: merged ?? { kind: "ordinary" },
        executionCause: {
          kind: "causal",
          reason: input.kind === "native" ? "native" : input.reason,
          sources: references,
        },
        executionDelivery: delivery,
        delegatedTaskId: bindings[0] ?? null,
        modelSelection: actualModel,
      });
    }
    if (input.kind === "delegation" && source.run.executionScope.kind === "ordinary")
      return ordinary(input.taskId);
    const inherited =
      source.run.executionScope.kind === "swarm" ? source.run.executionScope : undefined;
    const group =
      input.kind === "scoped"
        ? input.group
        : inherited === undefined
          ? undefined
          : yield* store.getSwarm(inherited.swarmId);
    if (
      group === undefined ||
      group.lifecycle.state !== "open" ||
      source.attempt?.submittedPolicy === undefined ||
      source.attempt.providerTurnId === null
    )
      return yield* refuse();
    if (
      inherited !== undefined &&
      (inherited.swarmId !== group.id || inherited.creationCommandId !== group.creationCommandId)
    )
      return yield* refuse();
    const owner = yield* store.getThread(group.ownerThreadId);
    if (!available(owner)) return yield* refuse();
    const memberThreadId =
      input.kind === "scoped" ? input.memberThreadId : inherited?.memberThreadId;
    if (
      memberThreadId === undefined ||
      !group.members.some(
        (member) => member.threadId === memberThreadId && member.admission.state === "admitted",
      )
    )
      return yield* refuse();
    const sourcePath = yield* ancestry(store, source.thread);
    if (sourcePath === null) return yield* refuse();
    const sourceMember = group.members.find((member) =>
      sourcePath.some((ancestor) => ancestor.id === member.threadId),
    );
    if (source.thread.id !== group.ownerThreadId && sourceMember?.admission.state !== "admitted")
      return yield* refuse();
    const beforeMeet = minimumDispatchModes(
      source.attempt.submittedPolicy,
      source.thread,
      owner,
      ...(inherited === undefined ? [] : [inherited.submissionCeiling]),
      ...(input.limit === undefined ? [] : [input.limit]),
    );
    const sourceProtection = minimumDispatchModes(
      inherited?.submissionCeiling ?? source.attempt.submittedPolicy,
      source.thread,
    );
    if (exceededDispatchModeLimit(sourceProtection, source.thread) !== undefined)
      return yield* refuse();
    if (exceededDispatchModeLimit(beforeMeet, input.destination) !== undefined)
      return yield* refuse();
    const guards = new Map<ThreadId, DispatchModes>(
      inherited?.configurationGuards.map((guard) => [guard.threadId, guard.ceiling]),
    );
    const guard = (threadId: ThreadId, ceiling: DispatchModes) =>
      guards.set(threadId, minimumDispatchModes(guards.get(threadId) ?? ceiling, ceiling));
    guard(owner.id, owner);
    if (sourceMember !== undefined && source.thread.id === sourceMember.threadId)
      guard(source.thread.id, sourceProtection);
    if (input.destination.id === memberThreadId) guard(memberThreadId, input.destination);
    const scope: SwarmScope = {
      kind: "swarm",
      swarmId: group.id,
      creationCommandId: group.creationCommandId,
      ownerThreadId: group.ownerThreadId,
      memberThreadId,
      submissionCeiling: minimumDispatchModes(beforeMeet, input.modes, input.destination),
      revocationDependencies: [
        ...new Set([
          ...(inherited?.revocationDependencies ?? []),
          ...(sourceMember === undefined ? [] : [sourceMember.threadId]),
          memberThreadId,
        ]),
      ].sort(),
      configurationGuards: [...guards]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([threadId, ceiling]) => ({ threadId, ceiling })),
    };
    return makePrepared({
      executionScope: scope,
      executionCause: {
        kind: "causal",
        reason: input.kind === "scoped" ? input.reason : "delegation",
        sources: references,
      },
      executionDelivery: { kind: "message_text" },
      delegatedTaskId: input.taskId,
      modelSelection: null,
    });
  });

export const runFromPrepared = (
  fields: Omit<
    OrchestrationV2Run,
    "executionScope" | "executionCause" | "executionDelivery" | "delegatedTaskId"
  >,
  plan: PreparedRunExecution,
): OrchestrationV2Run => ({
  ...fields,
  ...(plan.modelSelection === null
    ? {}
    : { modelSelection: plan.modelSelection, providerInstanceId: plan.modelSelection.instanceId }),
  executionScope: plan.executionScope,
  executionCause: plan.executionCause,
  executionDelivery: plan.executionDelivery,
  delegatedTaskId: plan.delegatedTaskId,
});

export const admitPersistedWork = (
  store: Store,
  thread: OrchestrationV2AppThread,
  run: OrchestrationV2Run,
  submittedModes?: DispatchModes,
) =>
  Effect.gen(function* () {
    if (
      run.executionScope.kind === "ordinary" &&
      run.executionCause.kind === "independent" &&
      run.executionDelivery.kind === "message_text"
    )
      return true;
    const current = yield* store.getThread(thread.id);
    if (
      !available(current) ||
      !(yield* scopeAllowed(store, current, run.executionScope, submittedModes ?? current))
    )
      return false;
    if (run.executionCause.kind === "native_unowned")
      return yield* ordinaryProcessAllowed(store, run.executionCause.process);
    if (run.executionCause.kind === "causal")
      for (const reference of run.executionCause.sources) {
        const source = yield* loadSource(store, reference);
        if (source.stopped && run.executionCause.reason !== "manual") return false;
      }
    if (run.executionDelivery.kind === "adapter_buffered") {
      if (!(yield* bufferedProcessAllowed(store, run.executionDelivery.process))) return false;
      const process = yield* loadSource(store, run.executionDelivery.process);
      if (
        process.attempt?.submittedPolicy === undefined ||
        (submittedModes !== undefined &&
          (exceededDispatchModeLimit(process.attempt.submittedPolicy, submittedModes) !==
            undefined ||
            exceededDispatchModeLimit(submittedModes, process.attempt.submittedPolicy) !==
              undefined))
      )
        return false;
    }
    return true;
  }).pipe(Effect.catchTags({ SwarmAdmissionLost: () => Effect.succeed(false) }));

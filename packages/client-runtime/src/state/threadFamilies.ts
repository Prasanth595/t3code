import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadFamily,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import { arrayElementsEqual } from "./entities.ts";
import { createEnvironmentQueryAtomFamily, selectEnvironmentQueryData } from "./runtime.ts";
import type { EnvironmentShellState } from "./shell.ts";

const EMPTY_FAMILY: OrchestrationV2ThreadFamily = { snapshotSequence: 0, threads: [] };
const EMPTY_MOUNTS: ReadonlyMap<ThreadId, number> = new Map();

/**
 * Family rows the shell does not have. A shell row is at least as new as any family copy, since
 * shell deltas carry every change; a family copy read before the shell removed that thread is
 * stale.
 */
export function threadFamilyRowsMissingFromShell(input: {
  readonly shellThreads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly families: ReadonlyArray<OrchestrationV2ThreadFamily>;
  readonly removedAt: ReadonlyMap<ThreadId, number>;
}): ReadonlyArray<OrchestrationV2ThreadShell> {
  const present = new Set<ThreadId>(input.shellThreads.map((thread) => thread.id));
  const missing: OrchestrationV2ThreadShell[] = [];
  for (const family of input.families) {
    for (const thread of family.threads) {
      if (present.has(thread.id)) continue;
      if ((input.removedAt.get(thread.id) ?? -1) > family.snapshotSequence) continue;
      present.add(thread.id);
      missing.push(thread);
    }
  }
  return missing;
}

/**
 * Shells that omit idle subagent children (`omitIdleSubagents`) leave those rows to thread
 * families: the active subagent tree that shares a thread's `lineage.rootThreadId`. A view, or a
 * queued message, mounts the family it needs; it is read once per shell generation. Family rows
 * merge behind shell rows and are never persisted. Shell deltas still carry every change, so a
 * changed child always arrives as a shell row, which wins.
 */
export function createThreadFamilyAtoms<R, ER, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  shellStateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentShellState, E>>,
) {
  const shellStateValue = (get: Atom.AtomContext, environmentId: EnvironmentId) =>
    Option.getOrNull(AsyncResult.value(get(shellStateAtom(environmentId))));

  // The generation is part of the key, so a read from before the latest authoritative snapshot is
  // never used again, even while a new read is pending or failed.
  const familyQueryAtom = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:orchestration:thread-family",
    staleTimeMs: Number.POSITIVE_INFINITY,
    idleTtlMs: 60_000,
    execute: Effect.fn("ThreadFamilies.read")(function* (input: {
      readonly threadId: ThreadId;
      readonly generation: number;
    }) {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const session = yield* SubscriptionRef.get(supervisor.session);
      const supported =
        Option.isSome(session) &&
        (yield* session.value.initialConfig.pipe(
          Effect.map((config) => config.shellThreadFamilies === true),
          Effect.orElseSucceed(() => false),
        ));
      // Servers without families send every child in the shell, so absent means gone.
      if (!supported) return EMPTY_FAMILY;
      return yield* request(ORCHESTRATION_V2_WS_METHODS.getThreadFamily, {
        threadId: input.threadId,
      });
    }),
  });

  const familyAtom = Atom.family((key: string) => {
    const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
    return Atom.make((get) =>
      get(
        familyQueryAtom({
          environmentId,
          input: { threadId, generation: shellStateValue(get, environmentId)?.generation ?? 0 },
        }),
      ),
    ).pipe(Atom.withLabel(`environment-thread-family:${key}`));
  });

  const mountsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(EMPTY_MOUNTS).pipe(
      Atom.keepAlive,
      Atom.withLabel(`environment-thread-family-mounts:${environmentId}`),
    ),
  );

  /** Keeps a thread's family in the merged rows until the returned release runs. */
  const mount = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ): (() => void) => {
    const atom = mountsAtom(environmentId);
    registry.set(
      atom,
      new Map(registry.get(atom)).set(threadId, (registry.get(atom).get(threadId) ?? 0) + 1),
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = new Map(registry.get(atom));
      const count = (next.get(threadId) ?? 0) - 1;
      if (count > 0) next.set(threadId, count);
      else next.delete(threadId);
      registry.set(atom, next);
    };
  };

  const snapshotAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: {
      readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
      readonly extras: ReadonlyArray<OrchestrationV2ThreadShell>;
      readonly merged: ReadonlyArray<OrchestrationV2ThreadShell>;
    } | null = null;
    return Atom.make((get): OrchestrationV2ShellSnapshot | null => {
      const state = shellStateValue(get, environmentId);
      const snapshot = state === null ? null : Option.getOrNull(state.snapshot);
      const mounts = get(mountsAtom(environmentId));
      if (snapshot === null || state === null || mounts.size === 0) return snapshot;
      const extras = threadFamilyRowsMissingFromShell({
        shellThreads: snapshot.threads,
        removedAt: state.removedAt,
        families: [...mounts.keys()].flatMap((threadId) => {
          const family = selectEnvironmentQueryData(
            get(familyAtom(JSON.stringify([environmentId, threadId]))),
          );
          return family === null ? [] : [family];
        }),
      });
      if (extras.length === 0) return snapshot;
      // Keep the merged array while neither part changed, so thread lists skip their rebuild.
      if (
        previous === null ||
        previous.threads !== snapshot.threads ||
        !arrayElementsEqual(previous.extras, extras)
      ) {
        previous = { threads: snapshot.threads, extras, merged: [...snapshot.threads, ...extras] };
      }
      return { ...snapshot, threads: previous.merged };
    }).pipe(Atom.withLabel(`environment-snapshot-with-families:${environmentId}`));
  });

  return {
    /** The shell snapshot plus the rows of every mounted family. */
    snapshotAtom,
    /** The current generation's family read, for decisions that need a settled answer. */
    familyAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
      familyAtom(JSON.stringify([environmentId, threadId])),
    mount,
  };
}

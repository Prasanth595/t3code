import {
  createPullRequestEnvironmentAtoms,
  createPullRequestStackAtomFamily,
} from "@t3tools/client-runtime/state/pull-requests";
import type { EnvironmentId, PullRequestListInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import {
  EMPTY_PULL_REQUEST_STATS_CACHE,
  patchPullRequestListEntry,
  pullRequestListHead,
  withAnsweredPullRequestStats,
  withListedPullRequests,
  type PullRequestListPages,
  type PullRequestStatsCache,
} from "../features/pull-requests/pullRequestList";

export const pullRequestListPagesKey = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: PullRequestListInput;
}) => JSON.stringify([target.environmentId, target.input]);

const pullRequestListPagesTargets = new WeakMap<
  object,
  { readonly environmentId: EnvironmentId; readonly input: PullRequestListInput }
>();
/** The pages loaded past each listing's head, keyed by {@link pullRequestListPagesKey}. */
export const pullRequestListPagesFamily = Atom.family((key: string) => {
  const atom = Atom.make<PullRequestListPages | null>(null).pipe(Atom.setIdleTTL(5 * 60_000));
  const [environmentId, input]: [EnvironmentId, PullRequestListInput] = JSON.parse(key);
  pullRequestListPagesTargets.set(atom, { environmentId, input });
  return atom;
});

/** Diff stats each environment has answered so far, so rows keep them when they scroll away. */
export const pullRequestListStatsFamily = Atom.family((_environmentId: string) =>
  Atom.make<PullRequestStatsCache>(EMPTY_PULL_REQUEST_STATS_CACHE).pipe(
    Atom.setIdleTTL(5 * 60_000),
  ),
);

export const composerPullRequests = createPullRequestEnvironmentAtoms(connectionAtomRuntime, {
  actionResult: (target, result, registry) =>
    Effect.sync(() => {
      if (target.input.expectedAccountId !== undefined) return;
      for (const atom of registry.getNodes().keys()) {
        if (typeof atom === "string") continue;
        const listTarget = pullRequestListPagesTargets.get(atom);
        if (listTarget?.environmentId !== target.environmentId) continue;
        const pagesAtom = pullRequestListPagesFamily(pullRequestListPagesKey(listTarget));
        const query = composerPullRequests.list(listTarget);
        const head = Option.getOrNull(
          Option.flatMap(
            registry.getNodes().get(query)?.valueOption() ?? Option.none(),
            (cached: Atom.Type<typeof query>) => AsyncResult.value(cached),
          ),
        );
        registry.update(pagesAtom, (pages) =>
          patchPullRequestListEntry(
            pages,
            head,
            target.input,
            {
              state: result.state,
              isDraft: result.isDraft,
              updatedAt: result.updatedAt,
            },
            result.observedAt,
          ),
        );
      }
    }),
  // A new head can change which files GitHub still counts as viewed, so the viewed-files read is
  // refreshed where the new head lands. The detail atom still holds the previous answer here.
  detail: (target, value, registry) =>
    Effect.sync(() => {
      const previous = AsyncResult.value(registry.get(composerPullRequests.detail(target)));
      if (Option.isSome(previous) && previous.value.headSha !== value.headSha)
        registry.refresh(composerPullRequests.filesViewed(target));
    }),
  list: (target, value, registry) =>
    Effect.sync(() => {
      const statsAtom = pullRequestListStatsFamily(target.environmentId);
      const { cache, refresh } = withListedPullRequests(registry.get(statsAtom), value.entries);
      registry.set(statsAtom, cache);
      for (const input of refresh)
        registry.refresh(
          composerPullRequests.listStats({ environmentId: target.environmentId, input }),
        );
      if (target.input.cursors === undefined)
        registry.update(pullRequestListPagesFamily(pullRequestListPagesKey(target)), (previous) =>
          pullRequestListHead(previous, value),
        );
    }),
  listStats: (target, value, registry) =>
    Effect.sync(() =>
      registry.update(pullRequestListStatsFamily(target.environmentId), (previous) =>
        withAnsweredPullRequestStats(previous, target.input, value.stats),
      ),
    ),
});
export const pullRequestStackAtom = createPullRequestStackAtomFamily(
  connectionAtomRuntime,
  composerPullRequests.refreshes,
);

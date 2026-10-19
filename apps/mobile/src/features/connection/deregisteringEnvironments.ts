import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Account environments being deregistered from Settings. A row hides from
 * confirm until discovery lists without it: a refresh can still return a
 * listing fetched before the unlink, and a re-link keeps the same linkedAt,
 * so the hide ends on absence instead of on a refresh or a timestamp.
 */
export type DeregisteringEnvironments = ReadonlyMap<EnvironmentId, "pending" | "unlinked">;

/** Drops unlinked entries the listing no longer has, so a later re-link shows again. */
export function settleDeregisteringEnvironments(
  deregistering: DeregisteringEnvironments,
  listedIds: ReadonlySet<EnvironmentId>,
): DeregisteringEnvironments {
  const next = new Map(
    [...deregistering].filter(
      ([environmentId, phase]) => phase === "pending" || listedIds.has(environmentId),
    ),
  );
  return next.size === deregistering.size ? deregistering : next;
}

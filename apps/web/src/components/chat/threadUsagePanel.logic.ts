const USAGE_REFRESH_MIN_INTERVAL_MS = 30_000;

/**
 * How long to hold a refresh that a finished run asked for: 0 runs it now, anything else
 * is the wait before one refresh that covers every run finishing meanwhile.
 */
export function usageRefreshDelay(
  lastRefreshAt: number | null,
  now: number,
  minIntervalMs = USAGE_REFRESH_MIN_INTERVAL_MS,
): number {
  if (lastRefreshAt === null) return 0;
  return Math.max(0, lastRefreshAt + minIntervalMs - now);
}

/** The thread's own provider first, then the rest in a stable order. */
export function orderUsageDrivers<D extends string>(
  drivers: ReadonlyArray<D>,
  threadDriver: D | null,
  rank: (driver: D) => number,
): ReadonlyArray<D> {
  return [...new Set(drivers)].toSorted((left, right) => {
    if (left === threadDriver) return -1;
    if (right === threadDriver) return 1;
    return rank(left) - rank(right) || left.localeCompare(right);
  });
}

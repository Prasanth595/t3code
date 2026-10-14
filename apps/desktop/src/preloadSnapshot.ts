/**
 * Cache a value the main process pushes whenever it changes. Only the first
 * read before any push costs a synchronous IPC; a failed read leaves the cache
 * empty so the next read retries.
 */
export function createPreloadSnapshot<T>(readInitial: () => T) {
  let snapshot: { readonly value: T } | undefined;

  return {
    read: (): T => {
      snapshot ??= { value: readInitial() };
      return snapshot.value;
    },
    set: (value: T): void => {
      snapshot = { value };
    },
  };
}

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { scopedThreadKey } from "../../lib/scopedEntities";

type ThreadIdentity = Pick<EnvironmentThreadShell, "environmentId" | "id">;

function keyOf(thread: ThreadIdentity) {
  return scopedThreadKey(thread.environmentId, thread.id);
}

export function updateHiddenThreadKeys(
  keys: readonly string[],
  thread: ThreadIdentity,
  hidden: boolean,
): readonly string[] {
  const key = keyOf(thread);
  return hidden
    ? keys.includes(key)
      ? keys
      : [...keys, key]
    : keys.filter((item) => item !== key);
}

export function filterHiddenThreads<T extends ThreadIdentity>(
  threads: readonly T[],
  hiddenKeys: ReadonlySet<string>,
  showHidden: boolean,
): readonly T[] {
  return showHidden ? threads : threads.filter((thread) => !hiddenKeys.has(keyOf(thread)));
}

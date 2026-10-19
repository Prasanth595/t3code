import type { EnvironmentId } from "@t3tools/contracts";

export type PushRegistrationFailure = "retrying" | "failed" | null;
let failure: PushRegistrationFailure = null;
const listeners = new Set<() => void>();

export const readPushRegistrationFailure = () => failure;
export const subscribePushRegistrationFailure = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

function setFailure(next: PushRegistrationFailure) {
  if (next === failure) return;
  failure = next;
  for (const listener of listeners) listener();
}

const RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000];

/** Retry only failed environments; cancellation prevents stale work from saving or retrying. */
export function startPushRegistration(
  environments: ReadonlyArray<EnvironmentId>,
  register: (
    id: EnvironmentId,
    active: () => boolean,
  ) => Promise<{ readonly _tag: "Success" | "Failure" } | void>,
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const active = () => !stopped;
  setFailure(null);
  const run = async (pending: ReadonlyArray<EnvironmentId>, attempt: number) => {
    const failed: EnvironmentId[] = [];
    for (const id of pending) {
      if (stopped) return;
      try {
        const result = await register(id, active);
        if (result?._tag === "Failure") failed.push(id);
      } catch {
        failed.push(id);
      }
    }
    if (stopped) return;
    const delay = RETRY_DELAYS[attempt];
    setFailure(failed.length === 0 ? null : delay === undefined ? "failed" : "retrying");
    if (failed.length > 0 && delay !== undefined) {
      timer = setTimeout(() => void run(failed, attempt + 1), delay);
    }
  };
  void run(environments, 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export function clearPushRegistrationFailure() {
  setFailure(null);
}

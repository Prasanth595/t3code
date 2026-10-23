// @effect-diagnostics globalTimers:off - the profile window is a plain delay inside a promise.
// @effect-diagnostics nodeBuiltinImport:off - node:inspector is the only in-process CPU profiler, and the profile goes to disk.
import * as DateTime from "effect/DateTime";
import * as NodeFSP from "node:fs/promises";
import * as NodeInspector from "node:inspector";
import * as NodePath from "node:path";

export const makeProfileLimiter = (minIntervalMs: number, now: () => number = Date.now) => {
  let lastMs: number | undefined;
  return {
    tryAcquire(): boolean {
      const t = now();
      if (lastMs !== undefined && t - lastMs < minIntervalMs) return false;
      lastMs = t;
      return true;
    },
  };
};

const post = (session: NodeInspector.Session, method: string, params?: object) =>
  new Promise<any>((resolve, reject) => {
    session.post(method, params, (error, result) => (error ? reject(error) : resolve(result)));
  });

/** Profiles this process for `durationMs` and writes the result to `file`. */
const profileTo = async (file: string, durationMs: number) => {
  const session = new NodeInspector.Session();
  session.connect();
  try {
    await post(session, "Profiler.enable");
    await post(session, "Profiler.start");
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    const { profile } = await post(session, "Profiler.stop");
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(file, JSON.stringify(profile));
  } finally {
    session.disconnect();
  }
};

export interface StallProfilerOptions {
  readonly dir: string;
  readonly durationMs?: number;
  readonly minIntervalMs?: number;
  /** A stall of at least this many ms starts a profile. */
  readonly thresholdMs?: number;
  readonly now?: () => number;
  readonly onWritten?: (file: string) => void;
  readonly onError: (error: unknown) => void;
}

/**
 * Returns the function to call with each stall's length. A noticeable stall starts a CPU
 * profile of what runs next, at most one per `minIntervalMs`; the call returns whether it
 * started one. It never throws.
 */
export const makeStallProfiler = (options: StallProfilerOptions) => {
  const limiter = makeProfileLimiter(options.minIntervalMs ?? 10 * 60_000, options.now);
  const durationMs = options.durationMs ?? 30_000;
  const thresholdMs = options.thresholdMs ?? 5000;
  return (stallMs: number): boolean => {
    if (stallMs < thresholdMs || !limiter.tryAcquire()) return false;
    const file = NodePath.join(
      options.dir,
      `${DateTime.formatIso(DateTime.nowUnsafe()).replaceAll(":", "-")}.cpuprofile`,
    );
    profileTo(file, durationMs).then(
      () => options.onWritten?.(file),
      (error) => options.onError(error),
    );
    return true;
  };
};

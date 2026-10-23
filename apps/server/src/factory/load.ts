// @effect-diagnostics nodeBuiltinImport:off - the load average is the host's own.
/**
 * The load the pass and the gate check against `max_load_per_core`: gates that run on an
 * overloaded machine fail on test timeouts the code did not cause.
 */
import * as NodeOS from "node:os";

/** The machine's 1-minute load average and the cores it is shared by, as `readLoad` read them. */
export interface Load {
  readonly oneMinute: number;
  readonly cores: number;
}

export const readLoad = (): Load => ({
  oneMinute: NodeOS.loadavg()[0] ?? 0,
  cores: NodeOS.availableParallelism(),
});

/** The load above its limit, `max_load_per_core` times the cores. */
export interface Overload {
  readonly oneMinute: number;
  readonly cores: number;
  readonly limit: number;
}

/**
 * The load when it is above `maxLoadPerCore` times the cores; null under it or at it. 0 turns the
 * check off, and `read` is not called.
 */
export const overload = (maxLoadPerCore: number, read: () => Load): Overload | null => {
  if (maxLoadPerCore === 0) return null;
  const { oneMinute, cores } = read();
  const limit = maxLoadPerCore * cores;
  return oneMinute > limit ? { oneMinute, cores, limit } : null;
};

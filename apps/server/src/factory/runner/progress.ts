/**
 * What a run's ledger already records, for a step that must not do twice what is done. The part
 * of softfac's `runner/progress.rs` the claim needs; later steps add what they read.
 */

import { STATES, type State } from "../domain/lifecycle.ts";
import type { Entry } from "../ledger/read.ts";

export interface Seen {
  readonly claimed: boolean;
  /** The moment in the first `approved <time>` step: when an instructor applied the label the run was approved on. */
  readonly approvedAt: string | null;
  /** From the last `state_changed`; null before any. */
  readonly state: State | null;
  /** The `session_launched` line's thread. */
  readonly threadId: string | null;
  /** The reason on the `stuck` line: the comment is on the issue. */
  readonly stuck: string | null;
  readonly finished: boolean;
}

const isState = (value: unknown): value is State =>
  typeof value === "string" && (STATES as ReadonlyArray<string>).includes(value);

const field = (data: unknown, key: string): unknown =>
  typeof data === "object" && data !== null ? (data as Record<string, unknown>)[key] : undefined;

export const readProgress = (entries: ReadonlyArray<Entry>): Seen => {
  let claimed = false;
  let approvedAt: string | null = null;
  let state: State | null = null;
  let threadId: string | null = null;
  let stuck: string | null = null;
  let finished = false;
  for (const entry of entries) {
    switch (entry.event) {
      case "claimed":
        claimed = true;
        break;
      case "step_changed": {
        const step = field(entry.data, "step");
        if (approvedAt === null && typeof step === "string" && step.startsWith("approved ")) {
          approvedAt = step.slice("approved ".length);
        }
        break;
      }
      case "state_changed": {
        const to = field(entry.data, "to");
        state = isState(to) ? to : null;
        break;
      }
      case "session_launched": {
        const id = field(entry.data, "thread_id");
        if (typeof id === "string") threadId = id;
        break;
      }
      case "stuck": {
        const reason = field(entry.data, "reason");
        stuck = typeof reason === "string" ? reason : "";
        break;
      }
      case "finished":
        finished = true;
        break;
    }
  }
  return { claimed, approvedAt, state, threadId, stuck, finished };
};

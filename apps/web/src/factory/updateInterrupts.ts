import type { FactoryStatus } from "./api";

/**
 * The run states that wait on a person, which `factory/scripts/autodeploy.sh` does not wait for.
 * updateInterrupts.test.ts fails when its list and this one differ.
 */
export const WAITING_ON_A_PERSON: ReadonlySet<string> = new Set(["pr-open", "needs-info", "stuck"]);

/** The runs an update interrupts: unreadable, or in a state that does not wait on a person. */
export const runsInProgress = (runs: FactoryStatus["runs"]) =>
  runs.filter(({ state, unreadable }) => unreadable || !WAITING_ON_A_PERSON.has(state ?? ""));

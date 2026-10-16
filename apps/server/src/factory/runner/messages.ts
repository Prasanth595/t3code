/**
 * The fixed words the factory writes on an issue from the claim. Ported from softfac's
 * `runner/messages.rs` and `runner/start.rs`; the wording is the contract with people who read
 * the issues, so it is copied as is.
 */

import type { State } from "../domain/lifecycle.ts";

/** The public reason when a run has no record of what approved it. */
export const CANNOT_CONFIRM = "the factory could not confirm the issue text was approved";

/**
 * What the factory says on an issue it moved to `factory:proposed` because its claim was cut
 * short and no run was started. The same words for the repair and for the pass that finds
 * such an issue later.
 */
export const CUT_SHORT_COMMENT =
  "The factory's claim on this issue was cut short and no run was started, so it has moved the issue to `factory:proposed`. An instructor can apply `factory:ready` again to have it built.";

/** The comment on an issue the factory gave up on. `reason` is the public reason. */
export const stuckComment = (reason: string): string =>
  `The factory could not finish this issue and has released it.\n\nReason: ${reason}\n\nFix the cause, then set the label back to \`factory:ready\`.`;

/** The issue's single status comment. */
export const statusBody = (
  state: State,
  machine: string,
  threadId: string | null,
  pr: number | null,
): string =>
  `**Factory status:** ${state}\n- Machine: ${machine}\n- Session: ${threadId ?? "none"}\n- PR: ${pr === null ? "none" : `#${pr}`}`;

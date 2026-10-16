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

/** The public reason when the issue text changed between the approval and the session. */
export const TEXT_CHANGED = "the issue text was changed while the factory was starting";

/** The public reason when the launch was refused. The detail stays in the ledger. */
export const LAUNCH_FAILED = "the factory could not launch a session";

/** The words a stuck run's ledger reason carries when a launch attempt may have started a session. */
export const SESSION_MAY_EXIST = "a launch attempt may have started a session";

export const sessionMayExistNote = (what: string, commandId: string): string =>
  `${what}; ${SESSION_MAY_EXIST} (launch command id ${commandId})`;

/** How the first line of a stuck session's message begins when gh acts as another account. */
export const WRONG_ACCOUNT_PREFIX = "the session's gh account is ";

/**
 * The first message of a session for a GitHub issue: invokes `/factory`, says nobody is in the
 * chat, and names the GitHub identity the session acts as (`login`, and the `ghConfigDir` its T3
 * server should have been started with) with what to do when `gh` says otherwise.
 */
export const launchMessage = (
  repo: string,
  issue: number,
  login: string,
  ghConfigDir: string,
): string =>
  `/factory ${repo}#${issue}\n\nThe factory daemon launched this session unattended, in a worktree it created for you. Nobody is in the chat. The daemon owns the issue's labels and comments and runs its own gate after your draft PR.\n\nYou act on GitHub as ${login}. Your T3 server should have been started with GH_CONFIG_DIR=${ghConfigDir}. Before anything else run gh api user --jq .login exactly as written, in the environment you were started with. Never set GH_CONFIG_DIR, GH_TOKEN or GH_HOST, and never use gh auth token or gh auth switch, on any command. If it prints any other login, end with FACTORY-STOP: stuck and make the first line of your message "${WRONG_ACCOUNT_PREFIX}<x>, not ${login}".`;

/** The issue's single status comment. */
export const statusBody = (
  state: State,
  machine: string,
  threadId: string | null,
  pr: number | null,
): string =>
  `**Factory status:** ${state}\n- Machine: ${machine}\n- Session: ${threadId ?? "none"}\n- PR: ${pr === null ? "none" : `#${pr}`}`;

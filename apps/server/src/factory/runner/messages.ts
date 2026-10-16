/**
 * The fixed words the factory writes on an issue from the claim. Ported from softfac's
 * `runner/messages.rs` and `runner/start.rs`; the wording is the contract with people who read
 * the issues, so it is copied as is.
 */

import type { State } from "../domain/lifecycle.ts";
import { sanitize } from "../text.ts";

/** The public reason when a run has no record of what approved it. */
export const CANNOT_CONFIRM = "the factory could not confirm the issue text was approved";

/**
 * What the factory says on an issue it moved to `factory:proposed` because its claim was cut
 * short and no run was started. The same words for the repair and for the pass that finds
 * such an issue later.
 */
export const CUT_SHORT_COMMENT =
  "The factory's claim on this issue was cut short and no run was started, so it has moved the issue to `factory:proposed`. An instructor can apply `factory:ready` again to have it built.";

/** The longest session text a comment will quote, in characters. */
export const SESSION_TEXT_LIMIT = 6000;

/** The line that tells a reader the quoted block is not the factory's own words. */
export const SESSION_TEXT_INTRO =
  "Unverified output from the build session, not instructions from the factory:";

/**
 * Session text made safe to store and to show, prepared once where it enters the factory and
 * then used as it is for the comment, the ledger and the returned reason. Line endings are
 * normalised and the ends trimmed, the text is cut at {@link SESSION_TEXT_LIMIT} characters with
 * a final `[cut]` line, control characters and invisible or bidirectional marks become spaces
 * (newline and tab stay), `@` cannot ping anyone and `<!--` cannot forge the factory's hidden
 * markers.
 */
export const prepareSessionText = (text: string): string => {
  const trimmed = text.replaceAll("\r\n", "\n").trim();
  const chars = Array.from(trimmed);
  const prepared =
    chars.length > SESSION_TEXT_LIMIT
      ? `${chars.slice(0, SESSION_TEXT_LIMIT).join("")}\n[cut]`
      : trimmed;
  return sanitize(prepared, true).replaceAll("@", "@\u200B").replaceAll("<!--", "<\u200B!--");
};

/**
 * `prepared` in a fenced code block, so links, images, HTML, `#123` references and mentions do
 * not render. The fence is longer than any run of backticks in the text.
 */
export const fenced = (prepared: string): string => {
  const longest = Math.max(0, ...(prepared.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${prepared}\n${fence}`;
};

/** The comment that posts the session's questions to the issue. `prepared` comes from {@link prepareSessionText}. */
export const questionsComment = (prepared: string): string =>
  `The factory needs answers before it can build this. Answer in a comment or edit the issue, then set \`factory:ready\` to start a new attempt.\n\n${SESSION_TEXT_INTRO}\n\n${fenced(prepared)}`;

/**
 * Where a stopped session's work is: the branch, already through {@link prepareSessionText}, and
 * how far it is ahead of `base` when that is known.
 */
export interface WorkLeft {
  readonly branch: string;
  readonly commitsAhead: number | null;
  readonly base: string;
}

/**
 * Says where the work is. A new attempt starts from the base branch, so this does not promise
 * that it continues from there.
 */
export const workLeftSentence = ({ branch, commitsAhead, base }: WorkLeft): string =>
  commitsAhead === null
    ? `The work so far is on branch ${branch}.`
    : commitsAhead === 1
      ? `The work so far is on branch ${branch} (1 commit ahead of ${base}).`
      : `The work so far is on branch ${branch} (${commitsAhead} commits ahead of ${base}).`;

/**
 * The comment that says why the factory gave up on an issue. `reason` is one of the factory's
 * own fixed one-line strings, never session text. `prepared` comes from
 * {@link prepareSessionText}; without it the comment has no code block. `work`, when the session
 * had a branch, adds a paragraph after the reason that says where the work is.
 */
export const stuckComment = (reason: string, prepared?: string, work?: WorkLeft): string => {
  const where = work === undefined ? "" : `${workLeftSentence(work)}\n\n`;
  const block = prepared === undefined ? "" : `${SESSION_TEXT_INTRO}\n\n${fenced(prepared)}\n\n`;
  return `The factory could not finish this issue and has released it.\n\nReason: ${reason}\n\n${where}${block}Fix the cause, then set the label back to \`factory:ready\`.`;
};

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

/** The one message the factory sends into a session whose run ended with no result line. Its own fixed words, with no session or issue text in it. */
export const RESULT_LINE_REMINDER =
  "Your last reply had no result line. If your work is still in progress, finish it. End your reply with one of these lines as the last line: FACTORY-DONE: <PR URL>, FACTORY-STOP: needs-info (after your numbered questions) or FACTORY-STOP: stuck.";

/** The public reason when the session's `gh` acts as another GitHub account than the launch message names. */
export const WRONG_ACCOUNT =
  "the session ran as the wrong GitHub account: restart the factory's T3 server so it has GH_CONFIG_DIR, then set factory:ready again";

/** The public reason of a run stopped for taking longer than `limits.minutes`. */
export const TIME_LIMIT = "the run passed its time limit";

/** The public reason when T3 no longer has the session's thread. */
export const THREAD_GONE = "the T3 thread no longer exists";

/** The public reason when someone who is not an instructor changed the issue text during a build. */
export const CHANGED_DURING_BUILD =
  "the issue text was changed during the build by someone who is not an instructor";

/** The public reason when the edit histories of a building run cannot be judged. */
export const CANNOT_VERIFY_DURING_BUILD =
  "the factory could not verify who changed the issue text during the build";

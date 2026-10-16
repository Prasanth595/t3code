/**
 * The session that fixes a failed re-gate of a ready pull request, ported from softfac's
 * `runner.rs` (`branch_refused`, `send_relaunch`, `relaunch_session`). The ready pull request's
 * session was stopped and its worktree removed when the gate passed, so a failure has no session
 * to be sent to: a new one is launched from the pull request's branch at its tip on `origin`,
 * with the failure in its first message, and pushes to the same branch.
 *
 * The decision (`regate_relaunching`) is in the ledger before this runs, so a call that finds it
 * with no `session_launched` after it sends the launch again under the same command id, and T3
 * answers with the thread it made.
 */
import * as Effect from "effect/Effect";

import type { Ledger } from "../ledger/ledger.ts";
import { ledgerCall as ledger } from "../ledger/errors.ts";
import { makeCause } from "../ledger/events.ts";
import { runIdToString, type RunId } from "../ledger/runId.ts";
import type { IssueDetail } from "../tracker/github.ts";
import type { FactorySessions, Model } from "../t3/sessions.ts";
import {
  END_WITH_DONE,
  LAUNCH_FAILED,
  launchMessage,
  sessionMayExistNote,
  type ResumeFrom,
} from "./messages.ts";
import { relaunchCommandId, type Relaunch } from "./progress.ts";
import {
  describe,
  goStuck,
  recordedReason,
  type Progress,
  type RunContext,
  type RunError,
  type Stop,
} from "./run.ts";

/** What a relaunch asks of the factory besides what the stop and finish paths ask. */
export interface RelaunchContext extends RunContext {
  /** `owner/name` as the machine config writes it. */
  readonly repo: string;
  /** The local clone the T3 project is rooted at: `WatchedRepo.path`. */
  readonly repoPath: string;
  /** The `GH_CONFIG_DIR` the launch message names. */
  readonly ghConfigDir: string;
  readonly model: Model;
  readonly sessions: RunContext["sessions"] &
    Pick<FactorySessions["Service"], "findProject" | "launch">;
}

/** How `relaunchSession` ended. */
export type Relaunched =
  /** The new session is launched and its `session_launched` line is written. */
  | { readonly kind: "recorded" }
  /** The launch was refused and the issue went `stuck`; `reason` is as the ledger records it. */
  | { readonly kind: "stuck"; readonly reason: string };

/**
 * The stop for a pull request whose branch cannot go to a session, or `null` when it can. The
 * branch is text from the pull request, and goes into a command the session runs: a name with
 * anything but the characters of an ordinary branch is not passed on.
 */
export const branchRefused = (branch: string): Stop | null =>
  /^[A-Za-z0-9/._-]+$/.test(branch) && !branch.startsWith("-") && !branch.includes("..")
    ? null
    : { reason: LAUNCH_FAILED, detail: "the pull request's branch is not a plain branch name" };

/**
 * Launches the session of a decided relaunch and writes its `session_launched` line, with
 * `resumed_from` (this run and the pull request's branch). `earlierCall` says an earlier call
 * reached this point, so a session may exist whatever this call's refusal says. Not finding the
 * project fails as an error with nothing written; a project that is not there, or a launch T3
 * answers with a failure (in-process, every failure of the call is T3's answer after the request
 * went out, and a session may exist), sends the issue `stuck` with the note and the command id.
 */
export const relaunchSession = (
  ctx: RelaunchContext,
  out: Ledger,
  at: Progress,
  run: RunId,
  from: { readonly prUrl: string; readonly earlierCall: boolean },
  detail: IssueDetail,
  relaunch: Relaunch,
): Effect.Effect<Relaunched, RunError> =>
  Effect.gen(function* () {
    const issue = Number(run.issue);
    const commandId = relaunchCommandId(relaunch, run);
    const refuse = (note: string) =>
      Effect.gen(function* () {
        const stop: Stop = { reason: LAUNCH_FAILED, detail: note };
        yield* goStuck(ctx, issue, out, at, "launch-failed", stop);
        return { kind: "stuck", reason: recordedReason(stop) } as const;
      });
    const projectId = yield* ctx.sessions.findProject(ctx.repoPath);
    if (projectId === null) {
      const missing = "no T3 project for this repo on this machine";
      return yield* refuse(from.earlierCall ? sessionMayExistNote(missing, commandId) : missing);
    }
    const resumed: ResumeFrom = {
      branch: relaunch.branch,
      prUrl: from.prUrl,
      after: "failed-regate",
    };
    const message = `${launchMessage(ctx.repo, issue, ctx.trackerUser, ctx.ghConfigDir, resumed)}\n\n${END_WITH_DONE}\n\n${relaunch.message}`;
    const launched = yield* Effect.result(
      ctx.sessions.launch({
        commandId,
        projectId,
        title: `${ctx.repo}#${issue} ${detail.title}`,
        baseRef: relaunch.branch,
        startFromOrigin: true,
        message,
        model: ctx.model,
      }),
    );
    if (launched._tag === "Failure") {
      return yield* refuse(sessionMayExistNote(describe(launched.failure.cause), commandId));
    }
    const { threadId, worktreePath, branch } = launched.success;
    yield* ledger(() =>
      out.append(
        {
          event: "session_launched",
          data: {
            thread_id: threadId,
            worktree: worktreePath,
            branch,
            model_instance: ctx.model.instanceId,
            model: ctx.model.model,
            resumed_from: { run: runIdToString(run), branch: relaunch.branch },
          },
        },
        makeCause(at.step, "resumed-from-branch"),
      ),
    );
    at.threadId = threadId;
    at.worktree = worktreePath;
    at.worktreeDone = false;
    return { kind: "recorded" } as const;
  });

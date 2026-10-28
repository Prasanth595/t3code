import type {
  PullRequestComment,
  PullRequestState,
  ThreadPullRequestLink,
  ThreadSnoozeWakeReason,
} from "@t3tools/contracts";

/** One linked pull request as last read, for a thread snoozed until a reply. */
export interface ReplyWakeRead {
  readonly number: number;
  readonly url: string;
  readonly state: PullRequestState;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly viewer: string | null;
  /** Null when only the state was read. */
  readonly remarks: ReadonlyArray<PullRequestComment> | null;
}

const REVIEW_STATES: Record<string, ThreadSnoozeWakeReason["reviewState"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  COMMENTED: "commented",
};

/** Hosts that cannot tell a maintainer leave it unknown; anyone but the viewer or a bot counts there. */
const isReply = (remark: PullRequestComment, viewer: string | null) =>
  remark.author !== null &&
  remark.author.isBot !== true &&
  remark.author.login.toLowerCase() !== viewer?.toLowerCase() &&
  remark.authorIsMaintainer !== false;

/** Links whose replies can wake the thread: the viewer's own, open, or ended after the snooze. */
export function replyWakeLinks(
  links: ReadonlyArray<ThreadPullRequestLink>,
  snoozedAtMs: number,
): ReadonlyArray<ThreadPullRequestLink> {
  return links.filter((link) => {
    const snapshot = link.snapshot;
    if (snapshot?.viewerDidAuthor !== true) return false;
    if (snapshot.state === "open") return true;
    const endedAt = Date.parse(snapshot.mergedAt ?? snapshot.closedAt ?? "");
    return Number.isNaN(endedAt) || endedAt > snoozedAtMs;
  });
}

/** Why the thread wakes, naming the earliest reply or ending across `reads`; null to stay asleep. */
export function replyWakeReason(
  snoozedAtMs: number,
  reads: ReadonlyArray<ReplyWakeRead>,
): ThreadSnoozeWakeReason | null {
  const wakes = reads.flatMap((read) => {
    const pullRequest = { pullRequestNumber: read.number, pullRequestUrl: read.url };
    const ended: Array<{ readonly at: number; readonly reason: ThreadSnoozeWakeReason }> = [];
    if (read.state !== "open") {
      const at = Date.parse((read.state === "merged" ? read.mergedAt : read.closedAt) ?? "");
      if (Number.isNaN(at) || at > snoozedAtMs) {
        ended.push({
          at: Number.isNaN(at) ? Number.POSITIVE_INFINITY : at,
          reason: {
            kind: read.state,
            ...pullRequest,
            actor: null,
            reviewState: null,
            url: null,
          },
        });
      }
    }
    const replies = (read.remarks ?? []).flatMap((remark) => {
      const at = Date.parse(remark.editedAt ?? remark.createdAt);
      if (!(at > snoozedAtMs) || !isReply(remark, read.viewer)) return [];
      const reason: ThreadSnoozeWakeReason = {
        kind: "reply",
        ...pullRequest,
        actor: remark.author?.login ?? null,
        reviewState:
          remark.kind === "review" ? (REVIEW_STATES[remark.reviewState ?? ""] ?? null) : null,
        url: remark.url,
      };
      return [{ at, reason }];
    });
    return [...ended, ...replies];
  });
  return (
    wakes.reduce<(typeof wakes)[number] | null>(
      (earliest, wake) => (earliest === null || wake.at < earliest.at ? wake : earliest),
      null,
    )?.reason ?? null
  );
}

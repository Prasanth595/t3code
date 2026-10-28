import type { ThreadPullRequestLink } from "@t3tools/contracts";

import { resolveThreadCurrentPullRequestLink } from "./threadPullRequests.ts";

export interface ThreadReferenceCopyTarget {
  readonly kind: "pull-request" | "thread";
  readonly value: string;
  readonly clipboardTarget: string;
  readonly successTitle: string;
  readonly failureTitle: string;
}

export function resolveThreadReferenceCopyTarget(input: {
  readonly threadId: string;
  /** Undefined means no PR panel; null means its URL is not available yet. */
  readonly openPanelPullRequestUrl?: string | null | undefined;
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly linkedPullRequestUrl?: string | null;
}): ThreadReferenceCopyTarget | null {
  if (input.openPanelPullRequestUrl === null) return null;
  const pullRequestUrl =
    input.openPanelPullRequestUrl ??
    resolveThreadCurrentPullRequestLink(input.pullRequests ?? [])?.url ??
    input.linkedPullRequestUrl;
  return pullRequestUrl
    ? {
        kind: "pull-request",
        value: pullRequestUrl,
        clipboardTarget: "pull request link",
        successTitle: "Link-ul PR a fost copiat",
        failureTitle: "Link-ul PR nu a putut fi copiat",
      }
    : {
        kind: "thread",
        value: input.threadId,
        clipboardTarget: "thread ID",
        successTitle: "ID-ul conversației a fost copiat",
        failureTitle: "ID-ul conversației nu a putut fi copiat",
      };
}

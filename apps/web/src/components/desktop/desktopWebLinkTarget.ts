import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { promptLinkAppPath } from "@t3tools/shared/promptLinks";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";

import { findProjectForChangeRequest, parseChangeRequestUrl } from "../../lib/openPullRequestLink";

/** Resolve app destinations before an external link allocates a browser thread. */
export function resolveDesktopWebLinkTarget({
  url,
  projects,
  primaryEnvironmentId,
  capabilities,
  openPullRequestsInApp,
}: {
  url: string;
  projects: ReadonlyArray<EnvironmentProject>;
  primaryEnvironmentId: EnvironmentId | null;
  capabilities: ReadonlyMap<
    EnvironmentId,
    Pick<ServerConfig["environment"]["capabilities"], "pullRequests" | "threadPullRequests">
  >;
  openPullRequestsInApp: boolean;
}) {
  const appPath = promptLinkAppPath(url);
  if (appPath !== null) return { href: appPath };
  if (!openPullRequestsInApp) return null;
  const parsed = parseChangeRequestUrl(url);
  if (parsed === null) return null;
  const project = findProjectForChangeRequest(
    projects
      .filter((candidate) => capabilities.get(candidate.environmentId)?.pullRequests === true)
      .toSorted(
        (left, right) =>
          Number(right.environmentId === primaryEnvironmentId) -
          Number(left.environmentId === primaryEnvironmentId),
      ),
    parsed,
  );
  if (project === undefined) return null;
  return {
    to: "/pull-requests" as const,
    search: {
      involvement: "all" as const,
      state: "all" as const,
      repository:
        capabilities.get(project.environmentId)?.threadPullRequests === true
          ? parsed.repository
          : (sourceControlRepositorySelector(project.repositoryIdentity) ?? parsed.repository),
      number: parsed.number,
      selectedHost: parsed.authority ?? parsed.host,
      selectedProjectId: project.id,
      selectedEnvironmentId: project.environmentId,
    },
  };
}

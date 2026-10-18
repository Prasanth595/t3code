import type { EnvironmentId } from "@t3tools/contracts";
import { githubMediaFetchUrl } from "@t3tools/shared/githubMedia";
import type { FilePreviewItem } from "../../components/FilePreviewModal.types";

export interface PullRequestMediaLocation {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  /** The pull request's `owner/name` when it is on github.com. */
  readonly repository: string | null;
}

export function pullRequestMediaResource(fetchUrl: string, location: PullRequestMediaLocation) {
  return {
    _tag: "github-media" as const,
    cwd: location.cwd,
    url: fetchUrl,
    ...(location.repository === null ? {} : { repository: location.repository }),
  };
}

/** Keep the original resource identity so previewers can resolve and renew its capability. */
export function pullRequestMediaSource(url: string, location: PullRequestMediaLocation | null) {
  const fetchUrl = githubMediaFetchUrl(url);
  return location && fetchUrl
    ? {
        environmentId: location.environmentId,
        resource: pullRequestMediaResource(fetchUrl, location),
      }
    : { uri: url };
}

export function pullRequestImageSource(
  url: string,
  location: PullRequestMediaLocation | null,
): FilePreviewItem {
  return { kind: "image", ...pullRequestMediaSource(url, location) };
}

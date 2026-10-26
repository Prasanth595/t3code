import { markdownImageSourceFragment } from "@t3tools/client-runtime/markdown-images";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { SOURCE_CONTROL_MEDIA_ASSET, type EnvironmentId } from "@t3tools/contracts";
import type { FilePreviewItem } from "../../components/FilePreviewModal.types";

export interface PullRequestMediaLocation {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

/** Keep the original resource identity so previewers can resolve and renew its capability. */
export function pullRequestMediaSource(url: string, location: PullRequestMediaLocation | null) {
  const media = sourceControlClients.mediaUrl(url);
  const fetchUrl = media?.fetchUrl;
  return location && fetchUrl
    ? {
        environmentId: location.environmentId,
        resource: { _tag: SOURCE_CONTROL_MEDIA_ASSET, cwd: location.cwd, url: fetchUrl },
        ...(media?.definition.kind === "bitbucket"
          ? { fallbackUri: url, srcFragment: markdownImageSourceFragment(url) }
          : {}),
      }
    : { uri: url };
}

export function pullRequestImageSource(
  url: string,
  location: PullRequestMediaLocation | null,
): FilePreviewItem {
  return { kind: "image", ...pullRequestMediaSource(url, location) };
}

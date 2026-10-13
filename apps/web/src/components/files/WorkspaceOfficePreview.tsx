import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import { useEffect, useMemo, useState } from "react";
import { useAssetRefresh } from "~/assets/assetUrls";
import { workspaceAssetResource } from "./filePreviewMode";
import { OfficeFilePreview } from "./OfficeFilePreview";
import { FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";

export function useWorkspaceOfficeResource(props: {
  readonly threadRef: ScopedThreadRef;
  readonly draft: boolean;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
}) {
  const { environmentId, threadId } = props.threadRef;
  const { draft, absolutePath, workspaceRoot } = props;
  const inside = mediaFileReference(absolutePath, workspaceRoot).relativePath !== undefined;
  return useMemo(
    () =>
      workspaceAssetResource({
        threadRef: { environmentId, threadId },
        draft,
        absolutePath,
        workspaceRoot,
        kind: inside ? "workspace-file" : "media-file",
      }),
    [inside, environmentId, threadId, draft, absolutePath, workspaceRoot],
  );
}

export function WorkspaceOfficePreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly draft: boolean;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly name: string;
  readonly kind: "docx" | "xlsx";
  readonly workspaceMutationId: string | null;
  readonly refreshRevision: number;
}) {
  const resource = useWorkspaceOfficeResource(props);
  const refresh = useAssetRefresh(props.environmentId, resource);
  const [retryRevision, setRetryRevision] = useState(0);
  const [result, setResult] = useState<{
    url: string;
    version: string | undefined;
    sizeBytes: number | undefined;
    explicitRevision: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const explicitRevision = `${props.refreshRevision}:${retryRevision}`;
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const asset = await refresh();
      if (cancelled) return;
      if (!asset) throw new Error("Reconnect to the environment and try again.");
      setError(null);
      setResult((previous) => {
        if (
          asset.fileVersion !== undefined &&
          previous?.version === asset.fileVersion &&
          previous.explicitRevision === explicitRevision
        )
          return previous;
        return {
          url: `${asset.url}${asset.url.includes("?") ? "&" : "?"}office-version=${encodeURIComponent(asset.fileVersion ?? props.workspaceMutationId ?? "")}&office-revision=${explicitRevision}`,
          version: asset.fileVersion,
          sizeBytes: asset.byteLength,
          explicitRevision,
        };
      });
    };
    // Coalesce tool completions; keep the last successful document visible while checking metadata.
    const timeout = setTimeout(() => {
      void check().catch((cause: unknown) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "Could not load this file.");
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [refresh, props.workspaceMutationId, explicitRevision]);
  const retry = () => setRetryRevision((value) => value + 1);
  if (error) return <FileSurfaceFailure message={error} onRetry={retry} />;
  if (!result) return <FileSurfaceLoading />;
  return (
    <OfficeFilePreview
      key={result.url}
      src={result.url}
      name={props.name}
      kind={props.kind}
      {...(result.sizeBytes === undefined ? {} : { sizeBytes: result.sizeBytes })}
      onRetry={retry}
    />
  );
}

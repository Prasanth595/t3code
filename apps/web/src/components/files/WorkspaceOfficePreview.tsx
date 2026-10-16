import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { OfficePreviewFormat } from "@t3tools/shared/filePreview";
import { lazy, Suspense, useMemo } from "react";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { workspaceAssetResource } from "./filePreviewMode";
import { FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";

const OfficeDocumentPreview = lazy(() => import("./OfficeDocumentPreview"));

/** Binary bytes come from the same authenticated, exact-file capability as other host previews. */
export function WorkspaceOfficePreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly draft: boolean;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly format: OfficePreviewFormat;
  readonly workspaceMutationId: string | null;
  readonly reloadRevision?: number;
}) {
  const resource = useMemo(
    () =>
      workspaceAssetResource({
        kind: "media-file",
        threadRef: props.threadRef,
        draft: props.draft,
        workspaceRoot: props.workspaceRoot,
        absolutePath: props.absolutePath,
      }),
    [props.threadRef, props.draft, props.workspaceRoot, props.absolutePath],
  );
  const asset = useAssetUrlState(props.environmentId, resource);
  const refresh = useAssetUrlRefresh(props.environmentId, resource);
  useWorkspaceMutationRefresh({
    mutationId: props.reloadRevision
      ? `manual:${props.reloadRevision}:${props.workspaceMutationId ?? ""}`
      : props.workspaceMutationId,
    resourceKey: JSON.stringify([props.environmentId, resource]),
    refresh: () => {
      void refresh().catch(() => undefined);
    },
  });
  if (asset._tag === "Failure") {
    return (
      <FileSurfaceFailure
        message="Unable to load this Office document. Open the original in another app."
        onRetry={() => {
          void refresh().catch(() => undefined);
        }}
      />
    );
  }
  if (asset._tag !== "Success") return <FileSurfaceLoading />;
  const revision = `${props.workspaceMutationId ?? ""}:${props.reloadRevision ?? 0}`;
  const suffix =
    props.workspaceMutationId === null && !props.reloadRevision
      ? ""
      : `${asset.url.includes("?") ? "&" : "?"}workspace-revision=${encodeURIComponent(revision)}`;
  return (
    <Suspense fallback={<FileSurfaceLoading />}>
      <OfficeDocumentPreview
        key={asset.url + suffix}
        name={props.absolutePath}
        format={props.format}
        src={asset.url + suffix}
        onRetry={() => {
          void refresh().catch(() => undefined);
        }}
      />
    </Suspense>
  );
}

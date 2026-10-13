import { readOfficePreviewResponse } from "@t3tools/client-runtime/file-preview";
import { FILE_OFFICE_PREVIEW_MAX_BYTES } from "@t3tools/shared/filePreview";
import { lazy, Suspense, useEffect, useState } from "react";

import { FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";
import { validateOfficeArchive, type OfficePreviewKind } from "./officeArchive";

const DocxPreview = lazy(() => import("./DocxPreview"));
const SpreadsheetPreview = lazy(() => import("./SpreadsheetPreview"));

/** The same binary reader handles workspace URLs and local or uploaded attachments. */
export function OfficeFilePreview(props: {
  readonly src: string;
  readonly name: string;
  readonly kind: OfficePreviewKind;
  readonly sizeBytes?: number;
  readonly onRetry?: () => void;
}) {
  const [result, setResult] = useState<{ bytes: Uint8Array | null; error: string | null }>({
    bytes: null,
    error: null,
  });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    // oxlint-disable-next-line react/set-state-in-effect -- Switching files invalidates the last document before loading new bytes.
    setResult({ bytes: null, error: null });
    void (async () => {
      if ((props.sizeBytes ?? 0) > FILE_OFFICE_PREVIEW_MAX_BYTES)
        throw new Error(
          "Office previews support files up to 10 MB. Save this file to open it in another app.",
        );
      const response = await fetch(props.src, {
        signal: controller.signal,
        cache: revision > 0 ? "reload" : "default",
      });
      const bytes = await readOfficePreviewResponse(response, controller.signal);
      validateOfficeArchive(bytes, props.kind);
      if (!controller.signal.aborted) setResult({ bytes, error: null });
    })().catch((cause: unknown) => {
      if (!controller.signal.aborted)
        setResult({
          bytes: null,
          error: cause instanceof Error ? cause.message : "Could not preview this document.",
        });
    });
    return () => controller.abort();
  }, [props.src, props.kind, props.sizeBytes, revision]);
  const retry = () => {
    props.onRetry?.();
    setRevision((value) => value + 1);
  };
  if (result.error !== null) return <FileSurfaceFailure message={result.error} onRetry={retry} />;
  if (result.bytes === null) return <FileSurfaceLoading />;
  return (
    <Suspense fallback={<FileSurfaceLoading />}>
      {props.kind === "docx" ? (
        <DocxPreview
          key={`${props.src}:${revision}`}
          bytes={result.bytes}
          name={props.name}
          onRetry={retry}
        />
      ) : (
        <SpreadsheetPreview
          key={`${props.src}:${revision}`}
          bytes={result.bytes}
          name={props.name}
          onRetry={retry}
        />
      )}
    </Suspense>
  );
}

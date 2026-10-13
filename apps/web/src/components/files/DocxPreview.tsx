import { useEffect, useState } from "react";
import { FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";
import { renderDocxDocument } from "./docxDocument";

export default function DocxPreview(props: {
  readonly bytes: Uint8Array;
  readonly name: string;
  readonly onRetry: () => void;
}) {
  const [result, setResult] = useState<{ html: string | null; error: string | null }>({
    html: null,
    error: null,
  });
  useEffect(() => {
    let cancelled = false;
    void renderDocxDocument(props.bytes)
      .then((html) => {
        if (!cancelled) setResult({ html, error: null });
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setResult({
            html: null,
            error: cause instanceof Error ? cause.message : "Could not render this Word document.",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [props.bytes]);
  if (result.error !== null)
    return <FileSurfaceFailure message={result.error} onRetry={props.onRetry} />;
  if (result.html === null) return <FileSurfaceLoading />;
  return (
    <iframe
      title={props.name}
      srcDoc={result.html}
      sandbox=""
      className="min-h-0 flex-1 border-0 bg-white scheme-light"
    />
  );
}
